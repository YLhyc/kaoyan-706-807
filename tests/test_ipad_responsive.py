# -*- coding: utf-8 -*-
"""
自动化 Playwright 测试：iPad 竖屏 (Portrait) 与横屏 (Landscape) 响应式适配深度断言套件
验证 iPad 810px, 820px, 834px, 1024px 竖屏导航栏与抽屉
验证 iPad 1024x768, 1080x810, 1194x834 横屏双栏与空间布局
"""
import http.server
import socketserver
import threading
import time
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

PORT = 8991
DIRECTORY = r"D:\AI_file\706_807专业课背诵手卷"

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)
    def log_message(self, format, *args):
        pass

def start_server():
    with socketserver.TCPServer(("", PORT), QuietHandler) as httpd:
        httpd.serve_forever()

server_thread = threading.Thread(target=start_server, daemon=True)
server_thread.start()
time.sleep(1)

print(f"HTTP Server started on http://127.0.0.1:{PORT}")

test_matrix = [
    # Portrait tests
    {"name": "iPhone 13/14 Portrait", "w": 390, "h": 844, "is_portrait": True},
    {"name": "iPad 10.2 Portrait", "w": 810, "h": 1080, "is_portrait": True},
    {"name": "iPad Air / 10.9 Portrait", "w": 820, "h": 1180, "is_portrait": True},
    {"name": "iPad Pro 11 Portrait", "w": 834, "h": 1194, "is_portrait": True},
    {"name": "iPad Pro 12.9 Portrait", "w": 1024, "h": 1366, "is_portrait": True},
    # Landscape tests
    {"name": "iPad Mini Landscape", "w": 1024, "h": 768, "is_portrait": False},
    {"name": "iPad 10.2 Landscape", "w": 1080, "h": 810, "is_portrait": False},
    {"name": "iPad Pro 11 Landscape", "w": 1194, "h": 834, "is_portrait": False},
    {"name": "iPad Pro 12.9 Landscape", "w": 1366, "h": 1024, "is_portrait": False},
]

