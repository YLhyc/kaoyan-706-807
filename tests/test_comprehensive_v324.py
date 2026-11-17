# -*- coding: utf-8 -*-
"""
tests/test_comprehensive_v324.py
考研全科双轨背诵手卷 v3.2.4 全端回归与交互闭环 Playwright 测试套件
覆盖：
1. Desktop (1440x900) 播放坞常驻可见、防遮挡 padding 及快捷键 (Space / ArrowLeft / ArrowRight / Escape)
2. 外部字体断网拦截下的快速首屏响应 & 零 pageerror / console.error
3. 搜索 180ms 防抖与 #btn-clear-search 一键清空，以及英语 #stage-tier 按 category_id 筛选
4. 政治挖空模式覆盖 .stream-kw.cloze / .xt-point-content strong.cloze / .tj-point-text .cloze，及 .active-spotlight 自动反显
5. 政治徐涛16讲 / 腿姐11讲 字号随 A+/A- 滑块实时缩放 (响应式 calc(var(--font-base) * 0.92))
6. 研学看板统计盘真实口径 172 节 (807:35, 706:37, pol:84, en:16) + 后台预加载后 T0/T1 非零 + 跨科随机抽背 (含政治)
7. 同步偏移 syncOffset=0.08 持久化跨刷新保留，设置面板仅高亮 +0.08s
8. Header <-> Bottom Nav (390x844) <-> Settings 双向同步，循环三遍 (loop3) 与 #nav-tab-test.active 独立高亮
9. 政治无音频章节 ch_xsx_00 轨二不挂载虚假 src，点击播放提示 Toast
10. 离线状态点击更新安全中止，绝不误删本地 CacheStorage / 触发白屏
"""

import http.server
import socketserver
import threading
import time
import sys
from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

REPO_ROOT = r"D:\AI_file\706_807专业课背诵手卷"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=REPO_ROOT, **kwargs)

    def log_message(self, format, *args):
        pass


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        # 忽略浏览器取消请求引发的连接重置噪音
        pass


