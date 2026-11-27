#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Canonical data bundle & manifest synchronizer.
Rebuilds data/kaoyan_all_manifest.json and data/kaoyan_data.js cleanly from:
  - data/kaoyan_807_manifest.json
  - data/kaoyan_706_manifest.json
  - data/kaoyan_en_manifest.json
  - all referenced track1/track2 *.sentences.json files
  - data/kaoyan_builtin_cloze.json (window.KAOYAN_BUILTIN_CLOZE)

Every Track 1 or Track 2 pipeline MUST call sync_all_manifests_and_bundle() here
instead of hand-writing data/kaoyan_data.js.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
MANIFEST_706 = DATA_DIR / "kaoyan_706_manifest.json"
MANIFEST_807 = DATA_DIR / "kaoyan_807_manifest.json"
MANIFEST_EN = DATA_DIR / "kaoyan_en_manifest.json"
MANIFEST_ALL = DATA_DIR / "kaoyan_all_manifest.json"
BUILTIN_CLOZE_JSON = DATA_DIR / "kaoyan_builtin_cloze.json"
BUNDLE_JS = DATA_DIR / "kaoyan_data.js"


def sync_t1_html_timestamps(html_str: str, sent_rows: list[dict]) -> str:
    """Sync Track 1 HTML data-start/data-end using data-sent-id FIRST (Track 1 data-sent-idx is 1-based)."""
    if not html_str or not sent_rows:
        return html_str
    by_id = {str(r.get("id")): r for r in sent_rows if r.get("id") is not None}
    by_zero_idx = {str(i): r for i, r in enumerate(sent_rows)}

    def _repl(match: re.Match) -> str:
        tag_txt = match.group(0)
        m_id = re.search(r'data-sent-id="([^"]+)"', tag_txt)
        m_idx = re.search(r'data-sent-idx="(\d+)"', tag_txt)
        row = None
        if m_id and m_id.group(1) in by_id:
            row = by_id[m_id.group(1)]
        elif m_idx and m_idx.group(1) in by_zero_idx:
            row = by_zero_idx[m_idx.group(1)]
        if not row:
            return tag_txt
        tag_txt = re.sub(r'data-start="[^"]*"', f'data-start="{row["start"]:.3f}"', tag_txt)
        tag_txt = re.sub(r'data-end="[^"]*"', f'data-end="{row["end"]:.3f}"', tag_txt)
        return tag_txt

    return re.sub(r'<[^>]*(?:data-sent-id|data-sent-idx)[^>]*>', _repl, html_str)


def sync_all_manifests_and_bundle(sync_t1_html: bool = True) -> None:
    m706 = json.loads(MANIFEST_706.read_text(encoding="utf-8"))
    m807 = json.loads(MANIFEST_807.read_text(encoding="utf-8"))

    if sync_t1_html:
        for items in (m706, m807):
            for it in items:
                sfile = ((it.get("track1") or {}).get("sentences_file") or "").replace("\\", "/")
                if sfile and (ROOT / sfile).exists():
                    rows = json.loads((ROOT / sfile).read_text(encoding="utf-8"))
                    it["track1"]["html"] = sync_t1_html_timestamps(it["track1"].get("html", ""), rows)
        MANIFEST_706.write_text(json.dumps(m706, ensure_ascii=False, indent=2), encoding="utf-8")
        MANIFEST_807.write_text(json.dumps(m807, ensure_ascii=False, indent=2), encoding="utf-8")

    all_m = json.loads(MANIFEST_ALL.read_text(encoding="utf-8")) if MANIFEST_ALL.exists() else {}
    all_m["items_706"] = m706
    all_m["items_807"] = m807
    if MANIFEST_EN.exists():
        all_m["items_en"] = json.loads(MANIFEST_EN.read_text(encoding="utf-8"))
    MANIFEST_ALL.write_text(json.dumps(all_m, ensure_ascii=False, indent=2), encoding="utf-8")

    all_sents = {}
    for subj_key in ("items_807", "items_706", "items_en"):
        for it in all_m.get(subj_key, []):
            for tk in ("track1", "track2"):
                sf = ((it.get(tk) or {}).get("sentences_file") or "").replace("\\", "/")
                if sf and (ROOT / sf).exists():
                    all_sents[sf] = json.loads((ROOT / sf).read_text(encoding="utf-8"))

    chunks = [
        "// 2027 考研专业课双轨随身背诵手卷 · 离线全量数据与高保真研读包",
        "// 彻底免疫浏览器 file:/// 下的 CORS 限制，双击即可秒开",
        f"window.KAOYAN_MANIFEST = {json.dumps(all_m, ensure_ascii=False)};\n",
        f"window.KAOYAN_SENTENCES = {json.dumps(all_sents, ensure_ascii=False)};\n",
    ]
    if BUILTIN_CLOZE_JSON.exists():
        cloze_obj = json.loads(BUILTIN_CLOZE_JSON.read_text(encoding="utf-8"))
        chunks.append(f"window.KAOYAN_BUILTIN_CLOZE = {json.dumps(cloze_obj, ensure_ascii=False)};\n")

    BUNDLE_JS.write_text("\n".join(chunks), encoding="utf-8")
    print(f"Synced manifest + bundle ({len(all_sents)} sentence files, cloze={BUILTIN_CLOZE_JSON.exists()})")


if __name__ == "__main__":
    sync_all_manifests_and_bundle(sync_t1_html=True)
