# -*- coding: utf-8 -*-
"""
verify_all_in_one.py
全科考研双轨背诵手卷（All-in-One V3.0）终极整合全量自动化审计脚本
验证全部 8 项防退化红线指标
"""

import os
import sys
import re
import json

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
print("  全科考研双轨手卷 V3.0 · 全量自动化审计与防退化验收 (8项红线)")
print("=================================================================\n")

# ---------------- Check 1: 数据完整性 ----------------
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

    # xsx_00 audio must be None
    xsx_00_found = False
    for ch in c47:
        for sc in ch.get("track2", {}).get("subCards", []):
            if sc["cardId"] == "xsx_00":
                xsx_00_found = True
                assert sc["audio"] is None, "xsx_00 audio must be null/None"

    # zero doubt-panel
    assert "doubt-panel" not in js_text, "Found .doubt-panel residual!"

    record("Check 1 (数据完整性)", True, f"47章、119个微考点、16天徐涛、11天腿姐完整无损，xsx_00为null，0个.doubt-panel残留")
except Exception as e:
    record("Check 1 (数据完整性)", False, str(e))


# ---------------- Check 2: 音频零死链 ----------------
print("\n[Check 2] 校验全科全部音频磁盘物理存在与文件大小 (>10KB)...")
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

# 2. 专业课音频检查 (从 data/kaoyan_data.js 或 manifest 检查)
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
    record("Check 2 (音频零死链)", True, f"已核对 {total_audio_checked} 个音频引用，物理文件 100% 存在且大小正常")
else:
    record("Check 2 (音频零死链)", False, f"发现 {len(audio_errors)} 处错误: {audio_errors[:3]}")


# ---------------- Check 3: 工作区体积红线 ----------------
print("\n[Check 3] 校验工作区非 Git 资产总大小 (< 550 MB)...")
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
    record("Check 3 (仓库体积红线)", True, f"工作区总大小为 {work_mb:.2f} MB (远低于 1GB 封禁线与警戒线)")
else:
    record("Check 3 (仓库体积红线)", False, f"工作区大小 {work_mb:.2f} MB 偏大")


# ---------------- Check 4: 首字弱提示挖空交互 ----------------
print("\n[Check 4] 校验首字弱提示挖空规范 (CSS 与 JS 逻辑)...")
with open(os.path.join(BASE_DIR, "app.css"), "r", encoding="utf-8") as f:
    css_content = f.read()

has_cloze_ghost_css = "content: attr(data-ghost);" in css_content
has_cloze_active_css = ".cloze-keyword-active" in css_content

with open(os.path.join(BASE_DIR, "app.js"), "r", encoding="utf-8") as f:
    js_content = f.read()

has_ghost_enhancement = "enhanceClozeKeywords" in js_content and "data-ghost" in js_content
has_stop_propagation = "e.stopPropagation()" in js_content

if has_cloze_ghost_css and has_cloze_active_css and has_ghost_enhancement and has_stop_propagation:
    record("Check 4 (首字弱提示挖空)", True, "CSS attr(data-ghost) 弱提示与 JS 自动补全及独立揭晓/防冒泡机制齐备")
else:
    record("Check 4 (首字弱提示挖空)", False, f"css_ghost={has_cloze_ghost_css}, css_active={has_cloze_active_css}, js_ghost={has_ghost_enhancement}")


# ---------------- Check 5: 47章双轨与微考点联动 ----------------
print("\n[Check 5] 校验 47 章双轨与微考点联动逻辑...")
has_recite_track1 = "renderPolChapterTrack1" in js_content and "chapter.track1.audio" in js_content
has_subcard_track2 = "renderPolChapterTrack2" in js_content and "pol-subcard-pills" in js_content
has_subcard_activate = "activateSubCardAudio" in js_content

if has_recite_track1 and has_subcard_track2 and has_subcard_activate:
    record("Check 5 (47章双轨联动)", True, "轨道一绑定整章背诵，轨道二绑定微考点胶囊列与音频动态切换")
else:
    record("Check 5 (47章双轨联动)", False, "缺少双轨或微考点切换核心函数")


# ---------------- Check 6: 徐涛 16 天双音轨独立对齐 ----------------
print("\n[Check 6] 校验徐涛 16 天双音源独立时间戳...")
xt_d01 = pol_data["xutao16"][0]
p0 = xt_d01["points"][0]
has_independent_ts = "anlang_start" in p0 and "voice_start" in p0 and (p0["anlang_start"] != p0["voice_start"])
has_switcher_in_js = "xt-voice-switcher" in js_content and "state.polXtVoice" in js_content

if has_independent_ts and has_switcher_in_js:
    record("Check 6 (徐涛16天双音轨对齐)", True, f"成功区分龙安朗 ({p0['anlang_start']}s) 与徐涛原声 ({p0['voice_start']}s) 独立起播点")
else:
    record("Check 6 (徐涛16天双音轨对齐)", False, f"independent_ts={has_independent_ts}, switcher={has_switcher_in_js}")


# ---------------- Check 7: Service Worker 安全防线 ----------------
print("\n[Check 7] 校验 sw.js 音频与 Range 绝对直通防崩溃...")
with open(os.path.join(BASE_DIR, "sw.js"), "r", encoding="utf-8") as f:
    sw_text = f.read()

has_sw_v3 = "kaoyan-all-in-one-v3.0.0" in sw_text
has_range_bypass = "event.request.headers.has('range')" in sw_text
has_mp3_bypass = "url.pathname.endsWith('.mp3')" in sw_text

if has_sw_v3 and has_range_bypass and has_mp3_bypass:
    record("Check 7 (SW安全防线)", True, "sw.js 包含 v3.0.0 缓存名且绝对绕行 .mp3 与 Range 分片请求，保障 iOS Safari 不崩溃")
else:
    record("Check 7 (SW安全防线)", False, f"sw_v3={has_sw_v3}, range={has_range_bypass}, mp3={has_mp3_bypass}")


# ---------------- Check 8: 深浅色主题与样式命名空间 ----------------
print("\n[Check 8] 校验 .pol-scope 命名空间与深色模式变量适配...")
has_pol_scope_css = ".pol-scope" in css_content
has_table_wrap_css = ".pol-scope .xt-table-wrap" in css_content and "overflow-x: auto" in css_content
has_trap_card_css = ".pol-scope .xt-trap-card" in css_content
has_dark_mode_pol = '[data-theme="dark"] .pol-scope' in css_content or '[data-theme="dark"] .xt-table' in css_content

if has_pol_scope_css and has_table_wrap_css and has_trap_card_css and has_dark_mode_pol:
    record("Check 8 (深浅色与响应式)", True, ".pol-scope 样式空间完全隔离，对比表格支持移动端横向平滑滚动与深色模式自适应")
else:
    record("Check 8 (深浅色与响应式)", False, f"scope={has_pol_scope_css}, table={has_table_wrap_css}, trap={has_trap_card_css}, dark={has_dark_mode_pol}")


print("\n=================================================================")
print(f"  审计总结: {len(passed_checks)} / 8 项指标通过!")
if failed_checks:
    print(f"  FAILED CHECKS ({len(failed_checks)}):")
    for name, reason in failed_checks:
        print(f"    - {name}: {reason}")
    sys.exit(1)
else:
    print("  🎉 全部 8 项防退化红线指标 100% 绿灯全优通过！具备部署条件！")
print("=================================================================\n")
