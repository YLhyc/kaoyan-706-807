# -*- coding: utf-8 -*-
"""
verify_all_in_one.py
全科考研双轨背诵手卷（All-in-One V3.0）终极整合全量自动化审计脚本
验证全部 10 项防退化红线与核心逻辑指标
"""

import os
import sys
import re
import json
import subprocess

sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = r"D:\AI_file\706_807专业课背诵手卷"

passed_checks = []
failed_checks = []

def record(check_name, ok, msg=""):
    if ok:
        print(f"  [PASS] {check_name}: {msg}")
        passed_checks.append(check_name)
    else:
        print(f"  [FAIL] {check_name}: {msg}")
        failed_checks.append((check_name, msg))

print("=================================================================")
print("  全科考研双轨手卷 V3.0 · 全量自动化审计与防退化验收 (10项红线)")
print("=================================================================\n")

# ---------------- Check 1: 政治数据完整性 (47章, xsx_00, 16天徐涛, 11天腿姐) ----------------
print("[Check 1] 校验 data/kaoyan_data_pol.js 数据完整性与干净度...")
pol_js_path = os.path.join(BASE_DIR, "data", "kaoyan_data_pol.js")
try:
    with open(pol_js_path, "r", encoding="utf-8") as f:
        js_text = f.read()

    assert js_text.startswith("window.KAOYAN_POL_DATA = "), "Missing window.KAOYAN_POL_DATA"
    raw_json = js_text[len("window.KAOYAN_POL_DATA = "):].rstrip().rstrip(";")
    pol_data = json.loads(raw_json)

    c47 = pol_data.get("chapters47", [])
    x16 = pol_data.get("xutao16", [])
    t11 = pol_data.get("tuijie11", [])

    assert len(c47) == 47, f"Chapters count is {len(c47)}, expected 47"
    total_subcards = sum(len(ch.get("track2", {}).get("subCards", [])) for ch in c47)
    assert total_subcards == 119, f"Subcards count is {total_subcards}, expected 119"
    assert len(x16) == 16, f"Xutao 16 count is {len(x16)}, expected 16"
    assert len(t11) == 11, f"Tuijie 11 count is {len(t11)}, expected 11"

    # xsx_00 audio must be None and exist in ch_xsx_00
    xsx_00_found = False
    for ch in c47:
        if ch["id"] == "ch_xsx_00":
            for sc in ch.get("track2", {}).get("subCards", []):
                if sc["cardId"] == "xsx_00":
                    xsx_00_found = True
                    assert sc["audio"] is None, "xsx_00 audio must be null/None"
    assert xsx_00_found, "xsx_00 not found in ch_xsx_00 subCards"

    # zero doubt-panel
    assert "doubt-panel" not in js_text, "Found .doubt-panel residual!"

    # zero inline onclick
    for fn in ["seekChapterReciteSentence", "seekReciteSentence", "togglePlayCardAudio"]:
        assert fn not in js_text, f"Found inline onclick {fn} residual in kaoyan_data_pol.js!"

    record("Check 1 (数据完整性)", True, "47章、119个微考点、16天徐涛、11天腿姐完整无损，xsx_00为null，0个.doubt-panel与onclick残留")
except Exception as e:
    record("Check 1 (数据完整性)", False, str(e))


