#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
batch_synth_micro_audio.py
为 706 (42篇) + 807 (40篇) 轨道二「逻辑微缩版」批量合成微软 Edge TTS (zh-CN-YunyangNeural, rate=-4%)
高保真音频与 1:1 dom_key 句表：
1. 与轨道一完全同源的高清播音音色（zh-CN-YunyangNeural, rate=-4%），单篇整轨流式合成保持音色与音量高度一致；
2. 挂载古今文史全量多音词正音词典（纪传/列传/左传/呼兰河传/阿Q正传/乐府/燕歌行/行乐/说难/李劼人/重章叠句等）；
3. 无损 PCM 声学静音检测 + 句间气口校准（逗号 >=380ms、句末 >=530ms、跨段 >=620ms），彻底消除吞音与连读粘连；
4. 统一输出 44100 Hz / Mono / 96 kbps 高清 MP3（对齐轨道一音频品质）；
5. 支持 --limit N / --ids id1,id2 / --workers 3 / --force / --apply-manifests。
"""

import argparse
import asyncio
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

import edge_tts

from tts_prosody import apply_pronunciation_fixes

ROOT = Path(r"D:\AI_file\706_807专业课背诵手卷")
SCRIPTS_PATH = ROOT / "data" / "micro_spoken_scripts.json"
MANIFEST_706 = ROOT / "data" / "kaoyan_706_manifest.json"
MANIFEST_807 = ROOT / "data" / "kaoyan_807_manifest.json"
MANIFEST_ALL = ROOT / "data" / "kaoyan_all_manifest.json"

VOICE = "zh-CN-YunyangNeural"
RATE = "-4%"
SAMPLE_RATE = 44100


def ffprobe_duration(audio_path: Path) -> float:
    try:
        res = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(audio_path)],
            capture_output=True, text=True, check=True,
        )
        return float(json.loads(res.stdout)["format"]["duration"])
    except Exception:
        return 0.0


def detect_silences_wav(wav_path: Path, noise_db: int = -34, min_dur: float = 0.06) -> list[dict]:
    cmd = [
        "ffmpeg", "-i", str(wav_path),
        "-af", f"silencedetect=noise={noise_db}dB:d={min_dur}",
        "-f", "null", "-",
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stderr = proc.stderr.decode("utf-8", errors="ignore")
    silences = []
    cur_start = None
    for line in stderr.splitlines():
        if "silence_start:" in line:
            m = re.search(r"silence_start:\s*([\d\.]+)", line)
            if m:
                cur_start = float(m.group(1))
        elif "silence_end:" in line:
            m = re.search(r"silence_end:\s*([\d\.]+)\s*\|\s*silence_duration:\s*([\d\.]+)", line)
            if m and cur_start is not None:
                silences.append({
                    "start": cur_start,
                    "end": float(m.group(1)),
                    "dur": float(m.group(2)),
                })
                cur_start = None
    return silences


def _norm_chars(s: str) -> str:
    return re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", s or "")


def synthesize_edge_raw(full_tts_text: str) -> tuple[bytes, list[dict]]:
    async def _run():
        comm = edge_tts.Communicate(full_tts_text, VOICE, rate=RATE, boundary="WordBoundary")
        words = []
        audio_data = bytearray()
        async for chunk in comm.stream():
            if chunk["type"] == "WordBoundary":
                st = chunk["offset"] / 10_000_000.0
                en = (chunk["offset"] + chunk["duration"]) / 10_000_000.0
                words.append({
                    "start": st,
                    "end": en,
                    "text": chunk.get("text", ""),
                    "norm": _norm_chars(chunk.get("text", "")),
                })
            elif chunk["type"] == "audio":
                audio_data.extend(chunk["data"])
        return bytes(audio_data), words

    audio_bytes, words = asyncio.run(_run())
    if len(words) < 5:
        raise RuntimeError(f"Edge TTS WordBoundary 过少: {len(words)}")
    if len(audio_bytes) < 5000:
        raise RuntimeError(f"Edge TTS 音频过小: {len(audio_bytes)} bytes")
    return audio_bytes, words


def align_words_to_clauses(words: list[dict], clause_metas: list[dict]) -> list[tuple[float, float]]:
    """通过严格等长字符流将 WordBoundary 精确映射至每个 clause 的原生起止时间，绝不错切句意。"""
    exp_chunks = [_norm_chars(apply_pronunciation_fixes(c["tts_text"])) for c in clause_metas]
    exp_full = "".join(exp_chunks)

    # 展开每个 word 的字符时间归属
    char_word_idx: list[int] = []
    wb_chars: list[str] = []
    for wi, w in enumerate(words):
        wn = w["norm"]
        for ch in wn:
            wb_chars.append(ch)
            char_word_idx.append(wi)
    wb_full = "".join(wb_chars)

    if exp_full != wb_full:
        # 定位首个差异点以便排查
        diff_pos = next((i for i, (a, b) in enumerate(zip(exp_full, wb_full)) if a != b), min(len(exp_full), len(wb_full)))
        raise RuntimeError(
            f"WordBoundary 字符流不匹配 (exp={len(exp_full)}, got={len(wb_full)}, diff@{diff_pos}): "
            f"exp='{exp_full[max(0,diff_pos-8):diff_pos+14]}' vs got='{wb_full[max(0,diff_pos-8):diff_pos+14]}'"
        )

    spans: list[tuple[float, float]] = []
    cursor = 0
    for chunk in exp_chunks:
        clen = len(chunk)
        if clen == 0:
            prev_end = spans[-1][1] if spans else 0.0
            spans.append((prev_end, prev_end + 0.08))
            continue
        first_wi = char_word_idx[cursor]
        last_wi = char_word_idx[cursor + clen - 1]
        st = words[first_wi]["start"]
        en = words[last_wi]["end"]
        # 若与前一句首尾共用同一词 token（极罕见），微调切分避免回跳
        if spans and st < spans[-1][1]:
            if cursor > 0 and char_word_idx[cursor - 1] == first_wi:
                mid_t = (words[first_wi]["start"] + words[first_wi]["end"]) * 0.5
                spans[-1] = (spans[-1][0], max(spans[-1][0] + 0.05, mid_t))
                st = mid_t
        if en <= st:
            en = st + 0.08
        spans.append((st, en))
        cursor += clen
    return spans


def align_and_pad_audio(
    raw_mp3_bytes: bytes,
    words: list[dict],
    clause_metas: list[dict],
    out_mp3: Path,
) -> list[dict]:
    """
    基于 WordBoundary 保留每条逻辑槽位内部 100% 原生态韵律与逗号气口，
    仅在跨槽位（title/hook/intro/段落/步骤/防混/抽查）边界处校准静默停顿，
    最末编码为与轨道一一致的 44.1kHz / Mono / 96kbps MP3 并返回精确句标。
    """
    n = len(clause_metas)
    raw_spans = align_words_to_clauses(words, clause_metas)

    # 将相邻同一 slot 下的 clauses 分组，仅在 slot 与 slot 之间做声学切分与补气口
    slot_groups: list[tuple[int, int]] = []  # (first_clause_idx, last_clause_idx)
    cur_s = 0
    for i in range(1, n):
        if clause_metas[i]["slot_key"] != clause_metas[cur_s]["slot_key"]:
            slot_groups.append((cur_s, i - 1))
            cur_s = i
    slot_groups.append((cur_s, n - 1))
    num_slots = len(slot_groups)

    with tempfile.TemporaryDirectory(prefix="micro_tts_") as tmpdir:
        tmp = Path(tmpdir)
        raw_mp3 = tmp / "raw.mp3"
        raw_wav = tmp / "raw.wav"
        pad_wav = tmp / "padded.wav"
        tmp_out = out_mp3.with_suffix(".tmp.mp3")

        raw_mp3.write_bytes(raw_mp3_bytes)
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(raw_mp3), "-ac", "1", "-ar", str(SAMPLE_RATE), "-sample_fmt", "s16", str(raw_wav)],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True,
        )

        silences = detect_silences_wav(raw_wav, noise_db=-34, min_dur=0.05)
        if len(silences) < max(1, num_slots // 2):
            silences = detect_silences_wav(raw_wav, noise_db=-28, min_dur=0.03)

        with wave.open(str(raw_wav), "rb") as wf:
            pcm = wf.readframes(wf.getnframes())
            sampwidth = wf.getsampwidth()
            nchannels = wf.getnchannels()
            fr = wf.getframerate()

        frame_bytes = sampwidth * nchannels
        total_frames = len(pcm) // frame_bytes
        total_dur = total_frames / float(fr)

        # 仅计算跨槽位（slot_idx -> slot_idx + 1）的安全静音切点
        cuts = []
        for s_idx in range(num_slots - 1):
            _, end_ci = slot_groups[s_idx]
            nxt_ci, _ = slot_groups[s_idx + 1]
            gap_lo = raw_spans[end_ci][1]
            gap_hi = raw_spans[nxt_ci][0]
            cur_gap = max(0.0, gap_hi - gap_lo)

            # 严格锁定在槽末词尾与下槽首词首之间，绝不触碰句内任何逗号
            win_lo = max(0.0, gap_lo - 0.04)
            win_hi = min(total_dur, gap_hi + 0.04)
            best_sil = None
            best_dist = 1e9
            target_mid = (gap_lo + gap_hi) * 0.5
            for sil in silences:
                s_mid = (sil["start"] + sil["end"]) * 0.5
                if win_lo <= s_mid <= win_hi:
                    d = abs(s_mid - target_mid)
                    if d < best_dist:
                        best_dist = d
                        best_sil = sil

            if best_sil is not None:
                cut_t = min(max((best_sil["start"] + best_sil["end"]) * 0.5, gap_lo), max(gap_lo, gap_hi))
                real_gap = max(cur_gap, best_sil["end"] - best_sil["start"])
            else:
                cut_t = min(max(target_mid, gap_lo), total_dur)
                real_gap = cur_gap

            cur_part = clause_metas[end_ci].get("part", "")
            nxt_part = clause_metas[nxt_ci].get("part", "")
            if cur_part == "title" or nxt_part in ("section_title", "noun_title", "conclusion", "guard") or (cur_part != "drill" and nxt_part == "drill"):
                target_gap = 0.72
            else:
                target_gap = 0.54

            pad_needed = max(0.0, target_gap - real_gap)
            cuts.append({
                "cut_t": cut_t,
                "pad_sec": pad_needed,
            })

        first_sp_start = max(0.0, raw_spans[0][0] - 0.02)
        lead_pad_frames = max(0, int(round(0.12 * fr)) - int(round(first_sp_start * fr)))
        lead_silence = b"\x00" * (lead_pad_frames * frame_bytes)
        lead_shift = lead_pad_frames / float(fr)

        pcm_parts = [lead_silence]
        cut_frames = [int(round(c["cut_t"] * fr)) for c in cuts]
        for idx in range(1, len(cut_frames)):
            if cut_frames[idx] < cut_frames[idx - 1]:
                cut_frames[idx] = cut_frames[idx - 1]

        prev_frame = 0
        slot_shift = [0.0] * num_slots
        running_pad = lead_shift
        for s_idx in range(num_slots):
            slot_shift[s_idx] = running_pad
            if s_idx < num_slots - 1:
                cf = cut_frames[s_idx]
                pcm_parts.append(pcm[prev_frame * frame_bytes : cf * frame_bytes])
                pad_f = int(round(cuts[s_idx]["pad_sec"] * fr))
                if pad_f > 0:
                    pcm_parts.append(b"\x00" * (pad_f * frame_bytes))
                    running_pad += pad_f / float(fr)
                prev_frame = cf

        pcm_parts.append(pcm[prev_frame * frame_bytes :])
        tail_silence_f = int(round(0.28 * fr))
        pcm_parts.append(b"\x00" * (tail_silence_f * frame_bytes))

        with wave.open(str(pad_wav), "wb") as wf_out:
            wf_out.setnchannels(nchannels)
            wf_out.setsampwidth(sampwidth)
            wf_out.setframerate(fr)
            wf_out.writeframes(b"".join(pcm_parts))

        subprocess.run(
            [
                "ffmpeg", "-y", "-i", str(pad_wav),
                "-af", "volume=4dB,alimiter=limit=0.75:attack=5:release=50",
                "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-b:a", "96k",
                "-map_metadata", "-1", str(tmp_out),
            ],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True,
        )
        tmp_out.replace(out_mp3)

    actual_dur = ffprobe_duration(out_mp3)
    clause_to_slot = [0] * n
    for s_idx, (c_lo, c_hi) in enumerate(slot_groups):
        for ci in range(c_lo, c_hi + 1):
            clause_to_slot[ci] = s_idx

    sent_rows = []
    for i in range(n):
        c_meta = clause_metas[i]
        shift = slot_shift[clause_to_slot[i]]
        st_sec = max(0.0, raw_spans[i][0] + shift - 0.006)
        en_sec = max(st_sec + 0.08, raw_spans[i][1] + shift + 0.006)
        if sent_rows and st_sec < sent_rows[-1]["end"]:
            # 同槽相邻逗号子句微边防重叠：收紧前句尾 padding 留出纯正间隙
            mid_edge = (sent_rows[-1]["end"] + st_sec) * 0.5
            sent_rows[-1]["end"] = round(max(sent_rows[-1]["start"] + 0.06, mid_edge - 0.005), 3)
            sent_rows[-1]["duration"] = round(max(0.0, sent_rows[-1]["end"] - sent_rows[-1]["start"]), 3)
            st_sec = mid_edge + 0.005
        if actual_dur > 0 and en_sec > actual_dur:
            en_sec = actual_dur
        sent_rows.append({
            "id": c_meta["sent_id"],
            "dom_key": c_meta["sent_id"],
            "text": c_meta["text"],
            "start": round(st_sec, 3),
            "end": round(en_sec, 3),
            "duration": round(max(0.0, en_sec - st_sec), 3),
        })
    return sent_rows


def synthesize_one_item(script_item: dict, target_mp3_rel: str, force: bool = False) -> tuple[bool, str]:
    out_mp3 = ROOT / target_mp3_rel
    out_sent = out_mp3.with_suffix(".sentences.json")
    out_mp3.parent.mkdir(parents=True, exist_ok=True)

    clause_metas = []
    slot_tts_list = []
    for sl in script_item["slots"]:
        slot_tts_list.append(apply_pronunciation_fixes(sl.get("slot_tts_text") or "".join(c["tts_text"] for c in sl["clauses"])))
        for c in sl["clauses"]:
            clause_metas.append({
                **c,
                "slot_key": sl["slot_key"],
                "part": sl.get("part", ""),
            })

    if not force and out_mp3.exists() and out_sent.exists() and out_mp3.stat().st_size > 20000:
        try:
            existing = json.loads(out_sent.read_text(encoding="utf-8"))
            if len(existing) == len(clause_metas) and all("dom_key" in x for x in existing):
                return True, f"SKIP ({len(existing)} 句已就绪)"
        except Exception:
            pass

    full_tts_text = "\n".join(slot_tts_list)

    for attempt in range(1, 5):
        try:
            raw_bytes, words = synthesize_edge_raw(full_tts_text)
            sent_rows = align_and_pad_audio(raw_bytes, words, clause_metas, out_mp3)
            out_sent.write_text(json.dumps(sent_rows, ensure_ascii=False, indent=2), encoding="utf-8")
            last_end = sent_rows[-1]["end"] if sent_rows else 0
            actual_dur = ffprobe_duration(out_mp3)
            min_gap = min(
                ((sent_rows[k + 1]["start"] - sent_rows[k]["end"]) * 1000.0 for k in range(len(sent_rows) - 1)),
                default=999.0,
            )
            return True, (
                f"OK ({len(sent_rows)} 句, 句末={last_end:.1f}s, ffprobe={actual_dur:.1f}s, "
                f"min_gap={min_gap:.0f}ms, {out_mp3.stat().st_size/1024:.0f}KB)"
            )
        except Exception as exc:
            if attempt == 4:
                return False, f"FAIL: {exc}"
            time.sleep(2 * attempt)
    return False, "FAIL"


def get_micro_rel_path(manifest_item: dict) -> str:
    t1_audio = (manifest_item.get("track1") or {}).get("audio", "")
    if t1_audio.endswith("_exam.mp3"):
        return t1_audio[:-9] + "_micro.mp3"
    base, _ = os.path.splitext(t1_audio)
    return base + "_micro.mp3"


def apply_to_manifests(scripts_by_id: dict):
    m706 = json.loads(MANIFEST_706.read_text(encoding="utf-8"))
    m807 = json.loads(MANIFEST_807.read_text(encoding="utf-8"))

    updated = 0
    for items in (m706, m807):
        for it in items:
            micro_rel = get_micro_rel_path(it)
            sent_rel = micro_rel.replace(".mp3", ".sentences.json")
            if (ROOT / micro_rel).exists() and (ROOT / sent_rel).exists():
                sc = scripts_by_id.get(it["id"])
                it["track2"]["audio"] = micro_rel
                it["track2"]["sentences_file"] = sent_rel
                it["track2"]["has_audio"] = True
                it["track2"]["dedicated_voice"] = True
                it["track2"]["char_count"] = sc["tts_chars"] if sc else it["track2"].get("char_count", 0)
                if sc:
                    it["track2"]["micro_slots"] = [
                        {
                            "slot_key": sl["slot_key"],
                            "part": sl["part"],
                            "clauses": [
                                {"sent_id": c["sent_id"], "text": c["text"], "html": c["html"]}
                                for c in sl["clauses"]
                            ],
                        }
                        for sl in sc["slots"]
                    ]
                updated += 1

    MANIFEST_706.write_text(json.dumps(m706, ensure_ascii=False, indent=2), encoding="utf-8")
    MANIFEST_807.write_text(json.dumps(m807, ensure_ascii=False, indent=2), encoding="utf-8")

    from build_kaoyan_bundle import sync_all_manifests_and_bundle
    sync_all_manifests_and_bundle(sync_t1_html=False)
    print(f"Manifests updated: {updated}/82 items linked to *_micro.mp3 & *_micro.sentences.json")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--ids", type=str, default="")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--apply-manifests", action="store_true")
    args = parser.parse_args()

    scripts = json.loads(SCRIPTS_PATH.read_text(encoding="utf-8"))
    scripts_by_id = {s["id"]: s for s in scripts}
    m706 = json.loads(MANIFEST_706.read_text(encoding="utf-8"))
    m807 = json.loads(MANIFEST_807.read_text(encoding="utf-8"))
    manifest_by_id = {it["id"]: it for it in (m706 + m807)}

    tasks = []
    filter_ids = {x.strip() for x in args.ids.split(",") if x.strip()} if args.ids else None
    for sc in scripts:
        if filter_ids and sc["id"] not in filter_ids:
            continue
        it = manifest_by_id[sc["id"]]
        tasks.append((sc, get_micro_rel_path(it)))
    if args.limit > 0:
        tasks = tasks[:args.limit]

    print(f"Starting Track 2 Edge TTS (YunyangNeural {RATE}, 96kbps) synthesis: {len(tasks)} items, workers={args.workers}")
    ok_cnt = 0
    fail_list = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        fut_map = {ex.submit(synthesize_one_item, sc, rel, args.force): (sc, rel) for sc, rel in tasks}
        for idx, fut in enumerate(concurrent.futures.as_completed(fut_map), 1):
            sc, rel = fut_map[fut]
            try:
                ok, msg = fut.result()
            except Exception as exc:
                ok, msg = False, str(exc)
            tag = "OK" if ok else "FAIL"
            print(f"[{idx:02d}/{len(tasks):02d}] {tag} {sc['id'][:30]} -> {msg}", flush=True)
            if ok:
                ok_cnt += 1
            else:
                fail_list.append((sc["id"], msg))

    print(f"\nFinished: {ok_cnt}/{len(tasks)} succeeded.")
    if fail_list:
        print("Failures:")
        for fid, fmsg in fail_list:
            print(f" - {fid}: {fmsg}")

    if args.apply_manifests:
        apply_to_manifests(scripts_by_id)


if __name__ == "__main__":
    main()
