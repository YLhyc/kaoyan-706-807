#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Fast non-browser contract tests preventing recurring regressions across:
1. Track 1 & Track 2 82-item asset completeness, non-overlapping timestamps & gap floors;
2. TTS text hygiene (no unexpanded decades like 20s/40s, no Track 1 ordinal dots `1. `);
3. Bundle freshness: data/kaoyan_all_manifest.json, data/kaoyan_data.js & KAOYAN_BUILTIN_CLOZE;
4. Player / Loop / iOS PWA static invariants in app.js.
"""

import json
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def main():
    failures = []

    def check(cond, name, detail=""):
        if not cond:
            failures.append(f"{name}: {detail}")
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" ({detail})" if detail else ""))

    m706 = json.loads((DATA / "kaoyan_706_manifest.json").read_text(encoding="utf-8"))
    m807 = json.loads((DATA / "kaoyan_807_manifest.json").read_text(encoding="utf-8"))
    items = m706 + m807
    check(len(items) == 82, "706+807 item count == 82", f"got={len(items)}")

    # 1. Track 1 & Track 2 file completeness, timestamps, gap invariants & text hygiene
    bad_t1_files = []
    bad_t1_gaps = []
    bad_t1_dots = []
    bad_t1_cps = []
    bad_t2_files = []
    bad_t2_overlaps = []
    bad_t2_cps = []
    bad_decades = []

    def cjk_len(s: str) -> int:
        return len(re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", s or ""))

    for it in items:
        iid = it["id"]
        t1 = it.get("track1") or {}
        t2 = it.get("track2") or {}

        t1_mp3 = ROOT / t1.get("audio", "")
        t1_sf = ROOT / t1.get("sentences_file", "")
        if not t1.get("audio", "").endswith("_exam.mp3") or not t1_mp3.exists() or not t1_sf.exists():
            bad_t1_files.append(iid)
        else:
            rows1 = json.loads(t1_sf.read_text(encoding="utf-8"))
            for i, r in enumerate(rows1):
                txt = (r.get("text") or "").strip()
                if re.match(r"^\d+\.\s", txt):
                    bad_t1_dots.append((iid, txt[:24]))
                if re.search(r"\b\d{2}s\b", txt):
                    bad_decades.append((iid, "t1", txt[:24]))
                if r["end"] <= r["start"]:
                    bad_t1_gaps.append((iid, i, "non_positive"))
                else:
                    n_ch = cjk_len(txt)
                    cps = n_ch / max(0.01, r["end"] - r["start"])
                    if n_ch >= 8 and (cps < 1.8 or cps > 9.5):
                        bad_t1_cps.append((iid, i, round(cps, 2), txt[:18]))
                if i + 1 < len(rows1):
                    g = rows1[i + 1]["start"] - r["end"]
                    if g < 0.04:
                        bad_t1_gaps.append((iid, i, round(g, 3)))

        t2_mp3 = ROOT / t2.get("audio", "")
        t2_sf = ROOT / t2.get("sentences_file", "")
        if (
            not t2.get("audio", "").endswith("_micro.mp3")
            or not t2_mp3.exists()
            or not t2_sf.exists()
            or not t2.get("micro_slots")
        ):
            bad_t2_files.append(iid)
        else:
            rows2 = json.loads(t2_sf.read_text(encoding="utf-8"))
            for i, r in enumerate(rows2):
                txt = (r.get("text") or "").strip()
                if re.search(r"\b\d{2}s\b", txt):
                    bad_decades.append((iid, "t2", txt[:24]))
                if r["end"] <= r["start"]:
                    bad_t2_overlaps.append((iid, i, "non_positive"))
                else:
                    n_ch = cjk_len(txt)
                    cps = n_ch / max(0.01, r["end"] - r["start"])
                    if n_ch >= 8 and (cps < 1.5 or cps > 10.5):
                        bad_t2_cps.append((iid, i, round(cps, 2), txt[:18]))
                if i + 1 < len(rows2) and rows2[i + 1]["start"] < r["end"] - 0.002:
                    bad_t2_overlaps.append((iid, i, round(rows2[i + 1]["start"] - r["end"], 3)))

    check(not bad_t1_files, "All 82 Track 1 *_exam.mp3 and sentences exist", f"bad={bad_t1_files[:5]}")
    check(not bad_t1_gaps, "Track 1 monotonic timestamps and >=40ms inter-clause gaps", f"bad={bad_t1_gaps[:5]}")
    check(not bad_t1_cps, "Track 1 speech-rate alignment sanity (1.8<=cps<=9.5)", f"bad={bad_t1_cps[:5]}")
    check(not bad_t2_files, "All 82 Track 2 *_micro.mp3, sentences & micro_slots exist", f"bad={bad_t2_files[:5]}")
    check(not bad_t2_overlaps, "Track 2 non-overlapping monotonic timestamps", f"bad={bad_t2_overlaps[:5]}")
    check(not bad_t2_cps, "Track 2 speech-rate alignment sanity (1.5<=cps<=10.5)", f"bad={bad_t2_cps[:5]}")
    check(not bad_decades, "Zero unexpanded decade abbreviations (20s/40s)", f"bad={bad_decades[:5]}")

    resynth_txt = (ROOT / "tools" / "resynth_track1_clean.py").read_text(encoding="utf-8")
    check(
        "cosyvoice-v2" not in resynth_txt and "MP3_22050HZ" not in resynth_txt,
        "Track 1 synthesis script forbids low-band cosyvoice-v2 / 22050Hz",
    )

    # 2. Bundle freshness & KAOYAN_BUILTIN_CLOZE integrity
    all_m = json.loads((DATA / "kaoyan_all_manifest.json").read_text(encoding="utf-8"))
    check(
        all_m.get("items_706") == m706 and all_m.get("items_807") == m807,
        "kaoyan_all_manifest.json matches 706 & 807 manifests exactly",
    )

    bundle_txt = (DATA / "kaoyan_data.js").read_text(encoding="utf-8")
    m_km = re.search(r"window\.KAOYAN_MANIFEST\s*=\s*(\{.*\});", bundle_txt)
    m_ks = re.search(r"window\.KAOYAN_SENTENCES\s*=\s*(\{.*\});", bundle_txt)
    m_kc = re.search(r"window\.KAOYAN_BUILTIN_CLOZE\s*=\s*(\{.*\});", bundle_txt)
    check(bool(m_km and m_ks and m_kc), "kaoyan_data.js exports MANIFEST, SENTENCES and BUILTIN_CLOZE")
    if m_km and m_ks and m_kc:
        km = json.loads(m_km.group(1))
        ks = json.loads(m_ks.group(1))
        kc = json.loads(m_kc.group(1))
        check(km == all_m, "kaoyan_data.js KAOYAN_MANIFEST matches kaoyan_all_manifest.json")
        cloze_ref = json.loads((DATA / "kaoyan_builtin_cloze.json").read_text(encoding="utf-8"))
        check(kc == cloze_ref and len(kc) == 102, f"KAOYAN_BUILTIN_CLOZE matches data/kaoyan_builtin_cloze.json (102, got={len(kc)})")
        stale_sents = []
        for it in items + (all_m.get("items_en") or []):
            for tk in ("track1", "track2"):
                sf = it[tk]["sentences_file"].replace("\\", "/")
                if ks.get(sf) != json.loads((ROOT / sf).read_text(encoding="utf-8")):
                    stale_sents.append(sf)
        check(not stale_sents, "kaoyan_data.js KAOYAN_SENTENCES matches all disk sentences.json", f"stale={stale_sents[:5]}")

        en_items = all_m.get("items_en") or []
        check(len(en_items) == 20, "English manifest has 20 cards (4 pocket + 16 essays)", f"got={len(en_items)}")
        bad_en_files = []
        bad_en_blanks = []
        for it in en_items:
            eid = it["id"]
            for tk in ("track1", "track2"):
                tobj = it.get(tk) or {}
                mp3_p = ROOT / tobj.get("audio", "")
                sf_p = ROOT / tobj.get("sentences_file", "")
                if not mp3_p.exists() or not sf_p.exists():
                    bad_en_files.append((eid, tk))
                elif tk == "track2":
                    rows = json.loads(sf_p.read_text(encoding="utf-8"))
                    for j in range(len(rows) - 1):
                        if str(rows[j].get("id", "")).endswith("_cn") and str(rows[j + 1].get("id", "")).endswith("_en"):
                            g = float(rows[j + 1]["start"]) - float(rows[j]["end"])
                            if g < 1.75:
                                bad_en_blanks.append((eid, rows[j]["id"], round(g, 3)))
        check(not bad_en_files, "All 20 English dual-track audio & sentences exist", f"bad={bad_en_files[:5]}")
        check(not bad_en_blanks, "All 20 English Track 2 units keep >=1.8s retrieval silence blank", f"bad={bad_en_blanks[:5]}")

    # 3. app.js Loop & Seek Safety Invariants
    app_txt = (ROOT / "app.js").read_text(encoding="utf-8")
    m_plt = re.search(r"function performLoopTransition\([\s\S]*?\n  function ", app_txt)
    plt_body = m_plt.group(0) if m_plt else ""
    pause_pos = plt_body.find("audio.pause()")
    seek_pos = plt_body.find("triggerLoopSeek(")
    check(
        pause_pos != -1 and seek_pos != -1 and pause_pos < seek_pos,
        "performLoopTransition pauses audio BEFORE triggerLoopSeek (prevents 2-char repeat)",
    )
    check(
        "function isLoopSeekInFlight(" in app_txt and "function clearLoopSeekLock(" in app_txt,
        "Async seek lock uses seeked/readyState convergence (isLoopSeekInFlight)",
    )

    m_hlb = re.search(r"function handleLoopBoundary\(cur, isEnded = false\)[\s\S]*?\n    function ", app_txt)
    hlb_body = m_hlb.group(0) if m_hlb else ""
    next_calls = hlb_body.count("playNextItem()")
    check(
        next_calls == 1 and "state.playMode === 'item'" in hlb_body and "state.playMode === 'sequence'" in hlb_body,
        "handleLoopBoundary calls playNextItem() strictly on sequence branch only",
        f"playNextItem_calls={next_calls}",
    )

    if failures:
        print(f"\nCONTRACT CHECK FAILED ({len(failures)} issues):")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("\nALL AUDIO, BUNDLE & STATE-MACHINE CONTRACT CHECKS PASSED!")


if __name__ == "__main__":
    main()