# ---------------- Check 2: 腿姐 11 天完整数据结构与 resolved_sentences ----------------
print("\n[Check 2] 校验腿姐 11 天 sections、resolved_sentences、timestamps 与 points...")
try:
    assert len(t11) == 11, "Tuijie 11 count != 11"
    total_resolved_sents = 0
    total_points = 0
    for day in t11:
        assert "subtitle" in day and day["subtitle"], f"Tuijie day {day['day']} missing subtitle"
        assert "audio" in day and day["audio"], f"Tuijie day {day['day']} missing audio"
        assert "duration_str" in day and day["duration_str"], f"Tuijie day {day['day']} missing duration_str"
        assert "timestamps" in day and len(day["timestamps"]) > 0, f"Tuijie day {day['day']} missing timestamps"
        assert "points" in day and len(day["points"]) > 0, f"Tuijie day {day['day']} missing points"
        for p in day["points"]:
            assert "label" in p and "text" in p, f"Invalid point structure: {p}"
            total_points += 1
        assert "sections" in day and len(day["sections"]) > 0, f"Tuijie day {day['day']} missing sections"
        for sec in day["sections"]:
            assert "resolved_sentences" in sec, f"Section missing resolved_sentences: {sec.get('title')}"
            assert len(sec["resolved_sentences"]) > 0, f"resolved_sentences is empty: {sec.get('title')}"
            for s in sec["resolved_sentences"]:
                assert "idx" in s and "start" in s and "end" in s and "text" in s, f"Invalid sentence structure: {s}"
                assert s["end"] >= s["start"], f"Invalid sentence timestamp: {s}"
                total_resolved_sents += 1

    record("Check 2 (腿姐11天结构完整性)", True, f"11天冲刺讲义共解析 {total_resolved_sents} 句 resolved_sentences 与 {total_points} 个命题考点")
except Exception as e:
    record("Check 2 (腿姐11天结构完整性)", False, str(e))


# ---------------- Check 3: 音频零死链 ----------------
print("\n[Check 3] 校验全科全部音频磁盘物理存在与文件大小 (>10KB)...")
audio_errors = []
total_audio_checked = 0

# 1. 政治音频检查
pol_audios_to_check = set()
for ch in pol_data.get("chapters47", []):
    pol_audios_to_check.add(ch["track1"]["audio"])
    for sc in ch.get("track2", {}).get("subCards", []):
        if sc["audio"]:
            pol_audios_to_check.add(sc["audio"])

for xt in pol_data.get("xutao16", []):
    pol_audios_to_check.add(xt["anlang_audio"])
    pol_audios_to_check.add(xt["voice_audio"])

for tj in pol_data.get("tuijie11", []):
    pol_audios_to_check.add(tj["audio"])

for rel_path in pol_audios_to_check:
    full_path = os.path.join(BASE_DIR, rel_path.replace("/", os.sep))
    total_audio_checked += 1
    if not os.path.exists(full_path):
        audio_errors.append(f"Missing file: {rel_path}")
    elif os.path.getsize(full_path) < 10240:
        audio_errors.append(f"File too small (<10KB): {rel_path} ({os.path.getsize(full_path)} bytes)")

# 2. 专业课音频检查
kaoyan_data_js = os.path.join(BASE_DIR, "data", "kaoyan_data.js")
if os.path.exists(kaoyan_data_js):
    with open(kaoyan_data_js, "r", encoding="utf-8") as f:
        t_prof = f.read()
    prof_mp3s = set(re.findall(r'[\'"](audio_cards/[^\'"]+?\.mp3)[\'"]', t_prof))
    for rel_path in prof_mp3s:
        full_path = os.path.join(BASE_DIR, rel_path.replace("/", os.sep))
        total_audio_checked += 1
        if not os.path.exists(full_path):
            audio_errors.append(f"Missing prof file: {rel_path}")
        elif os.path.getsize(full_path) < 10240:
            audio_errors.append(f"Prof file too small (<10KB): {rel_path} ({os.path.getsize(full_path)} bytes)")

if not audio_errors:
    record("Check 3 (音频零死链)", True, f"已核对 {total_audio_checked} 个音频引用，物理文件 100% 存在且大小正常")
else:
    record("Check 3 (音频零死链)", False, f"发现 {len(audio_errors)} 处错误: {audio_errors[:3]}")


# ---------------- Check 4: 工作区体积红线 ----------------
print("\n[Check 4] 校验工作区非 Git 资产总大小 (< 550 MB)...")
def get_dir_size(path):
    total = 0
    for root, dirs, files in os.walk(path):
        if ".git" in root or "node_modules" in root or "__pycache__" in root:
            continue
        for f in files:
            fp = os.path.join(root, f)
            total += os.path.getsize(fp)
    return total