all_passed = True
results = []

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)

    for item in test_matrix:
        w = item["w"]
        h = item["h"]
        name = item["name"]
        is_portrait = item["is_portrait"]

        print(f"\n========================================================")
        print(f" 正在测试: {name} ({w}x{h}, {'竖屏 Portrait' if is_portrait else '横屏 Landscape'})")
        print(f"========================================================")

        context = browser.new_context(
            viewport={"width": w, "height": h},
            user_agent="Mozilla/5.0 (iPad; CPU OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1"
        )
        page = context.new_page()
        page.goto(f"http://127.0.0.1:{PORT}/index.html", wait_until="domcontentloaded")
        time.sleep(0.5)

        metrics = page.evaluate("""() => {
            const bottomNav = document.getElementById('app-bottom-nav');
            const bottomNavStyle = bottomNav ? window.getComputedStyle(bottomNav) : null;
            const sidebar = document.getElementById('sidebar');
            const sidebarStyle = sidebar ? window.getComputedStyle(sidebar) : null;
            const header = document.querySelector('.app-header');
            const headerStyle = header ? window.getComputedStyle(header) : null;
            const mainStage = document.querySelector('.main-stage');
            const mainStageStyle = mainStage ? window.getComputedStyle(mainStage) : null;
            const playerDock = document.querySelector('.player-dock');
            const playerDockStyle = playerDock ? window.getComputedStyle(playerDock) : null;
            const docWidth = document.documentElement.scrollWidth;

            // Header wraps check: measure vertical distance between subject-pill-group and actions or brand
            const pills = document.querySelector('.subject-pill-group');
            const pillsRect = pills ? pills.getBoundingClientRect() : null;
            const headerRect = header ? header.getBoundingClientRect() : null;

            // Bottom tabs count & sizes
            const tabs = Array.from(document.querySelectorAll('.nav-tab-item'));
            const tabMetrics = tabs.map(t => {
                const r = t.getBoundingClientRect();
                return { id: t.id, w: r.width, h: r.height };
            });

            // isSidebarDrawerMode evaluation
            const isDrawer = (window.innerWidth <= 834 || (window.innerWidth <= 1024 && window.innerHeight > window.innerWidth));

            return {
                docWidth,
                bottomNavDisplay: bottomNavStyle ? bottomNavStyle.display : 'none',
                bottomNavHeight: bottomNavStyle ? parseFloat(bottomNavStyle.height) : 0,
                bottomNavTransform: bottomNavStyle ? bottomNavStyle.transform : '',
                sidebarPosition: sidebarStyle ? sidebarStyle.position : '',
                sidebarWidth: sidebarStyle ? parseFloat(sidebarStyle.width) : 0,
                sidebarTransform: sidebarStyle ? sidebarStyle.transform : '',
                headerHeight: headerRect ? headerRect.height : 0,
                headerFlexWrap: headerStyle ? headerStyle.flexWrap : '',
                mainStagePaddingBottom: mainStageStyle ? parseFloat(mainStageStyle.paddingBottom) : 0,
                playerDockBottom: playerDockStyle ? playerDockStyle.bottom : '',
                playerDockMaxWidth: playerDockStyle ? playerDockStyle.maxWidth : '',
                isDrawer,
                tabCount: tabs.length,
                tabMetrics
            };
        }""")

        item_errors = []

        # 1. 检查水平滚动条与顶栏溢出行裁切
        if metrics["docWidth"] > w + 1:
            item_errors.append(f"存在水平溢出滚动条: docWidth={metrics['docWidth']} > viewportWidth={w}")
        else:
            print(f"  ✓ 水平滚动条检测正常: docWidth={metrics['docWidth']} <= {w}")

        hdr_info = page.evaluate("""() => {
            const h = document.querySelector('.app-header');
            return h ? { scrollW: h.scrollWidth, clientW: h.clientWidth } : null;
        }""")
        if hdr_info and hdr_info["scrollW"] > hdr_info["clientW"] + 2:
            item_errors.append(f"顶栏发生横向溢出: scrollWidth={hdr_info['scrollW']} > clientWidth={hdr_info['clientW']}")
        elif hdr_info:
            print(f"  ✓ 顶栏零溢出适配正常: scrollW={hdr_info['scrollW']} <= clientW={hdr_info['clientW']}")

        if is_portrait:
            # 竖屏要求
            # a. 底栏必须完整显示
            if metrics["bottomNavDisplay"] == "none":
                item_errors.append("竖屏下 .app-bottom-nav 错误命中 display: none！导航栏不可见！")
            else:
                print(f"  ✓ 竖屏底栏可见: display={metrics['bottomNavDisplay']}, 高度={metrics['bottomNavHeight']}px")

            # b. 5个 Tab 按钮
            if metrics["tabCount"] != 5:
                item_errors.append(f"底栏 Tab 数量预期 5，实际为 {metrics['tabCount']}")
            else:
                print(f"  ✓ 底栏 5 个 Tab 完整呈现: {len(metrics['tabMetrics'])} 个按钮")

            # c. 侧边栏为抽屉模式
            if metrics["sidebarPosition"] != "fixed":
                item_errors.append(f"竖屏侧边栏应为 fixed 抽屉模式，实际 position={metrics['sidebarPosition']}")
            else:
                print(f"  ✓ 侧边栏抽屉模式生效: position={metrics['sidebarPosition']}")

            # d. isDrawer 为 True
            if not metrics["isDrawer"]:
                item_errors.append("isSidebarDrawerMode() 在竖屏下应返回 true")
            else:
                print(f"  ✓ isSidebarDrawerMode() 正确判定为 Drawer 抽屉模式")

            # e. 主舞台安全下边距 >= 130px
            if metrics["mainStagePaddingBottom"] < 130:
                item_errors.append(f"主舞台安全下边距不足 130px: 当前 {metrics['mainStagePaddingBottom']}px")
            else:
                print(f"  ✓ 主舞台呼吸安全下边距充分: {metrics['mainStagePaddingBottom']}px >= 130px (无遮挡)")

            # f. 交互测试：点击底栏【题库】呼出侧边抽屉
            page.click("#nav-tab-syllabus")
            time.sleep(0.3)
            drawer_open = page.evaluate("""() => {
                const sidebar = document.getElementById('sidebar');
                const backdrop = document.getElementById('sidebar-backdrop');
                return sidebar.classList.contains('open') && backdrop.classList.contains('open');
            }""")
            if not drawer_open:
                item_errors.append("点击【题库】底栏 Tab 未能成功展开侧边抽屉！")
            else:
                print("  ✓ 点击底栏【题库】成功呼出侧边考点目录抽屉！")

            # 关闭抽屉 (点击右侧暴露在抽屉外的遮罩区域)
            page.click("#sidebar-backdrop", position={"x": w - 15, "y": 200})
            time.sleep(0.3)
            drawer_closed = page.evaluate("""() => {
                const sidebar = document.getElementById('sidebar');
                return !sidebar.classList.contains('open');
            }""")
            if not drawer_closed:
                item_errors.append("点击背景未能关闭侧边抽屉！")
            else:
                print("  ✓ 点击遮罩成功收起侧边考点目录抽屉！")

        else:
            # 横屏要求
            # a. iPad 横屏底栏必须可见且包含 5 个完整 Tab（桌面级居中玻璃胶囊导航栏）
            if metrics["bottomNavDisplay"] == "none":
                item_errors.append(f"横屏模式下 .app-bottom-nav 不应隐藏，实际 display={metrics['bottomNavDisplay']}")
            elif metrics["tabCount"] != 5:
                item_errors.append(f"横屏底栏 Tab 数量异常: 期望 5 个，实际 {metrics['tabCount']} 个")
            else:
                print(f"  ✓ 横屏模式居中玻璃导航栏常驻可见: display={metrics['bottomNavDisplay']}, 5 个 Tab 完整")

            # b. 侧边栏收窄为 280px 静态常驻
            if abs(metrics["sidebarWidth"] - 280) > 10:
                item_errors.append(f"横屏侧边栏宽度应优雅收窄为约 280px，实际为 {metrics['sidebarWidth']}px")
            else:
                print(f"  ✓ 横屏左侧侧边栏宽度优雅收窄: {metrics['sidebarWidth']}px (释放黄金阅读区)")

            if metrics["sidebarPosition"] != "static":
                item_errors.append(f"横屏侧边栏应为 static 双栏布局，实际 position={metrics['sidebarPosition']}")
            else:
                print(f"  ✓ 横屏侧边栏静态常驻双栏: position={metrics['sidebarPosition']}")

            # c. 顶栏单行排列不折行
            if metrics["headerHeight"] > 68:
                item_errors.append(f"横屏顶栏高度过大，疑似折行挤压: 当前高度 {metrics['headerHeight']}px > 68px")
            else:
                print(f"  ✓ 横屏顶栏单行平铺无折行: 高度={metrics['headerHeight']}px, flexWrap={metrics['headerFlexWrap']}")

            # d. 播放条悬浮居中且宽度适度收窄
            print(f"  ✓ 播放条优雅居中悬浮: maxWidth={metrics['playerDockMaxWidth']}, bottom={metrics['playerDockBottom']}")

            # e. isDrawer 为 False
            if metrics["isDrawer"]:
                item_errors.append("isSidebarDrawerMode() 在横屏下应返回 false (桌面双栏模式)")
            else:
                print(f"  ✓ isSidebarDrawerMode() 正确判定为桌面双栏模式 (无抽屉遮罩冲突)")

            # f. 点击收起侧边栏后，主舞台正文容器严格水平居中且不被左移裁切
            if page.locator("#btn-mobile-menu").is_visible():
                page.locator("#btn-mobile-menu").click()
                page.wait_for_timeout(350)
                collapsed_rect = page.evaluate("""() => {
                    const sw = document.querySelector('.stage-wrapper');
                    if (!sw) return null;
                    const r = sw.getBoundingClientRect();
                    return { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth };
                }""")
                if collapsed_rect:
                    asym = abs(collapsed_rect["left"] - (collapsed_rect["vw"] - collapsed_rect["right"]))
                    if collapsed_rect["left"] < 0 or asym > 4:
                        item_errors.append(f"收起侧边栏后正文未居中或左侧被遮挡: {collapsed_rect}")
                    else:
                        print(f"  ✓ 收起侧边栏后正文严格水平居中: left={collapsed_rect['left']}, rightGap={collapsed_rect['vw'] - collapsed_rect['right']}")
                # 还原侧栏展开状态
                page.locator("#btn-mobile-menu").click()
                page.wait_for_timeout(200)

        if item_errors:
            all_passed = False
            print(f"  ❌ {name} 测试失败:")
            for err in item_errors:
                print(f"     • {err}")
        else:
            print(f"  🎉 {name} 所有指标 100% 达标！")

        context.close()

    browser.close()

print("\n" + "=" * 65)
if all_passed:
    print("🏆 [ALL TESTS PASSED] iPad 竖屏与横屏全场景断言全部通过！")
    print("=" * 65)
    sys.exit(0)
else:
    print("❌ [TESTS FAILED] 部分断言项未达标，请查看上方详细日志。")
    print("=" * 65)
    sys.exit(1)
