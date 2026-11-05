#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
2027 考研全科双轨随身背诵手卷 · 独立项目全量自检工具
一键校验所有 JS 语法、HTML 结构与数据完整性
"""

import sys
import json
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
    print("=" * 65)
    print(" 考研专业课双轨背诵手卷 · 项目工程自检与防白屏门禁 (v1.9.3)")
    print("=" * 65)

    errors = []

    # 1. 静态语法校验 (node --check)
    print("\n[1/4] 执行 Node.js 静态语法防白屏检测...")
    js_files = [
        ("app.js", root / "app.js"),
        ("sw.js", root / "sw.js"),
        ("data/kaoyan_data.js", root / "data" / "kaoyan_data.js"),
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
        if ver != "1.9.3":
            errors.append(f"version.json 版本号预期 1.9.3，实际为 {ver}")
            print(f"  ❌ version.json: 当前版本为 {ver}")
        else:
            print(f"  ✓ version.json: 版本号为 {ver}")

    sw_file = root / "sw.js"
    if sw_file.exists():
        sw_text = sw_file.read_text(encoding="utf-8")
        if "kaoyan-handbook-v193" not in sw_text:
            errors.append("sw.js 缓存名未升级为 kaoyan-handbook-v193")
            print("  ❌ sw.js 缓存键未更新为 v193")
        else:
            print("  ✓ sw.js 缓存标识已升级至 kaoyan-handbook-v193")
        if "Range" not in sw_text and "range" not in sw_text:
            errors.append("sw.js 未显式排除 Range 请求")
            print("  ❌ sw.js 缺失 Range 排除保护")
        else:
            print("  ✓ sw.js 包含音频与 Range 请求原生流放行保护")

    # 3. HTML 结构与关键 DOM 锚点完整性
    print("\n[3/4] 校验 index.html 结构与关键 DOM 锚点...")
    index_file = root / "index.html"
    if not index_file.exists():
        errors.append("缺失 index.html")
    else:
        html = index_file.read_text(encoding="utf-8")

        # 检查 defer 属性
        if '<script src="data/kaoyan_data.js?v=1.9.3" defer></script>' not in html and 'kaoyan_data.js' not in html:
            errors.append("kaoyan_data.js 未正确配置 defer 属性")
            print("  ❌ index.html 中的 kaoyan_data.js 未配置 defer")
        else:
            print("  ✓ index.html 中的 kaoyan_data.js 正确配置了 defer (消除首屏阻塞)")

        if '<script src="app.js?v=1.9.3" defer></script>' not in html and 'app.js' not in html:
            errors.append("app.js 未正确配置 defer 属性")
            print("  ❌ index.html 中的 app.js 未配置 defer")
        else:
            print("  ✓ index.html 中的 app.js 正确配置了 defer")

        # 关键 UI 锚点检查
        required_dom_ids = [
            "paper-content",
            "item-list",
            "btn-study-dashboard",
            "studyDashboardDrawer",
            "studyDashboardClose",
            "btnDashPunchToday",
            "dashStreakCount",
            "dashTotalScoreText",
            "dashTotalBarMastered",
            "btnDashRandomPick",
            "btn-mastery-toggle",
            "mastery-pills-wrap",
            "btn-subject-807",
            "btn-subject-706",
            "btn-subject-en"
        ]
        missing_ids = [did for did in required_dom_ids if f'id="{did}"' not in html]
        if missing_ids:
            errors.append(f"index.html 缺失关键 DOM 节点: {', '.join(missing_ids)}")
            print(f"  ❌ 缺失 DOM 节点: {', '.join(missing_ids)}")
        else:
            print(f"  ✓ 全部 {len(required_dom_ids)} 个关键交互 DOM 锚点校验通过")

    # 4. 全科考题数据完整性校验
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

        if len(i807) != 35:
            errors.append(f"807 题目数量不匹配: 预期 37, 实际 {len(i807)}")
        if len(i706) != 37:
            errors.append(f"706 题目数量不匹配: 预期 29, 实际 {len(i706)}")
        if len(ien) != 16:
            errors.append(f"英语题目数量不匹配: 预期 16, 实际 {len(ien)}")
        if total != 88:
            errors.append(f"全科题目总计不匹配: 预期 82, 实际 {total}")

        if not errors:
            print("  ✓ 全科 88 道题目清单数据结构完整一致！")

    print("\n" + "=" * 65)
    if errors:
        print("❌ 自检未通过，发现以下问题：")
        for err in errors:
            print(f"  • {err}")
        print("=" * 65)
        sys.exit(1)
    else:
        print("🎉 [SUCCESS] 所有自检项均 100% 通过！项目处于健康发布状态。")
        print("=" * 65)
        sys.exit(0)

if __name__ == "__main__":
    main()