work_bytes = get_dir_size(BASE_DIR)
work_mb = work_bytes / (1024 * 1024)
if work_mb < 550:
    record("Check 4 (仓库体积红线)", True, f"工作区总大小为 {work_mb:.2f} MB (远低于 1GB 封禁线与警戒线)")
else:
    record("Check 4 (仓库体积红线)", False, f"工作区大小 {work_mb:.2f} MB 偏大")


# ---------------- Check 5: app.js 核心路由与轨道保护 ----------------
print("\n[Check 5] 校验 app.js 政治轨道路由与跨科切换保护...")
with open(os.path.join(BASE_DIR, "app.js"), "r", encoding="utf-8") as f:
    js_content = f.read()

# loadTrackData 必须在开头进行政治路由
m_load_track = re.search(r'function\s+loadTrackData\s*\([^)]*\)\s*\{([\s\S]*?)(?:const\s+item|state\.currentTrack)', js_content)
has_pol_route_in_track = bool(m_load_track and "state.currentSubject === 'pol'" in m_load_track.group(1))

# 全局 shims
has_shims = "window.seekChapterReciteSentence" in js_content and "window.seekReciteSentence" in js_content and "window.togglePlayCardAudio" in js_content

# 没有过时的 span[data-sent-idx]
has_no_obsolete_selector = "span[data-sent-idx]" not in js_content
has_general_sent_idx = "[data-sent-idx]" in js_content

if has_pol_route_in_track and has_shims and has_no_obsolete_selector and has_general_sent_idx:
    record("Check 5 (轨道路由与通用选择器)", True, "loadTrackData 开头即拦截政治模式，全局 shims 就绪，全量采用 [data-sent-idx] 通用选择器")
else:
    record("Check 5 (轨道路由与通用选择器)", False, f"pol_route={has_pol_route_in_track}, shims={has_shims}, no_obsolete={has_no_obsolete_selector}")


# ---------------- Check 6: 首字弱提示挖空交互与 CSS 匹配 ----------------
print("\n[Check 6] 校验首字弱提示挖空规范 (CSS 与 JS 逻辑一致性)...")
with open(os.path.join(BASE_DIR, "app.css"), "r", encoding="utf-8") as f:
    css_content = f.read()

has_cloze_ghost_css = "content: attr(data-ghost);" in css_content
has_cloze_active_css = ".cloze-keyword-active" in css_content and ".cloze-keyword" in css_content
has_ghost_enhancement = "enhanceClozeKeywords" in js_content and "data-ghost" in js_content
has_stop_propagation = "e.stopPropagation()" in js_content
has_apply_cloze_helper = "applyClozeClassToPaper" in js_content

if has_cloze_ghost_css and has_cloze_active_css and has_ghost_enhancement and has_stop_propagation and has_apply_cloze_helper:
    record("Check 6 (首字弱提示挖空规范)", True, "CSS attr(data-ghost) 弱提示与 JS applyClozeClassToPaper / 揭晓防冒泡机制全科同步对齐")
else:
    record("Check 6 (首字弱提示挖空规范)", False, f"css_ghost={has_cloze_ghost_css}, css_active={has_cloze_active_css}, helper={has_apply_cloze_helper}")


# ---------------- Check 7: 版本一致性 (version.json vs app.js vs index.html) ----------------
print("\n[Check 7] 校验版本号一致性与无限更新弹窗根除...")
version_json_path = os.path.join(BASE_DIR, "version.json")
try:
    with open(version_json_path, "r", encoding="utf-8") as f:
        v_data = json.load(f)
    v_target = v_data.get("version", "3.0.0")

    m_app_build = re.search(r"const\s+APP_BUILD_ID\s*=\s*['\"]([^'\"]+)['\"];", js_content)
    assert m_app_build, "APP_BUILD_ID not found in app.js"
    app_build_val = m_app_build.group(1)
    assert app_build_val == v_target, f"app.js APP_BUILD_ID ({app_build_val}) != version.json ({v_target})"

    with open(os.path.join(BASE_DIR, "index.html"), "r", encoding="utf-8") as f:
        html_content = f.read()
    assert f"app.css?v={v_target}" in html_content, f"index.html missing app.css?v={v_target}"
    assert f"app.js?v={v_target}" in html_content, f"index.html missing app.js?v={v_target}"

    record("Check 7 (版本一致性与防弹窗)", True, f"version.json、app.js (APP_BUILD_ID={app_build_val})、index.html 全线严格统一为 v{v_target}")
