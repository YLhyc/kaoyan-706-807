# -*- coding: utf-8 -*-
import json
import re
import os
import sys
import subprocess
from collections import Counter
from bs4 import BeautifulSoup
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")

print("=" * 70)
print("COMPREHENSIVE KAOYAN ALL-IN-ONE TIMESTAMP & DOM SYNC VERIFIER")
print("=" * 70)

# Step 0: Syntax check with node
print("\n[Step 0] Node syntax checks...")
all_syntax_pass = True
for js_file in ["app.js", "ai_sync.js", "sw.js", "data/kaoyan_data.js", "data/kaoyan_data_pol.js"]:
    p = os.path.join(ROOT, js_file)
    res = subprocess.run(["node", "--check", p], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode == 0:
        print(f"  [OK] {js_file} syntax valid.")
    else:
        print(f"  [FAIL] {js_file} syntax error:\n{res.stderr}")
        all_syntax_pass = False

if not all_syntax_pass:
    sys.exit(1)

# Step 1: Verify English, 706, and 807
print("\n[Step 1] Verifying English, 706, and 807 HTML timestamps against sentences.json...")
subject_checks = [
    ("English 16 Essays", "kaoyan_en_manifest.json"),
    ("706 Ancient (42 Items)", "kaoyan_706_manifest.json"),
    ("807 Contemporary (40 Items)", "kaoyan_807_manifest.json"),
]

total_all_spans = 0
total_all_drifts = 0
total_missing_ids = 0
total_missing_json = 0
total_duplicate_ids = 0

for sub_title, manifest_name in subject_checks:
    mf_path = os.path.join(DATA_DIR, manifest_name)
    with open(mf_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    
    sub_spans = 0
    sub_drifts = 0
    sub_missing = 0

    for item in manifest:
        for t_key in ["track1", "track2"]:
            t_obj = item.get(t_key, {})
            audio = t_obj.get("audio", "")
            if not audio: continue
            json_rel = audio.replace(".mp3", ".sentences.json")
            json_path = os.path.join(ROOT, json_rel)
            if not os.path.exists(json_path):
                total_missing_json += 1
                print(f"  Missing sentences JSON: {json_path}")
                continue
            with open(json_path, "r", encoding="utf-8") as f:
                sents = json.load(f)
            sent_map = {str(s.get("id")): s for s in sents}
            json_ids = [str(s.get("id")) for s in sents]
            duplicates = {sid: count for sid, count in Counter(json_ids).items() if count > 1}
            if duplicates:
                total_duplicate_ids += len(duplicates)
                print(f"  Duplicate JSON sentence IDs in {item['id']} {t_key}: {duplicates}")

            # 706/807 Track 2 renders dynamically from track2.micro_slots (v3.5.7+), not legacy static HTML
            if t_key == "track2" and isinstance(t_obj.get("micro_slots"), list) and t_obj["micro_slots"]:
                slot_cids = [
                    str(c.get("sent_id"))
                    for sl in t_obj["micro_slots"]
                    for c in (sl.get("clauses") or [])
                    if c.get("sent_id") is not None
                ]
                sub_spans += len(slot_cids)
                missing_slots = set(sent_map) - set(slot_cids)
                if missing_slots:
                    sub_missing += len(missing_slots)
                    print(f"  Missing micro_slots sent_ids in {item['id']} track2: {sorted(missing_slots)}")
                slot_dups = {sid: cnt for sid, cnt in Counter(slot_cids).items() if cnt > 1}
                if slot_dups:
                    total_duplicate_ids += len(slot_dups)
                    print(f"  Duplicate micro_slots sent_ids in {item['id']} track2: {slot_dups}")
                continue

            soup = BeautifulSoup(t_obj.get("html", ""), "html.parser")
            spans = soup.find_all(attrs={"data-sent-id": True})
            primary = [sp for sp in spans if not (t_key == "track2" and "t1-linked-sent" in sp.get("class", []))]
            primary_ids = [sp.get("data-sent-id") for sp in primary]
            missing_dom = set(sent_map) - set(primary_ids)
            if missing_dom:
                sub_missing += len(missing_dom)
                print(f"  Missing primary DOM sentences in {item['id']} {t_key}: {sorted(missing_dom)}")
            groups = [primary]
            if t_key == "track2":
                groups.append([sp for sp in spans if "t1-linked-sent" in sp.get("class", [])])
            for group in groups:
                duplicates = {sid: count for sid, count in Counter(sp.get("data-sent-id") for sp in group).items() if count > 1}
                if duplicates:
                    total_duplicate_ids += len(duplicates)
                    print(f"  Duplicate DOM sentence IDs in {item['id']} {t_key}: {duplicates}")
            for span in spans:
                sub_spans += 1
                sid = span.get("data-sent-id")
                if sid not in sent_map:
                    sub_missing += 1
                    continue
                ds_start = float(span.get("data-start", -1))
                ds_end = float(span.get("data-end", -1))
                ref = sent_map[sid]
                ref_start = float(ref.get("start", -2))
                ref_end = float(ref.get("end", -2))
                if abs(ds_start - ref_start) > 0.005 or abs(ds_end - ref_end) > 0.005:
                    sub_drifts += 1
                    print(f"  Drift in {item['id']} {t_key} {sid}: HTML({ds_start}, {ds_end}) vs JSON({ref_start}, {ref_end})")

    print(f"  {sub_title}: {sub_spans} spans verified. Drifts: {sub_drifts}, Missing IDs: {sub_missing}")
    total_all_spans += sub_spans
    total_all_drifts += sub_drifts
    total_missing_ids += sub_missing

# Step 2: Verify Politics 47 Chapters (kaoyan_data_pol.js)
print("\n[Step 2] Verifying Politics 47 Chapters in kaoyan_data_pol.js...")
pol_js_path = os.path.join(DATA_DIR, "kaoyan_data_pol.js")
with open(pol_js_path, "r", encoding="utf-8") as f:
    pol_text = f.read()

m_json = re.search(r'window\.KAOYAN_POL_DATA\s*=\s*({[\s\S]*?});\s*$', pol_text)
if not m_json:
    print("  [FAIL] Cannot extract JSON from kaoyan_data_pol.js")
    sys.exit(1)

pol_data = json.loads(m_json.group(1))
chapters47 = pol_data.get("chapters47", [])
print(f"  Loaded {len(chapters47)} chapters from kaoyan_data_pol.js.")

t1_total_sents = 0
t1_dom_elements = 0
t1_dup_ids = 0
t1_mismatches = 0

t2_subcards_total = 0
t2_total_sents = 0
t2_mismatches = 0

for ch in chapters47:
    ch_id = ch["id"]
    t1 = ch.get("track1", {})
    t1_sents = t1.get("sentences", [])
    t1_total_sents += len(t1_sents)

    # Check ID uniqueness in track1.sentences
    sent_ids = [s["id"] for s in t1_sents]
    id_counts = Counter(sent_ids)
    dups = {k: v for k, v in id_counts.items() if v > 1}
    if dups:
        t1_dup_ids += len(dups)
        print(f"  Duplicate sent IDs in {ch_id} track1: {dups}")

    # Check HTML DOM stamps
    recite_html = t1.get("reciteHtml", "")
    understand_html = t1.get("understandHtml", "")
    soup = BeautifulSoup(f"<div>{recite_html} {understand_html}</div>", "html.parser")
    
    # Map DOM elements by data-sent-idx
    items = soup.find_all(class_=re.compile(r'recite-sent-item'))
    dom_by_idx = {}
    dom_ids_seen = set()
    for el in items:
        t1_dom_elements += 1
        idx_str = el.get("data-sent-idx")
        if idx_str is not None:
            dom_by_idx[int(idx_str)] = el
        eid = el.get("id")
        if eid in dom_ids_seen:
            t1_dup_ids += 1
            print(f"  Duplicate DOM ID in {ch_id}: {eid}")
        dom_ids_seen.add(eid)

    # Check each sentence vs DOM
    for s_idx, s in enumerate(t1_sents):
        el = dom_by_idx.get(s_idx)
        if not el:
            t1_mismatches += 1
            print(f"  Missing DOM element in {ch_id} for sent {s_idx} ({s['text'][:25]})")
            continue
        ds_start = float(el.get("data-start", -1))
        ds_end = float(el.get("data-end", -1))
        ref_start = float(s.get("start", -2))
        ref_end = float(s.get("end", -2))
        if abs(ds_start - ref_start) > 0.005 or abs(ds_end - ref_end) > 0.005:
            t1_mismatches += 1
            print(f"  Drift in {ch_id} sent {s_idx}: DOM ({ds_start}, {ds_end}) vs Sent ({ref_start}, {ref_end})")

    # Track 2 verification
    t2 = ch.get("track2", {})
    sub_cards = t2.get("subCards", [])
    t2_subcards_total += len(sub_cards)
    for sc in sub_cards:
        cid = sc["cardId"]
        sc_sents = sc.get("sentences", [])
        sc_html = sc.get("lectureHtml", "")
        t2_total_sents += len(sc_sents)
        sc_soup = BeautifulSoup(sc_html, "html.parser")
        sc_spans = sc_soup.find_all(class_=re.compile(r'recite-sentence'))
        span_by_idx = {}
        for sp in sc_spans:
            idx_str = sp.get("data-sent-idx")
            if idx_str is not None:
                span_by_idx[int(idx_str)] = sp
        for s_idx, s in enumerate(sc_sents):
            sp = span_by_idx.get(s_idx)
            if not sp and s_idx < len(sc_spans):
                sp = sc_spans[s_idx]
            if not sp:
                t2_mismatches += 1
                continue
            ds_start = float(sp.get("data-start", -1))
            ds_end = float(sp.get("data-end", -1))
            ref_start = float(s.get("start", -2))
            ref_end = float(s.get("end", -2))
            if abs(ds_start - ref_start) > 0.005 or abs(ds_end - ref_end) > 0.005:
                t2_mismatches += 1

print(f"  Politics Track 1: {t1_total_sents} sentences, {t1_dom_elements} DOM elements.")
print(f"    Duplicate IDs: {t1_dup_ids}")
print(f"    Timestamp / Missing Element Mismatches: {t1_mismatches}")
print(f"  Politics Track 2: {t2_subcards_total} subCards, {t2_total_sents} sentences.")
print(f"    Timestamp / Missing Mismatches: {t2_mismatches}")

# Step 3: Verify SVGs and Emojis
print("\n[Step 3] Auditing SVGs and Emojis across project...")
def audit_svgs(fp):
    text = Path(fp).read_text(encoding='utf-8', errors='ignore')
    svgs = re.findall(r'<svg[^>]*>', text)
    issues = []
    for s in svgs:
        has_vb = 'viewBox=' in s or 'viewbox=' in s
        has_w = 'width=' in s
        has_h = 'height=' in s
        if not has_vb or not has_w or not has_h:
            issues.append(s)
    return len(svgs), issues

total_svg_issues = 0
for fpath in [os.path.join(ROOT, "index.html"), os.path.join(ROOT, "app.js"), os.path.join(ROOT, "ai_sync.js")]:
    count, issues = audit_svgs(fpath)
    base = os.path.basename(fpath)
    total_svg_issues += len(issues)
    print(f"  {base}: {count} SVGs, {len(issues)} attribute issues.")

# Step 4: Verify Builtin Cloze 100% Match against 706/807 Track 1 Text
print("\n[Step 4] Verifying KAOYAN_BUILTIN_CLOZE phrases against 706/807 Track 1 HTML...")
kaoyan_data_text = Path(os.path.join(DATA_DIR, "kaoyan_data.js")).read_text(encoding="utf-8")
m_cloze = re.search(r'window\.KAOYAN_BUILTIN_CLOZE\s*=\s*(\{[\s\S]*?\});\s*$', kaoyan_data_text)
cloze_mismatches = 0
if not m_cloze:
    print("  [FAIL] Missing window.KAOYAN_BUILTIN_CLOZE in data/kaoyan_data.js")
    cloze_mismatches += 1
else:
    cloze_dict = json.loads(m_cloze.group(1))
    all_pro_items = []
    for m_name in ("kaoyan_706_manifest.json", "kaoyan_807_manifest.json"):
        all_pro_items.extend(json.loads(Path(os.path.join(DATA_DIR, m_name)).read_text(encoding="utf-8")))
    by_pro_id = {it["id"]: it for it in all_pro_items}
    checked_terms = 0
    for item_id, entry in cloze_dict.items():
        it = by_pro_id.get(item_id)
        if not it or not isinstance(entry, dict):
            continue
        plain = re.sub(r"<[^>]+>", "", it.get("track1", {}).get("html", ""))
        for field in ("skeleton", "scoring"):
            for term in entry.get(field, []) or []:
                checked_terms += 1
                if term not in plain:
                    cloze_mismatches += 1
                    print(f"  [Cloze Mismatch] {item_id} ({field}): {term}")
    print(f"  Checked {checked_terms} builtin cloze terms: {cloze_mismatches} mismatches.")

print("\n" + "=" * 70)
total_errors = (
    total_all_drifts
    + total_missing_ids
    + total_missing_json
    + total_duplicate_ids
    + t1_dup_ids
    + t1_mismatches
    + t2_mismatches
    + total_svg_issues
    + cloze_mismatches
)
if total_errors == 0:
    print("ALL VERIFICATION CHECKS PASSED WITH 100% PERFECTION!")
    print("ZERO TIMESTAMP DRIFT! ZERO DUPLICATE IDS! ALL DATASETS SYNCHRONIZED!")
else:
    print(f"VERIFICATION FINISHED WITH {total_errors} ISSUES. Review details above.")
print("=" * 70)
if total_errors > 0:
    sys.exit(1)
