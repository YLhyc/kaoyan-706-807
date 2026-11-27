#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
resynth_track1_clean.py
使用轨道一原版阿里云 CosyVoice v3 高清音色 (model="cosyvoice-v3-flash", voice="longanlang_v3" 龙安朗)，
仅对存在“逗号被强断句号/807序号点号停顿/无标点长句乱换气/句间间隙过窄”的轨道一篇目执行局部断句重修：
1. 严格保留轨道一阿里云龙安朗原版音色与音量基准（~ -23dB）；
2. 彻底废除旧版“每 30 字强制将逗号/分号改为句号”的切法，按真实句末/冒号流式送入完整句子；
3. 挂载 706 + 807 全量文史专有名词 HotFix 拼音词典，并修正“1. / 2.”为“1、/ 2、”；
4. 基于 CosyVoice sentence-end 词级时间戳（含标点 token 坐标）在句间注入无损静默气口（逗号 >=375ms、句末/分号 >=525ms、标题/段首 >=620ms），输出 44.1kHz/Mono/96kbps MP3 并回写 manifest 与离线包。
"""

import argparse
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

import dashscope
from dashscope.audio.tts_v2 import AudioFormat, ResultCallback, SpeechSynthesizer
from dashscope.audio.tts_v2.speech_synthesizer import HotFix

ROOT = Path(r"D:\AI_file\706_807专业课背诵手卷")
sys.path.insert(0, str(ROOT / "tools"))

from tts_prosody import insert_prosody_commas_for_tts  # noqa: E402
from batch_synth_micro_audio import SAMPLE_RATE, detect_silences_wav, ffprobe_duration  # noqa: E402

MANIFEST_706 = ROOT / "data" / "kaoyan_706_manifest.json"
MANIFEST_807 = ROOT / "data" / "kaoyan_807_manifest.json"
MANIFEST_ALL = ROOT / "data" / "kaoyan_all_manifest.json"

HOT_FIX = HotFix(pronunciation=[
    {"纪传体": "ji4 zhuan4 ti3"},
    {"列传": "lie4 zhuan4"},
    {"经传": "jing1 zhuan4"},
    {"左传": "zuo3 zhuan4"},
    {"外传": "wai4 zhuan4"},
    {"传记": "zhuan4 ji4"},
    {"别传": "bie2 zhuan4"},
    {"内传": "nei4 zhuan4"},
    {"正传": "zheng4 zhuan4"},
    {"小传": "xiao3 zhuan4"},
    {"自叙传": "zi4 xu4 zhuan4"},
    {"公羊传": "gong1 yang2 zhuan4"},
    {"谷梁传": "gu3 liang2 zhuan4"},
    {"世家列传": "shi4 jia1 lie4 zhuan4"},
    {"呼兰河传": "hu1 lan2 he2 zhuan4"},
    {"阿Q正传": "a1 Q zheng4 zhuan4"},
    {"水浒传": "shui3 hu3 zhuan4"},
    {"莺莺传": "ying1 ying1 zhuan4"},
    {"长恨歌传": "chang2 hen4 ge1 zhuan4"},
    {"太史公自序": "tai4 shi3 gong1 zi4 xu4"},
    {"乐府": "yue4 fu3"},
    {"汉乐府": "han4 yue4 fu3"},
    {"新乐府": "xin1 yue4 fu3"},
    {"古乐府": "gu3 yue4 fu3"},
    {"乐府诗": "yue4 fu3 shi1"},
    {"乐府双璧": "yue4 fu3 shuang1 bi4"},
    {"礼乐": "li3 yue4"},
    {"雅乐": "ya3 yue4"},
    {"燕歌行": "yan1 ge1 xing2"},
    {"便娟": "pian2 juan1"},
    {"便娟婉约": "pian2 juan1 wan3 yue1"},
    {"单于": "chan2 yu2"},
    {"长歌当哭": "chang2 ge1 dang4 ku1"},
    {"长恨歌": "chang2 hen4 ge1"},
    {"重章叠句": "chong2 zhang1 die2 ju4"},
    {"温庭筠": "wen1 ting2 yun2"},
    {"谢朓": "xie4 tiao3"},
    {"鲍照": "bao4 zhao4"},
    {"庾信": "yu3 xin4"},
    {"行卷": "xing2 juan4"},
    {"行乐": "xing2 le4"},
    {"自度曲": "zi4 duo4 qu3"},
    {"骚体": "sao1 ti3"},
    {"楚辞": "chu3 ci2"},
    {"离骚": "li2 sao1"},
    {"赋比兴": "fu4 bi3 xing4"},
    {"兴寄": "xing4 ji4"},
    {"寄兴": "ji4 xing4"},
    {"兴象": "xing4 xiang4"},
    {"起兴": "qi3 xing4"},
    {"拗救": "ao4 jiu4"},
    {"拗体": "ao4 ti3"},
    {"押韵": "ya1 yun4"},
    {"押官韵": "ya1 guan1 yun4"},
    {"平仄": "ping2 ze4"},
    {"关陇": "guan1 long3"},
    {"掉书袋": "diao4 shu1 dai4"},
    {"数见不鲜": "shuo4 jian4 bu4 xian1"},
    {"辟易": "bi4 yi4"},
    {"跌宕": "die2 dang4"},
    {"俶傥": "ti4 tang3"},
    {"沉郁顿挫": "chen2 yu4 dun4 cuo4"},
    {"黍离之悲": "shu3 li2 zhi1 bei1"},
    {"伛偻": "yu3 lv3"},
    {"李劼人": "li3 jie2 ren2"},
    {"贾平凹": "jia3 ping2 wa1"},
    {"邓幺姑": "deng4 yao1 gu1"},
    {"谌容": "shen4 rong2"},
    {"唐湜": "tang2 shi2"},
    {"阿垅": "a1 long3"},
    {"说难": "shui4 nan2"},
    {"游说": "you2 shui4"},
])


class CosyCollector(ResultCallback):
    def __init__(self):
        self.audio = bytearray()
        self.sents = []
        self.err = None
        self.done = threading.Event()

    def on_data(self, data: bytes):
        self.audio.extend(data)

    def on_complete(self):
        self.done.set()

    def on_error(self, message):
        self.err = str(message)
        self.done.set()

    def on_event(self, message):
        try:
            msg = json.loads(message)
            out = msg.get("payload", {}).get("output", {})
            if out.get("type") == "sentence-end":
                self.sents.append(out.get("sentence", {}))
        except Exception:
            pass


def normalize_t1_clause_for_cosy(raw_text: str, is_slot_end: bool, is_title_or_heading: bool) -> str:
    t = (raw_text or "").strip()
    if not t:
        return "。" if is_slot_end else ""

    t = re.sub(r"^([1-9]\d?)\.\s*", r"\1、", t)
    t = re.sub(r"(?<![0-9.])([1-9]\d?)\.(?![0-9])", r"\1、", t)
    t = re.sub(r"(\d{2})\s*[–\-—]\s*(\d{2})s\b", r"\1至\2年代", t)
    t = re.sub(r"\b(\d{2})s\b", r"\1年代", t)
    t = re.sub(r"》\s*《", "》、《", t)
    t = re.sub(r"——+", "，", t)
    t = t.replace("—", "，").replace("……", "，").replace("…", "，")
    t = re.sub(r"\bO\.K\.?", "OK", t)
    t = re.sub(r"[【】〔〕〈〉\[\]]", "", t)
    t = re.sub(r"[，,]{2,}", "，", t).strip()
    t = insert_prosody_commas_for_tts(t)

    if is_slot_end or is_title_or_heading:
        if t.endswith(("。", "！", "？", "。”", "！”", "？”", "。）", "：", ":")):
            return t
        if t[-1] in ("，", ",", "；", ";", "、"):
            t = t[:-1].rstrip("，,；;、 ")
        return f"{t}。" if t else "。"

    if t[-1] in ("，", "、", "；", "：", "”", "’", "）", "》"):
        return t
    return f"{t}，"


def build_track1_slots(rows: list[dict]) -> tuple[list[dict], list[list[int]]]:
    """划分为自然句子槽位，返回 clause_metas 与每个槽位包含的 clause 下标列表。"""
    n = len(rows)
    clause_metas: list[dict] = []
    slot_clause_groups: list[list[int]] = []
    cur_group: list[int] = []

    for i, r in enumerate(rows):
        raw = (r.get("text") or "").strip()
        is_last = (i == n - 1)
        is_title = (i == 0)
        is_heading = bool(re.match(r"^(第[一二三四五六七八九十]+[，,、]|[一二三四五六七八九十]+[、.．]|[1-9]\d?[.、])", raw))
        ends_hard = raw.endswith(("。", "！", "？", "。”", "！”", "？”", "。）", "：", ":"))
        has_open_q = (raw.count("“") > raw.count("”"))
        is_slot_end = is_last or is_title or (ends_hard and not has_open_q)

        tts_txt = normalize_t1_clause_for_cosy(raw, is_slot_end=is_slot_end, is_title_or_heading=is_title or is_heading)
        part = "title" if is_title else ("heading" if is_heading else "body")

        clause_metas.append({
            "id": r.get("id", f"sent_{i+1}"),
            "text": raw,
            "tts_text": tts_txt,
            "part": part,
        })
        cur_group.append(i)
        if is_slot_end:
            slot_clause_groups.append(cur_group)
            cur_group = []

    if cur_group:
        slot_clause_groups.append(cur_group)

    return clause_metas, slot_clause_groups


def _merge_batch_sents_to_slots(sents: list[dict], batch_slots: list[str]) -> list[dict]:
    """将批次内可能因分号/超长句子被 CosyVoice 内部多拆出的 sentence-end 事件无缝并回对应 slot。"""
    k, m = len(sents), len(batch_slots)
    if k == m:
        return sents
    if k < m or m == 0:
        merged_words = []
        for se in sents:
            merged_words.extend(se.get("words") or [])
        if m == 0:
            return []
        weights = [max(1, len(re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", s))) for s in batch_slots]
        tw = sum(weights)
        nw = len(merged_words)
        out_bins: list[dict] = []
        pos = 0
        acc = 0
        for idx, wgt in enumerate(weights):
            acc += wgt
            nxt = nw if idx == m - 1 else min(nw, max(pos + (1 if pos < nw else 0), int(round(nw * (acc / tw)))))
            out_bins.append({"words": merged_words[pos:nxt]})
            pos = nxt
        return out_bins

    se_chars = []
    se_endp = []
    for se in sents:
        wtxt = "".join(w.get("text", "") for w in (se.get("words") or []))
        se_chars.append(max(1, len(re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", wtxt))))
        m_p = re.search(r"([。？！；：，、])[^0-9A-Za-z\u4e00-\u9fff]*$", wtxt)
        se_endp.append(m_p.group(1) if m_p else "")

    slot_chars = []
    slot_endp = []
    for st in batch_slots:
        slot_chars.append(max(1, len(re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", st))))
        m_p = re.search(r"([。？！；：，、])[^0-9A-Za-z\u4e00-\u9fff]*$", st)
        slot_endp.append(m_p.group(1) if m_p else "")

    pref = [0]
    for c in se_chars:
        pref.append(pref[-1] + c)

    INF = 1e18
    dp = [[INF] * (k + 1) for _ in range(m + 1)]
    back = [[-1] * (k + 1) for _ in range(m + 1)]
    dp[0][0] = 0.0

    for i in range(1, m + 1):
        sc = slot_chars[i - 1]
        sp = slot_endp[i - 1]
        for j in range(i, k - (m - i) + 1):
            ep = se_endp[j - 1]
            punc_pen = 0.0 if (not sp or ep == sp) else 8.0
            for prev_j in range(i - 1, j):
                if dp[i - 1][prev_j] >= INF:
                    continue
                grp_c = pref[j] - pref[prev_j]
                cost = dp[i - 1][prev_j] + abs(grp_c - sc) + punc_pen + (j - prev_j - 1) * 1.5
                if cost < dp[i][j]:
                    dp[i][j] = cost
                    back[i][j] = prev_j

    bounds = [0] * (m + 1)
    bounds[m] = k
    cur_j = k
    for i in range(m, 0, -1):
        cur_j = back[i][cur_j]
        bounds[i - 1] = cur_j

    merged: list[dict] = []
    for i in range(m):
        words = []
        for idx in range(bounds[i], bounds[i + 1]):
            words.extend(sents[idx].get("words") or [])
        merged.append({"words": words})
    return merged


def _synth_cosy_batch(batch_slots: list[str]) -> tuple[bytes, list[dict]]:
    cb = CosyCollector()
    syn = SpeechSynthesizer(
        model="cosyvoice-v3-flash",
        voice="longanlang_v3",
        format=AudioFormat.MP3_48000HZ_MONO_256KBPS,
        callback=cb,
        hot_fix=HOT_FIX,
        additional_params={"word_timestamp_enabled": True},
    )
    for st in batch_slots:
        syn.streaming_call(st)
    syn.streaming_complete()
    if not cb.done.wait(timeout=120):
        raise RuntimeError("CosyVoice 批次合成超时")
    if cb.err:
        raise RuntimeError(f"CosyVoice 错误: {cb.err}")
    if len(cb.audio) < 2000:
        raise RuntimeError(f"CosyVoice 音频过小: {len(cb.audio)}")
    if not cb.sents:
        raise RuntimeError("CosyVoice 未返回任何 sentence-end")
    aligned_sents = _merge_batch_sents_to_slots(cb.sents, batch_slots)
    return bytes(cb.audio), aligned_sents


def synthesize_cosy_longanlang(slot_texts: list[str]) -> tuple[bytes, list[dict]]:
    """分批流式合成 CosyVoice 龙安朗并拼合无损 PCM（避免超长文本单次 WebSocket 超时/卡死），返回 (44.1kHz s16 mono PCM bytes, 偏移对齐后的 sentence-end 列表)。"""
    if not os.environ.get("DASHSCOPE_API_KEY"):
        raise RuntimeError("DASHSCOPE_API_KEY 未设置")
    dashscope.api_key = os.environ["DASHSCOPE_API_KEY"]

    batches: list[list[str]] = []
    cur: list[str] = []
    cur_chars = 0
    for st in slot_texts:
        if cur and (cur_chars + len(st) > 650 or len(cur) >= 15):
            batches.append(cur)
            cur = []
            cur_chars = 0
        cur.append(st)
        cur_chars += len(st)
    if cur:
        batches.append(cur)

    all_pcm_parts: list[bytes] = []
    all_sents: list[dict] = []
    cum_ms = 0.0
    frame_bytes = 2  # s16 mono

    with tempfile.TemporaryDirectory(prefix="t1_cosy_b_") as tmpdir:
        tmp = Path(tmpdir)
        for bi, b_slots in enumerate(batches):
            b_mp3_bytes, b_sents = _synth_cosy_batch(b_slots)
            b_mp3 = tmp / f"b_{bi}.mp3"
            b_wav = tmp / f"b_{bi}.wav"
            b_mp3.write_bytes(b_mp3_bytes)
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(b_mp3), "-ac", "1", "-ar", str(SAMPLE_RATE), "-sample_fmt", "s16", str(b_wav)],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True,
            )
            with wave.open(str(b_wav), "rb") as wf:
                b_pcm = wf.readframes(wf.getnframes())
            b_dur_ms = (len(b_pcm) // frame_bytes) / float(SAMPLE_RATE) * 1000.0

            for se in b_sents:
                se_copy = dict(se)
                new_words = []
                for w in (se.get("words") or []):
                    wc = dict(w)
                    if wc.get("begin_time") is not None:
                        wc["begin_time"] = wc["begin_time"] + cum_ms
                    if wc.get("end_time") is not None:
                        wc["end_time"] = wc["end_time"] + cum_ms
                    new_words.append(wc)
                se_copy["words"] = new_words
                all_sents.append(se_copy)

            all_pcm_parts.append(b_pcm)
            cum_ms += b_dur_ms

    return b"".join(all_pcm_parts), all_sents


def _spoken_char_count(s: str) -> int:
    return len(re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", s or ""))


def map_slot_words_to_clauses(sent_events: list[dict], clause_metas: list[dict], slot_groups: list[list[int]]) -> list[tuple[float, float]]:
    """
    将每个 CosyVoice sentence-end 下的 words 坐标精准映射到所属槽内的每个 UI clause。
    对单 clause 槽直接使用整句实词起止毫秒；对多 clause 槽（句内逗号/分号折分）结合实词停顿间隙与标点索引定位断点。
    """
    spans: list[tuple[float, float]] = [None] * len(clause_metas)

    for se, c_idxs in zip(sent_events, slot_groups):
        words = [w for w in (se.get("words") or []) if w.get("begin_time") is not None and w.get("end_time") is not None]
        if not words:
            raise RuntimeError("CosyVoice sentence-end 缺失 words 时间戳")

        # 过滤出有效发音词（非纯末尾句号）以定首尾坐标
        spoken_indices = [wi for wi, w in enumerate(words) if _spoken_char_count(w.get("text", "")) > 0]
        if not spoken_indices:
            spoken_indices = list(range(len(words)))

        s_first = spoken_indices[0]
        s_last = spoken_indices[-1]
        sent_start = words[s_first]["begin_time"] / 1000.0
        sent_end = words[s_last]["end_time"] / 1000.0

        if len(c_idxs) == 1:
            spans[c_idxs[0]] = (sent_start, max(sent_start + 0.08, sent_end))
            continue

        # 多子句句内定位：按每个 clause 的预估口语字符比例 + 就近找 words 中的真停顿/标点间隙
        weights = [max(1, _spoken_char_count(clause_metas[ci]["tts_text"])) for ci in c_idxs]
        total_w = sum(weights)

        # 计算 words 中所有词间停顿（gap >= 40ms 或标点 token）作为候选切点
        word_breaks = []  # (cum_word_frac, end_of_left_sec, start_of_right_sec, score)
        total_spoken_words = len(spoken_indices)
        for rank in range(total_spoken_words - 1):
            wi = spoken_indices[rank]
            wnxt = spoken_indices[rank + 1]
            left_end = words[wi]["end_time"] / 1000.0
            right_start = words[wnxt]["begin_time"] / 1000.0
            gap = right_start - left_end
            has_punc_between = any(
                any(p in words[k].get("text", "") for p in ("，", "；", "：", "、", ","))
                for k in range(wi + 1, wnxt)
            ) or any(p in words[wi].get("text", "") for p in ("，", "；", "：", "、"))
            if has_punc_between or gap >= 0.035:
                bonus = 1.0 if has_punc_between else 0.0
                word_breaks.append(((rank + 1) / total_spoken_words, left_end, right_start, bonus + min(0.8, max(0.0, gap))))

        prev_start = sent_start
        prev_rank_frac = 0.0
        acc_w = 0
        for k, ci in enumerate(c_idxs):
            if k == len(c_idxs) - 1:
                spans[ci] = (prev_start, max(prev_start + 0.08, sent_end))
                break
            acc_w += weights[k]
            target_frac = acc_w / total_w
            # 在目标比例 ±0.16 窗口内挑最佳停顿/标点断点
            best = None
            best_score = -1e9
            for frac, l_end, r_start, bscore in word_breaks:
                if frac <= prev_rank_frac + 0.03 or frac >= 0.96:
                    continue
                dist = abs(frac - target_frac)
                if dist <= 0.18:
                    sc = bscore - dist * 3.0
                    if sc > best_score:
                        best_score = sc
                        best = (frac, l_end, r_start)
            if best is not None:
                prev_rank_frac, c_end, nxt_start = best
            else:
                # 兜底按 word_frac 找最近词边界
                approx_rank = min(total_spoken_words - 2, max(0, int(round(target_frac * total_spoken_words)) - 1))
                wi = spoken_indices[approx_rank]
                wnxt = spoken_indices[approx_rank + 1]
                c_end = words[wi]["end_time"] / 1000.0
                nxt_start = words[wnxt]["begin_time"] / 1000.0
                prev_rank_frac = (approx_rank + 1) / total_spoken_words

            c_end = max(prev_start + 0.08, c_end)
            spans[ci] = (prev_start, c_end)
            prev_start = max(c_end + 0.01, nxt_start)

    return spans


def align_and_pad_cosy_track1(
    raw_pcm_bytes: bytes,
    sent_events: list[dict],
    clause_metas: list[dict],
    slot_groups: list[list[int]],
    out_mp3: Path,
) -> list[dict]:
    n = len(clause_metas)
    raw_spans = map_slot_words_to_clauses(sent_events, clause_metas, slot_groups)

    with tempfile.TemporaryDirectory(prefix="t1_cosy_") as tmpdir:
        tmp = Path(tmpdir)
        raw_wav = tmp / "raw.wav"
        pad_wav = tmp / "padded.wav"
        tmp_out = out_mp3.with_suffix(".tmp.mp3")

        with wave.open(str(raw_wav), "wb") as wf_raw:
            wf_raw.setnchannels(1)
            wf_raw.setsampwidth(2)
            wf_raw.setframerate(SAMPLE_RATE)
            wf_raw.writeframes(raw_pcm_bytes)

        silences = detect_silences_wav(raw_wav, noise_db=-34, min_dur=0.04)
        if len(silences) < max(1, n // 2):
            silences = detect_silences_wav(raw_wav, noise_db=-26, min_dur=0.025)

        pcm = raw_pcm_bytes
        sampwidth = 2
        nchannels = 1
        fr = SAMPLE_RATE

        frame_bytes = sampwidth * nchannels
        total_frames = len(pcm) // frame_bytes
        total_dur = total_frames / float(fr)

        cuts = []
        for i in range(n - 1):
            gap_lo = raw_spans[i][1]
            gap_hi = raw_spans[i + 1][0]
            cur_gap = max(0.0, gap_hi - gap_lo)

            win_lo = max(0.0, gap_lo - 0.05)
            win_hi = min(total_dur, gap_hi + 0.05)
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
            else:
                cut_t = min(max(target_mid, gap_lo), total_dur)

            cur_part = clause_metas[i].get("part", "")
            nxt_part = clause_metas[i + 1].get("part", "")
            cur_stripped = (clause_metas[i].get("text") or "").rstrip("”’）)】」")
            if cur_part == "title" or nxt_part == "heading":
                target_gap = 0.62
            elif cur_stripped and cur_stripped[-1] in "。；？！":
                target_gap = 0.525
            else:
                target_gap = 0.375
            pad_needed = max(0.0, (target_gap + 0.016) - cur_gap)
            cuts.append({"cut_t": cut_t, "pad_sec": pad_needed})

        first_sp_start = max(0.0, raw_spans[0][0] - 0.02)
        lead_pad_frames = max(0, int(round(0.14 * fr)) - int(round(first_sp_start * fr)))
        pcm_parts = [b"\x00" * (lead_pad_frames * frame_bytes)]
        lead_shift = lead_pad_frames / float(fr)

        cut_frames = [int(round(c["cut_t"] * fr)) for c in cuts]
        for idx in range(1, len(cut_frames)):
            if cut_frames[idx] < cut_frames[idx - 1]:
                cut_frames[idx] = cut_frames[idx - 1]

        prev_frame = 0
        clause_shift = [0.0] * n
        running_pad = lead_shift
        for i in range(n):
            clause_shift[i] = running_pad
            if i < n - 1:
                cf = cut_frames[i]
                pcm_parts.append(pcm[prev_frame * frame_bytes : cf * frame_bytes])
                pad_f = int(round(cuts[i]["pad_sec"] * fr))
                if pad_f > 0:
                    pcm_parts.append(b"\x00" * (pad_f * frame_bytes))
                    running_pad += pad_f / float(fr)
                prev_frame = cf

        pcm_parts.append(pcm[prev_frame * frame_bytes :])
        pcm_parts.append(b"\x00" * (int(round(0.28 * fr)) * frame_bytes))

        with wave.open(str(pad_wav), "wb") as wf_out:
            wf_out.setnchannels(nchannels)
            wf_out.setsampwidth(sampwidth)
            wf_out.setframerate(fr)
            wf_out.writeframes(b"".join(pcm_parts))

        # 保持原生 龙安朗 音量水平（与未改动篇目完全一致，不额外叠加增益）
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", str(pad_wav),
                "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-b:a", "96k",
                "-map_metadata", "-1", str(tmp_out),
            ],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True,
        )
        tmp_out.replace(out_mp3)

    actual_dur = ffprobe_duration(out_mp3)
    sent_rows = []
    for i in range(n):
        c_meta = clause_metas[i]
        shift = clause_shift[i]
        st_sec = max(0.0, raw_spans[i][0] + shift - 0.006)
        en_sec = max(st_sec + 0.08, raw_spans[i][1] + shift + 0.006)
        if sent_rows and st_sec < sent_rows[-1]["end"]:
            mid_edge = (sent_rows[-1]["end"] + st_sec) * 0.5
            sent_rows[-1]["end"] = round(max(sent_rows[-1]["start"] + 0.06, mid_edge - 0.005), 3)
            sent_rows[-1]["duration"] = round(max(0.0, sent_rows[-1]["end"] - sent_rows[-1]["start"]), 3)
            st_sec = mid_edge + 0.005
        if actual_dur > 0 and en_sec > actual_dur:
            en_sec = actual_dur
        sent_rows.append({
            "id": c_meta["id"],
            "text": c_meta["text"],
            "start": round(st_sec, 3),
            "end": round(en_sec, 3),
            "duration": round(max(0.0, en_sec - st_sec), 3),
        })
    return sent_rows


def needs_track1_fix(rows: list[dict]) -> bool:
    for i, r in enumerate(rows):
        txt = (r.get("text") or "").strip()
        if re.match(r"^\d+\.\s", txt):
            return True
        if insert_prosody_commas_for_tts(txt) != txt:
            return True
        if i + 1 < len(rows):
            g = rows[i + 1]["start"] - r["end"]
            stripped = txt.rstrip("”’）)】」")
            if stripped and stripped[-1] in "，：" and g >= 0.45:
                return True
            if g < 0.05:
                return True
    return False


from build_kaoyan_bundle import (  # noqa: E402
    MANIFEST_706, MANIFEST_807, ROOT as BUNDLE_ROOT,
    sync_all_manifests_and_bundle, sync_t1_html_timestamps,
)


def resynth_one_t1(item: dict) -> tuple[bool, str]:
    audio_rel = (item.get("track1") or {}).get("audio", "")
    sent_rel = (item.get("track1") or {}).get("sentences_file", "")
    if not audio_rel or not sent_rel:
        return False, "Missing track1 path"
    out_mp3 = ROOT / audio_rel
    out_sent = ROOT / sent_rel
    rows = json.loads(out_sent.read_text(encoding="utf-8"))
    clause_metas, slot_groups = build_track1_slots(rows)
    slot_texts = ["".join(clause_metas[ci]["tts_text"] for ci in grp) for grp in slot_groups]

    for attempt in range(1, 5):
        try:
            raw_bytes, sent_events = synthesize_cosy_longanlang(slot_texts)
            new_rows = align_and_pad_cosy_track1(raw_bytes, sent_events, clause_metas, slot_groups, out_mp3)
            out_sent.write_text(json.dumps(new_rows, ensure_ascii=False, indent=2), encoding="utf-8")
            dur = ffprobe_duration(out_mp3)
            return True, f"OK ({len(new_rows)} 句, {dur:.1f}s, {out_mp3.stat().st_size/1024:.0f}KB)"
        except Exception as exc:
            if attempt == 4:
                return False, f"FAIL: {exc}"
            time.sleep(2 * attempt)
    return False, "FAIL"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ids", type=str, default="")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--apply-manifests", action="store_true")
    args = parser.parse_args()

    m706 = json.loads(MANIFEST_706.read_text(encoding="utf-8"))
    m807 = json.loads(MANIFEST_807.read_text(encoding="utf-8"))
    all_items = m706 + m807
    if args.ids:
        want = {x.strip() for x in args.ids.split(",") if x.strip()}
        items = [it for it in all_items if it["id"] in want]
    elif args.all:
        items = all_items
    else:
        items = []
        for it in all_items:
            sf = (it.get("track1") or {}).get("sentences_file", "")
            if sf and (ROOT / sf).exists():
                rows = json.loads((ROOT / sf).read_text(encoding="utf-8"))
                if needs_track1_fix(rows):
                    items.append(it)
    if args.limit > 0:
        items = items[:args.limit]

    print(f"Resynthesizing Track 1 (Aliyun CosyVoice longanlang, surgical phrasing fix): {len(items)}/{len(all_items)} items, workers={args.workers}")
    ok_cnt = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futs = {pool.submit(resynth_one_t1, it): it for it in items}
        done = 0
        for fut in concurrent.futures.as_completed(futs):
            done += 1
            it = futs[fut]
            ok, msg = fut.result()
            if ok:
                ok_cnt += 1
            print(f"[{done:02d}/{len(items):02d}] {'OK' if ok else 'ERR'} {it['id'][:36]} -> {msg}", flush=True)

    print(f"Track 1 (longanlang) synthesis finished: {ok_cnt}/{len(items)} succeeded")
    if args.apply_manifests:
        sync_all_manifests_and_bundle()


if __name__ == "__main__":
    main()