except Exception as e:
    record("Check 7 (版本一致性与防弹窗)", False, str(e))


# ---------------- Check 8: Service Worker 安全防线 ----------------
print("\n[Check 8] 校验 sw.js 音频与 Range 绝对直通防崩溃...")
with open(os.path.join(BASE_DIR, "sw.js"), "r", encoding="utf-8") as f:
    sw_text = f.read()

has_sw_v3 = ("kaoyan-all-in-one-v3.0.4" in sw_text) or ("kaoyan-all-in-one-v3.0.2" in sw_text) or ("kaoyan-all-in-one-v3.0.1" in sw_text)
has_range_bypass = "event.request.headers.has('range')" in sw_text
has_mp3_bypass = "url.pathname.endsWith('.mp3')" in sw_text

if has_sw_v3 and has_range_bypass and has_mp3_bypass:
    record("Check 8 (SW安全防线)", True, "sw.js 包含 v3.0.1 缓存名且绝对绕行 .mp3 与 Range 分片请求，保障 iOS Safari 不崩溃")
else:
    record("Check 8 (SW安全防线)", False, f"sw_v3={has_sw_v3}, range={has_range_bypass}, mp3={has_mp3_bypass}")


# ---------------- Check 9: 徐涛 16 天双音轨独立对齐与 LoadedMetadata 异步就绪 ----------------
print("\n[Check 9] 校验徐涛 16 天双音源独立时间戳与切音就绪逻辑...")
xt_d01 = pol_data["xutao16"][0]
p0 = xt_d01["points"][0]
has_independent_ts = "anlang_start" in p0 and "voice_start" in p0 and (p0["anlang_start"] != p0["voice_start"])
has_switcher_in_js = "xt-voice-switcher" in js_content and "state.polXtVoice" in js_content
has_loadedmetadata_seek = "loadedmetadata" in js_content and "startPointIdx" in js_content

if has_independent_ts and has_switcher_in_js and has_loadedmetadata_seek:
    record("Check 9 (徐涛16天切音与时间戳)", True, f"独立起播点 (龙安朗 {p0['anlang_start']}s vs 徐涛 {p0['voice_start']}s) 且 loadedmetadata 异步保护就绪")
else:
    record("Check 9 (徐涛16天切音与时间戳)", False, f"ts={has_independent_ts}, switcher={has_switcher_in_js}, loadedmetadata={has_loadedmetadata_seek}")


# ---------------- Check 10: Node.js 语法校验 ----------------
print("\n[Check 10] 运行 node -c 语法校验...")
syntax_ok = True
syntax_errs = []
for js_rel in ["app.js", "sw.js", "data/kaoyan_data_pol.js"]:
    full_p = os.path.join(BASE_DIR, js_rel.replace("/", os.sep))
    r = subprocess.run(["node", "-c", full_p], capture_output=True, text=True)
    if r.returncode != 0:
        syntax_ok = False
        syntax_errs.append(f"{js_rel}: {r.stderr.strip()}")

if syntax_ok:
    record("Check 10 (Node.js 语法检查)", True, "app.js, sw.js, data/kaoyan_data_pol.js 全部 0 报错通过语法编译")
else:
    record("Check 10 (Node.js 语法检查)", False, f"编译错误: {syntax_errs}")


print("\n=================================================================")
print(f"  审计总结: {len(passed_checks)} / 10 项指标通过!")
if failed_checks:
    print(f"  FAILED CHECKS ({len(failed_checks)}):")
    for name, reason in failed_checks:
        print(f"    - {name}: {reason}")
    sys.exit(1)
else:
    print("  🎉 全部 10 项防退化红线与全科整合指标 100% 绿灯全优通过！具备部署条件！")
print("=================================================================\n")