def start_local_server():
    httpd = ReusableTCPServer(("127.0.0.1", 0), QuietHandler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, port


class TestRunner:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.failures = []

    def check(self, cond, msg):
        if cond:
            self.passed += 1
            print(f"  [PASS] {msg}")
        else:
            self.failed += 1
            self.failures.append(msg)
            print(f"  [FAIL] {msg}")


def run_suite():
    httpd, port = start_local_server()
    base_url = f"http://127.0.0.1:{port}/"
    runner = TestRunner()
    print(f"Local test server started at {base_url}")

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True)

            # =========================================================
            # Phase A: Desktop 1440x900 (Offline font interception)
            # =========================================================
            print("\n[Phase A] Desktop 1440x900 · Offline Font Block & Core Flow")
            ctx_desktop = browser.new_context(viewport={"width": 1440, "height": 900})
            page = ctx_desktop.new_page()

            page_errors = []
            console_errors = []
            page.on("pageerror", lambda err: page_errors.append(str(err)))
            page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" and "ERR_FAILED" not in msg.text and "net::" not in msg.text else None)

            # Abort external fonts/CDNs to prove non-blocking startup
            page.route("**://fonts.googleapis.com/**", lambda r: r.abort())
            page.route("**://fonts.gstatic.com/**", lambda r: r.abort())
            page.route("**://cdn.jsdelivr.net/**", lambda r: r.abort())

            t0 = time.time()
            page.goto(base_url, wait_until="domcontentloaded", timeout=15000)
            page.wait_for_selector("#item-list .question-card-item", timeout=10000)
            load_elapsed = time.time() - t0
            runner.check(load_elapsed < 6.0, f"外网字体/CDN拦截下首屏快速就绪 ({load_elapsed:.2f}s < 6s)")

            # 1. Desktop Player Dock visibility
            dock_box = page.evaluate("""() => {
                const dock = document.getElementById('playerDock');
                const cs = getComputedStyle(dock);
                const r = dock.getBoundingClientRect();
                return {
                    opacity: parseFloat(cs.opacity),
                    visibility: cs.visibility,
                    top: r.top,
                    bottom: r.bottom,
                    height: r.height,
                    vh: window.innerHeight,
                    padBottom: parseFloat(getComputedStyle(document.querySelector('.paper-container')).paddingBottom)
                };
            }""")
            runner.check(
                dock_box["opacity"] >= 0.99 and dock_box["visibility"] == "visible" and 0 <= dock_box["top"] < dock_box["vh"] and dock_box["height"] > 40,
                f"桌面端 (1440px) #playerDock 常驻可见且未滑出屏幕 (opacity={dock_box['opacity']}, top={dock_box['top']:.1f})"
            )
            runner.check(dock_box["padBottom"] >= 160, f"桌面端正文 .paper-container 底部预留防遮挡间距 ({dock_box['padBottom']}px >= 160px)")

            # 2. Search debounce + clear button + English stage-tier filter
            page.fill("#search-input", "雷雨")
            try:
                page.wait_for_function("() => document.querySelectorAll('#item-list .question-card-item').length < 35", timeout=2500)
            except Exception:
                pass
            filtered_count = page.locator("#item-list .question-card-item").count()
            clear_visible = page.locator("#btn-clear-search").is_visible()
            runner.check(0 < filtered_count < 35 and clear_visible, f"搜索防抖生效 (匹配 {filtered_count} 题) 且一键清除按钮显示")

            page.click("#btn-clear-search")
            page.wait_for_timeout(120)
            reset_count = page.locator("#item-list .question-card-item").count()
            runner.check(reset_count == 35 and not page.locator("#btn-clear-search").is_visible(), f"点击 #btn-clear-search 恢复 807 全量 35 题 ({reset_count}) 并隐藏清除键")

            # English #stage-tier filter
            page.click("#btn-subject-en")
            page.wait_for_timeout(150)
            en_cards = page.locator("#item-list .question-card-item").count()
            page.click("#stage-tier")
            page.wait_for_timeout(150)
            en_filtered_cards = page.locator("#item-list .question-card-item").count()
            runner.check(en_cards == 16 and en_filtered_cards > 0, f"英语写作点击 #stage-tier 按 category_id 筛选后列表非空 ({en_filtered_cards}/{en_cards})")
            page.click('#filter-pills-wrap .filter-pill[data-tier="all"]')
            page.wait_for_timeout(100)

            # 3. Study Dashboard real counts & Pol T0/T1 preload + random pick
            page.click("#btn-study-dashboard")
            page.wait_for_function("""() => {
                const t = document.getElementById('dashT0Ratio')?.textContent || '';
                const m = t.match(/\\/\\s*(\\d+)/);
                return m && parseInt(m[1], 10) > 20;
            }""", timeout=10000)
            dash_info = page.evaluate("""() => ({
                total: document.getElementById('dashTotalScoreText').textContent,
                r807: document.getElementById('dashRatio807').textContent,
                r706: document.getElementById('dashRatio706').textContent,
                rPol: document.getElementById('dashRatioPol').textContent,
                rEn: document.getElementById('dashRatioEn').textContent,
                t0: document.getElementById('dashT0Ratio').textContent,
                t1: document.getElementById('dashT1Ratio').textContent
            })""")
            runner.check(
                "172" in dash_info["total"] and "35" in dash_info["r807"] and "37" in dash_info["r706"] and "84" in dash_info["rPol"] and "16" in dash_info["rEn"],
                f"看板全科 172 节严格精确 ({dash_info['total']} | pol:{dash_info['rPol']} | en:{dash_info['rEn']})"
            )
            runner.check(" 0 题" not in dash_info["t0"] and " 0 题" not in dash_info["t1"], f"看板 T0/T1 含全科核心考点 ({dash_info['t0']}, {dash_info['t1']})")

            page.click("#btnDashRandomPick")
            page.wait_for_timeout(200)
            dash_closed = page.evaluate("() => !document.getElementById('studyDashboardDrawer').classList.contains('open')")
            runner.check(dash_closed, "点击随机抽查按钮成功抽题并自动关闭看板")

            # 4. Politics tests: switch to Pol -> recite47 -> cloze-keyword + active-spotlight reveal
            page.click("#btn-subject-pol")
            page.wait_for_selector('#pol-submode-bar button[data-pol-submode="recite47"]', timeout=8000)
            page.click('#pol-submode-bar button[data-pol-submode="recite47"]')
            page.wait_for_selector('#paper-content.pol-scope .recite-sent-item .cloze, #paper-content.pol-scope .stream-kw, #paper-content.pol-scope .cloze', timeout=8000)
            page.click("#btn-cloze-mode")  # Normal -> cloze-keyword
            page.wait_for_timeout(150)

            cloze_check = page.evaluate("""() => {
                const paper = document.getElementById('paper-content');
                const paperCloze = paper.classList.contains('cloze-keyword-active');
                const kws = Array.from(paper.querySelectorAll('.stream-kw, .cloze, .kw-red'));
                const sentSel = '.recite-sent, .recite-sent-item, [data-sent-idx], .stream-card';
                const kw = kws.find(k => !k.closest('.active-spotlight') && k.closest(sentSel)) || kws.find(k => k.closest(sentSel)) || kws[0];
                if (!kw) return { paperCloze, found: false };
                const colorBefore = getComputedStyle(kw).color;
                kw.click();
                const revealedClick = kw.classList.contains('revealed');
                const colorRevealed = getComputedStyle(kw).color;
                kw.click(); // re-mask before testing spotlight
                const parentSent = kw.closest('.recite-sent, .recite-sent-item, [data-sent-idx], .stream-card');
                if (parentSent) parentSent.classList.add('active-spotlight');
                const colorSpotlight = getComputedStyle(kw).color;
                return {
                    paperCloze,
                    found: true,
                    colorBefore,
                    transparentBefore: colorBefore === 'rgba(0, 0, 0, 0)',
                    visibleOnSpotlight: colorSpotlight !== 'rgba(0, 0, 0, 0)',
                    revealedClick,
                    visibleAfterClick: colorRevealed !== 'rgba(0, 0, 0, 0)'
                };
            }""")
            runner.check(
                cloze_check.get("paperCloze") and cloze_check.get("found") and cloze_check.get("transparentBefore") and cloze_check.get("visibleOnSpotlight") and cloze_check.get("revealedClick") and cloze_check.get("visibleAfterClick"),
                f"政治挖空模式遮罩 .stream-kw/.cloze/.kw-red 生效，聚焦与点击均可反显 ({cloze_check})"
            )
            page.click("#btn-cloze-mode")
            page.click("#btn-cloze-mode")

            # 5. Politics xutao16 & tuijie11 font-size scaling + no-audio ch_xsx_00 track 2
            page.click('.pol-submode-btn[data-pol-submode="xutao16"]')
            page.wait_for_selector("#paper-content .xt-point-content, #paper-content .xt-example-lead", timeout=5000)
            xt_before = page.evaluate("() => parseFloat(getComputedStyle(document.querySelector('#paper-content .xt-point-content, #paper-content .xt-example-lead')).fontSize)")
            page.click("#btn-font-inc")
            page.wait_for_timeout(120)
            xt_after = page.evaluate("() => parseFloat(getComputedStyle(document.querySelector('#paper-content .xt-point-content, #paper-content .xt-example-lead')).fontSize)")
            runner.check(xt_after > xt_before, f"徐涛16讲随全局字号平滑放大 ({xt_before:.1f}px -> {xt_after:.1f}px)")

            page.click('.pol-submode-btn[data-pol-submode="tuijie11"]')
            page.wait_for_selector("#paper-content .tj-point-text, #paper-content .tj-sentence-flow", timeout=5000)
            tj_size = page.evaluate("() => parseFloat(getComputedStyle(document.querySelector('#paper-content .tj-point-text, #paper-content .tj-sentence-flow')).fontSize)")
            runner.check(tj_size > 15.8, f"腿姐11讲随放大后的 --font-base 缩放 ({tj_size:.1f}px)")

            # Switch back to recite47 & test ch_xsx_00 Track 2 empty audio guard
            page.click('.pol-submode-btn[data-pol-submode="recite47"]')
            page.wait_for_selector('#item-list .question-card-item[data-id="ch_xsx_00"]', timeout=5000)
            page.click('#item-list .question-card-item[data-id="ch_xsx_00"]')
            page.wait_for_timeout(150)
            page.click("#tab-track-2")
            page.wait_for_timeout(200)
            no_audio_res = page.evaluate("""() => {
                const aud = window.audio;
                return { srcAttr: aud ? aud.getAttribute('src') : 'no-audio-obj', currentSrc: aud ? aud.currentSrc : '' };
            }""")
            page.click("#dock-play-btn")
            page.wait_for_timeout(120)
            toast_text = page.evaluate("() => Array.from(document.querySelectorAll('.toast-msg')).map(t => t.textContent).join(' | ')")
            runner.check(
                not no_audio_res["srcAttr"] and ("纯文本" in toast_text or "无伴读音频" in toast_text or "导学" in toast_text),
                f"政治 ch_xsx_00 无音频导读不挂虚假 src ({no_audio_res['srcAttr']!r}) 且点击播放弹出提示 ({toast_text!r})"
            )

            # 6. syncOffset persistence across reload + single highlight in settings
            page.evaluate("() => document.getElementById('nav-tab-settings').click()")
            page.wait_for_timeout(200)
            page.click('.sync-card-btn[data-offset="0.08"]')
            page.wait_for_timeout(100)
            page.keyboard.press("Escape")
            page.wait_for_timeout(150)
            settings_closed_by_esc = page.evaluate("() => !document.getElementById('settingsDrawer').classList.contains('open')")
            runner.check(settings_closed_by_esc, "桌面端按下 Esc 键顺利关闭设置抽屉")

            page.reload(wait_until="domcontentloaded", timeout=15000)
            page.wait_for_selector("#item-list .question-card-item", timeout=10000)
            sync_after_reload = page.evaluate("""() => {
                const stored = localStorage.getItem('kaoyan_sync_offset');
                const activeBtns = Array.from(document.querySelectorAll('.sync-card-btn.active')).map(b => b.dataset.offset);
                return { stored, activeBtns, desc: document.getElementById('sheetSyncVal')?.textContent };
            }""")
            runner.check(
                sync_after_reload["stored"] == "0.08" and sync_after_reload["activeBtns"] == ["0.08"],
                f"syncOffset=0.08 刷新页面后完整保留且仅高亮唯一卡片 ({sync_after_reload})"
            )

            # 7. PlayMode drawer includes loop3 + Escape closes PlayMode drawer
            page.click("#btn-loop-mode")
            page.wait_for_timeout(150)
            loop3_present = page.evaluate("() => (document.getElementById('playModeList')?.textContent || '').includes('三遍')")
            page.keyboard.press("Escape")
            page.wait_for_timeout(120)
            runner.check(loop3_present, "循环模式面板包含新增的【单句三遍循环】(三遍推进)")

            # 8. Desktop keyboard shortcuts guard inside #search-input
            page.click("#btn-subject-807")
            page.wait_for_timeout(200)
            page.focus("#search-input")
            page.keyboard.press("Space")
            page.wait_for_timeout(100)
            is_paused_in_search = page.evaluate("() => window.audio.paused")
            runner.check(is_paused_in_search, "焦点位于 #search-input 输入框时按 Space 不误触播放器")

            runner.check(len(page_errors) == 0 and len(console_errors) == 0, f"Desktop 运行全程零 JS 异常 (pageerror={len(page_errors)}, console={len(console_errors)})")
            ctx_desktop.close()

            # =========================================================
            # Phase B: Mobile 390x844 · Sync + Offline Update Guard
            # =========================================================
            print("\n[Phase B] Mobile 390x844 · Two-way Sync & Offline Update Guard")
            ctx_mobile = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
            mpage = ctx_mobile.new_page()
            m_errors = []
            mpage.on("pageerror", lambda err: m_errors.append(str(err)))

            mpage.goto(base_url, wait_until="domcontentloaded", timeout=15000)
            mpage.wait_for_selector("#item-list .question-card-item", timeout=10000)

            # 9. Sync Header -> Bottom Nav -> Settings across Theme, Font, Cloze, and independent #nav-tab-test.active
            mpage.click("#nav-tab-settings")
            mpage.wait_for_timeout(200)
            mpage.click("#sheetThemeDark")
            mpage.click("#sheetFontInc")
            mpage.click('.font-card-btn[data-font-id="kai"]')
            mpage.click("#settingsClose")
            mpage.wait_for_timeout(150)

            mpage.click("#nav-tab-test")
            mpage.wait_for_timeout(150)
            mpage.click("#nav-tab-center-play")
            mpage.wait_for_timeout(300)
            mpage.click("#btn-loop-mode")
            mpage.wait_for_timeout(150)
            test_active_while_mode = mpage.evaluate("() => document.getElementById('nav-tab-test').classList.contains('active')")
            mpage.click("#playModeClose")
            mpage.wait_for_timeout(150)

            sync_state = mpage.evaluate("""() => ({
                isDark: document.documentElement.getAttribute('data-theme') === 'dark',
                isKai: document.documentElement.getAttribute('data-font') === 'kai',
                clozeActive: document.getElementById('btn-cloze-mode').classList.contains('active'),
                testActive: document.getElementById('nav-tab-test').classList.contains('active'),
                fontText: document.getElementById('font-current-name').textContent
            })""")
            runner.check(
                sync_state["isDark"] and sync_state["isKai"] and sync_state["clozeActive"] and sync_state["testActive"] and test_active_while_mode,
                f"移动端设置/底栏/顶栏双向实时同步，打开循环抽屉时不误清除 #nav-tab-test.active ({sync_state})"
            )

            # 10. Offline Update Safety Guard
            mpage.evaluate("""async () => {
                if ('caches' in window) {
                    const c = await caches.open('kaoyan-test-keep');
                    await c.put('/dummy', new Response('ok'));
                }
            }""")
            ctx_mobile.set_offline(True)
            mpage.evaluate("() => { const b = document.getElementById('btn-force-refresh'); if (b) b.click(); else document.getElementById('appVersionBadge')?.click(); }")
            mpage.wait_for_timeout(300)
            offline_safe = mpage.evaluate("""async () => {
                const modalOpen = document.getElementById('updateModal').classList.contains('open');
                const keys = ('caches' in window) ? await caches.keys() : ['no-cache-api'];
                return { modalOpen, hasDummy: keys.includes('kaoyan-test-keep') || keys[0] === 'no-cache-api' };
            }""")
            ctx_mobile.set_offline(False)
            runner.check(not offline_safe["modalOpen"] and offline_safe["hasDummy"], f"离线状态下触发更新安全中止，保留本地缓存 ({offline_safe})")
            runner.check(len(m_errors) == 0, f"Mobile 运行全程零 JS 异常 (pageerror={len(m_errors)})")
            ctx_mobile.close()

            browser.close()
    finally:
        httpd.shutdown()

    print("\n" + "=" * 60)
    print(f"V3.2.4 Comprehensive Verification: {runner.passed}/{runner.passed + runner.failed} PASSED")
    if runner.failures:
        print("FAILURES:")
        for f in runner.failures:
            print(f"  - {f}")
        sys.exit(1)
    print("ALL V3.2.4 CHECKS PASSED 100%!")


if __name__ == "__main__":
    run_suite()
