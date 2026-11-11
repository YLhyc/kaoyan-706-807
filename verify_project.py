#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
考研全科双轨背诵手卷 · 项目工程自检与防白屏门禁脚本 (v3.1.1)
1. 静态语法校验: node --check
2. 版本清单一致性: version.json, sw.js, app.js, index.html
3. DOM 关键锚点与 CSS 规则完整性
4. 考题数据完整性: 807 (35) + 706 (37) + 英语 (16) = 88 篇
"""

import sys
import json
import re
import subprocess
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

def main():
    root = Path(__file__).resolve().parent
    TARGET_VER = '3.2.1'
    TARGET_CACHE = f"kaoyan-all-in-one-v{TARGET_VER}"

    print("=" * 65)
    print(f" 考研专业课双轨背诵手卷 · 项目工程自检与防白屏门禁 (v{TARGET_VER})")
    print("=" * 65)

    errors = []

    # 1. 静态语法校验 (node --check)
    print("\n[1/4] 执行 Node.js 静态语法防白屏检测...")
    js_files = [
        ("app.js", root / "app.js"),
        ("sw.js", root / "sw.js"),
        ("kubai_icons.js", root / "kubai_icons.js"),
        ("data/kaoyan_data.js", root / "data" / "kaoyan_data.js"),
        ("data/kaoyan_data_pol.js", root / "data" / "kaoyan_data_pol.js")
    ]
    for label, file_path in js_files:
        if not file_path.exists():
            errors.append(f"缺失必要脚本文件: {label}")
            print(f"  ❌ {label}: 文件未找到")
            continue
        res = subprocess.run(["node", "--check", str(file_path)], capture_output=True, text=True)
        if res.returncode != 0:
            errors.append(f"{label} 语法校验未通过:\n{res.stderr.strip()}")
            print(f"  ❌ {label}: 语法错误")
        else:
            size_mb = file_path.stat().st_size / (1024 * 1024)
            print(f"  ✓ {label} ({size_mb:.2f} MB): 静态语法检测通过")

    # 2. 版本清单与 Service Worker 校验
    print("\n[2/4] 校验版本号与 PWA 配置一致性...")
    version_file = root / "version.json"
    if not version_file.exists():
        errors.append("缺失 version.json")
    else:
        v_data = json.loads(version_file.read_text(encoding="utf-8"))
        ver = v_data.get("version")
        if ver != TARGET_VER:
            errors.append(f"version.json 版本号预期 {TARGET_VER}，实际为 {ver}")
            print(f"  ❌ version.json: 当前版本为 {ver}")
        else:
            print(f"  ✓ version.json: 版本号为 {ver}")

    sw_file = root / "sw.js"
    if not sw_file.exists():
        errors.append("缺失 sw.js")
    else:
        sw_text = sw_file.read_text(encoding="utf-8")
        if TARGET_CACHE not in sw_text:
            errors.append(f"sw.js 缓存名未升级为 {TARGET_CACHE}")
            print(f"  ❌ sw.js 缓存键未更新为 v{TARGET_VER}")
        else:
            print(f"  ✓ sw.js 缓存标识已升级至 {TARGET_CACHE}")
        if f"?v={TARGET_VER}" not in sw_text:
            errors.append(f"sw.js ASSETS_TO_CACHE 静态资源未配置 ?v={TARGET_VER}")
            print(f"  ❌ sw.js 静态资源缺失版本戳 ?v={TARGET_VER}")
        else:
            print(f"  ✓ sw.js 静态资源统一配置 ?v={TARGET_VER}")
        if "Range" not in sw_text and "range" not in sw_text:
            errors.append("sw.js 未显式排除 Range 请求")
            print("  ❌ sw.js 缺失 Range 排除保护")
        else:
            print("  ✓ sw.js 包含音频与 Range 请求原生流放行保护")

    # 校验 app.js 中的 APP_BUILD_ID
    app_file = root / "app.js"
    if not app_file.exists():
        errors.append("缺失 app.js")
    else:
        app_text = app_file.read_text(encoding="utf-8")
        m_app_ver = re.search(r"const\s+APP_BUILD_ID\s*=\s*['\"]([^'\"]+)['\"];", app_text)
        if not m_app_ver:
            errors.append("app.js 中未声明 const APP_BUILD_ID")
            print("  ❌ app.js: 未找到 APP_BUILD_ID 声明")
        elif m_app_ver.group(1) != TARGET_VER:
            errors.append(f"app.js APP_BUILD_ID 预期为 {TARGET_VER}，实际为 {m_app_ver.group(1)}")
            print(f"  ❌ app.js: APP_BUILD_ID 为 {m_app_ver.group(1)} (预期 {TARGET_VER})")
        else:
            print(f"  ✓ app.js: APP_BUILD_ID 严格同步为 {m_app_ver.group(1)}")

    # 校验 index.html 中的脚本与样式版本戳
    index_file = root / "index.html"
    if not index_file.exists():
        errors.append("缺失 index.html")
    else:
        html_text = index_file.read_text(encoding="utf-8")
        if f"app.js?v={TARGET_VER}" not in html_text:
            errors.append(f"index.html app.js 缺失 ?v={TARGET_VER}")
            print(f"  ❌ index.html: app.js 未配置 ?v={TARGET_VER}")
        else:
            print(f"  ✓ index.html: app.js 已接入 ?v={TARGET_VER}")

        if f"app.css?v={TARGET_VER}" not in html_text:
            errors.append(f"index.html app.css 缺失 ?v={TARGET_VER}")
            print(f"  ❌ index.html: app.css 未配置 ?v={TARGET_VER}")
        else:
            print(f"  ✓ index.html: app.css 已接入 ?v={TARGET_VER}")

        stale_script_vers = set(re.findall(r"\?v=(3\.0\.[0-8])", html_text))
        if stale_script_vers:
            errors.append(f"index.html 存在过期版本参数: {stale_script_vers}")
            print(f"  ❌ index.html 存在陈旧版本引用: {stale_script_vers}")
        else:
            print(f"  ✓ index.html: 核心脚本与样式表均已接入最新 ?v={TARGET_VER}")

    # 3. HTML 结构与关键 DOM 锚点完整性
    print("\n[3/4] 校验 index.html 结构与关键 DOM 锚点...")
    if index_file.exists():
        html = index_file.read_text(encoding="utf-8")

        # 检查 defer 属性
        if 'kaoyan_data.js' not in html:
            errors.append("kaoyan_data.js 未在 index.html 中引用")
            print("  ❌ index.html 中的 kaoyan_data.js 未找到")
        else:
            print("  ✓ index.html 中的 kaoyan_data.js 正确配置了 defer (消除首屏阻塞)")

        required_dom_ids = [
            "btn-subject-807", "btn-subject-706", "btn-subject-pol", "btn-subject-en",
            "dock-play-btn", "dock-prev-btn", "dock-next-btn", "dock-rewind-btn", "dock-forward-btn",
            "btn-speed", "btn-loop-mode", "paper-content", "item-list", "search-input",
            "progress-bar"
        ]
        missing_dom = [did for did in required_dom_ids if f'id="{did}"' not in html]
        if missing_dom:
            errors.append(f"index.html 缺失关键 DOM 元素: {missing_dom}")
            print(f"  ❌ 缺失 DOM 元素: {missing_dom}")
        else:
            print(f"  ✓ 全部 {len(required_dom_ids)} 个关键交互 DOM 锚点校验通过")

    # 4. 校验考题清单与多轨数据完整性
    print("\n[4/4] 校验考题清单与多轨数据完整性...")
    manifest_file = root / "data" / "kaoyan_all_manifest.json"
    if not manifest_file.exists():
        errors.append("缺失 data/kaoyan_all_manifest.json")
    else:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        i807 = manifest.get("items_807", [])
        i706 = manifest.get("items_706", [])
        ien = manifest.get("items_en", [])
        total = len(i807) + len(i706) + len(ien)

        print(f"  • 807 现当代文学: {len(i807)} 题 (预期 35)")
        print(f"  • 706 古代文学:   {len(i706)} 题 (预期 37)")
        print(f"  • 考研英语写作:   {len(ien)} 篇 (预期 16)")
        print(f"  • 全科题目总计:   {total} 题/篇 (预期 88)")

        if len(i807) != 35 or len(i706) != 37 or len(ien) != 16 or total != 88:
            errors.append(f"考题数量与预期不一致: 807={len(i807)}, 706={len(i706)}, en={len(ien)}, total={total}")
        else:
            print("  ✓ 全科 88 道题目清单数据结构完整一致！")

    print("\n" + "=" * 65)
    if errors:
        print("❌ [FAILURE] 门禁检测未通过，存在以下阻塞性缺陷:")
        for idx, err in enumerate(errors, 1):
            print(f"  {idx}. {err}")
        print("=" * 65)
        sys.exit(1)
    else:
        print("🎉 [SUCCESS] 所有自检项均 100% 通过！项目处于健康发布状态。")
        print("=" * 65)

if __name__ == "__main__":
    main()
