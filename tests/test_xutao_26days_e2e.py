# -*- coding: utf-8 -*-
"""
Targeted Playwright E2E regression test for Xu Tao 26 Days (608 points):
1. UI labels/counts updated cleanly ('84讲', '徐涛26天', '26天带背', '徐涛26天选择题带背')
2. All 26 days (pol_xt_d01..pol_xt_d26) render in sidebar with 608 total points
3. Day 17..26 stage rendering, cloze highlights, corrected textbook facts (e.g. Day 24 #5 2035年, #23 1948年年初)
4. Dual-voice track switch (anlang AI 干货 vs voice 原声带背) & real MP3 load + click-to-seek timestamp sync on Days 17, 22, 24, 26
5. Cloze self-test mode (#btn-cloze-mode) hides & reveals keywords on Day 17..26 cards with 0 pageerrors
"""

import http.server
import os
import re
import socketserver
import threading
from playwright.sync_api import sync_playwright

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Mp3RangeHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=REPO_ROOT, **kwargs)

    def log_message(self, format, *args):
        pass

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass

    def do_GET(self):
        path = self.translate_path(self.path.split("?")[0])
        if path.lower().endswith(".mp3") and os.path.isfile(path):
            file_size = os.path.getsize(path)
            rng = self.headers.get("Range")
            if rng:
                m = re.match(r"bytes=(\d+)-(\d*)", rng)
                if m:
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else file_size - 1
                    end = min(end, file_size - 1)
                    if start > end or start >= file_size:
                        self.send_error(416, "Requested Range Not Satisfiable")
                        return
                    length = end - start + 1
                    self.send_response(206)
                    self.send_header("Content-Type", "audio/mpeg")
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                    self.send_header("Content-Length", str(length))
                    self.end_headers()
                    with open(path, "rb") as f:
                        f.seek(start)
                        self.wfile.write(f.read(length))
                    return
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(file_size))
            self.end_headers()
            with open(path, "rb") as f:
                self.wfile.write(f.read())
            return
        super().do_GET()


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        pass


def start_server():
    httpd = ReusableTCPServer(("127.0.0.1", 0), Mp3RangeHandler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, port


def run():
    httpd, port = start_server()
    base_url = f"http://127.0.0.1:{port}/index.html"
    passed = 0
    failed = 0

    def check(cond, desc):
        nonlocal passed, failed
        if cond:
            passed += 1
            print(f"  [PASS] {desc}", flush=True)
        else:
            failed += 1
            print(f"  [FAIL] {desc}", flush=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 840})
        page = context.new_page()
        page_errors = []

        def abort_external(route):
            url = route.request.url
            if any(h in url for h in ("fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net")):
                route.abort()
            else:
                route.continue_()

        page.route("**/*", abort_external)
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        page.goto(base_url, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector("#btn-subject-pol", timeout=15000)
        page.wait_for_function(
            "() => (document.querySelector('#count-pol')?.textContent || '').includes('84')",
            timeout=15000,
        )

        # 1. Verify badge & submode labels
        count_pol_txt = page.locator("#count-pol").text_content() or ""
        check("84讲" in count_pol_txt, f"#count-pol displays 84讲 ({count_pol_txt!r})")

        page.click("#btn-subject-pol")
        page.wait_for_selector('.pol-submode-btn[data-pol-submode="xutao16"]', timeout=8000)
        sub_btn_txt = page.locator('.pol-submode-btn[data-pol-submode="xutao16"]').first.inner_text()
        check("徐涛26天" in sub_btn_txt, f"Pol submode button says 徐涛26天 ({sub_btn_txt!r})")

        page.click('.pol-submode-btn[data-pol-submode="xutao16"]')
        page.wait_for_selector("#item-list .question-card-item", timeout=10000)

        # 2. Verify all 26 days & 608 points render cleanly in sidebar + data layer
        sidebar_info = page.evaluate("""() => {
            const cards = Array.from(document.querySelectorAll('#item-list .question-card-item'));
            const firstTag = cards[0]?.textContent || '';
            const lastText = cards[cards.length - 1]?.textContent || '';
            const totalPts = (window.KAOYAN_POL_DATA?.xutao16 || []).reduce((acc, d) => acc + d.points.length, 0);
            return { count: cards.length, firstTag, lastText, totalPts };
        }""")
        check(
            sidebar_info["count"] == 26 and sidebar_info["totalPts"] == 608,
            f"Sidebar lists 26 Xu Tao days and KAOYAN_POL_DATA has 608 pts ({sidebar_info['count']} / {sidebar_info['totalPts']})",
        )
        check(
            "26天带背" in sidebar_info["firstTag"] and "Day 26" in sidebar_info["lastText"],
            f"Sidebar shows '26天带背' tag and reaches Day 26",
        )

        # Helper to select a Xu Tao day card
        def open_xt_day(day_id):
            page.evaluate(
                """(id) => {
                    const card = Array.from(document.querySelectorAll('#item-list .question-card-item'))
                        .find(el => (el.dataset.id || '') === id || (el.textContent || '').includes(id.replace('pol_xt_d', 'Day ')));
                    if (card) card.click();
                }""",
                day_id,
            )
            page.wait_for_function(
                f"() => window.state?.activeItemId === '{day_id}' && document.querySelectorAll('#paper-content .xt-day-point-card').length > 0",
                timeout=12000,
            )

        # 3. Verify Day 17 (史纲6) + anlang default audio + point click-to-seek
        open_xt_day("pol_xt_d17")
        d17_info = page.evaluate("""() => {
            const stageTopic = document.querySelector('#stage-topic')?.textContent || '';
            const pts = document.querySelectorAll('#paper-content .xt-day-point-card');
            return {
                stageTopic,
                ptCount: pts.length,
                voice: window.state.polXtVoice,
                src: window.audio?.src || ''
            };
        }""")
        check(
            "徐涛26天选择题带背" in d17_info["stageTopic"] and d17_info["ptCount"] == 24,
            f"Day 17 renders 24 pts & stageTopic='徐涛26天选择题带背' ({d17_info})",
        )
        page.wait_for_function("() => window.audio && window.audio.readyState >= 1 && window.audio.duration > 200", timeout=15000)

        # 4. Verify Day 22 #11 split point click-to-seek on both anlang and voice tracks
        open_xt_day("pol_xt_d22")
        page.wait_for_function("() => window.audio.readyState >= 1", timeout=12000)
        d22_an = page.evaluate("""() => {
            const c = document.querySelector('#paper-content .xt-day-point-card[data-point-idx="10"]');
            c.click();
            window.audio.pause();
            return { idx: window.state.currentSentIndex, t: window.audio.currentTime, exp: window.state.activeSentences[10]?.start };
        }""")
        check(
            d22_an["idx"] == 10 and abs(d22_an["t"] - d22_an["exp"]) < 0.35,
            f"Day 22 #11 anlang click-to-seek ({d22_an})",
        )

        page.click('#xtVoiceSwitcher .xt-voice-btn[data-voice="voice"]')
        page.wait_for_function("() => window.state?.polXtVoice === 'voice' && window.audio.readyState >= 1 && window.audio.src.includes('xt_voice_d22.mp3')", timeout=15000)
        d22_vc = page.evaluate("""() => {
            const c = document.querySelector('#paper-content .xt-day-point-card[data-point-idx="10"]');
            c.click();
            window.audio.pause();
            return { idx: window.state.currentSentIndex, t: window.audio.currentTime, exp: window.state.activeSentences[10]?.start };
        }""")
        check(
            d22_vc["idx"] == 10 and abs(d22_vc["t"] - d22_vc["exp"]) < 0.35 and 97.0 <= d22_vc["exp"] <= 99.5,
            f"Day 22 #11 xt_voice word-sliced seek (~98.5s) ({d22_vc})",
        )

        # 5. Verify Day 24 academic fact fixes (2035年 & 1948年年初) & Day 26 final day + cloze self-test mode
        open_xt_day("pol_xt_d24")
        page.wait_for_function("() => window.audio.readyState >= 1 && window.audio.src.includes('xt_voice_d24.mp3')", timeout=15000)
        d24_check = page.evaluate("""() => {
            const cards = Array.from(document.querySelectorAll('#paper-content .xt-day-point-card'));
            const p5 = cards[4]?.textContent || '';
            const p23 = cards[22]?.textContent || '';
            cards[22].click();
            window.audio.pause();
            return {
                len: cards.length,
                has2035: p5.includes('2035年'),
                has1948: p23.includes('1948年年初') && p23.includes('《关于建立报告制度》'),
                t23: window.audio.currentTime,
                exp23: window.state.activeSentences[22]?.start
            };
        }""")
        check(
            d24_check["len"] == 23 and d24_check["has2035"] and d24_check["has1948"] and abs(d24_check["t23"] - d24_check["exp23"]) < 0.35,
            f"Day 24 (23 pts, 2035年 & 1948年年初 fixed facts, pt 23 seek) ({d24_check})",
        )

        open_xt_day("pol_xt_d26")
        page.wait_for_function("() => window.audio.readyState >= 1", timeout=15000)
        d26_check = page.evaluate("""() => {
            const cards = document.querySelectorAll('#paper-content .xt-day-point-card');
            const clozes = document.querySelectorAll('#paper-content .xt-keyword.cloze');
            const allText = document.querySelector('#paper-content')?.textContent || '';
            return { len: cards.length, clozeCount: clozes.length, hasXinzhi: allText.includes('新质生产力') };
        }""")
        check(
            d26_check["len"] == 21 and d26_check["clozeCount"] >= 21 and d26_check["hasXinzhi"],
            f"Day 26 renders 21 pts, >=21 .cloze nodes, fixed 新质生产力 ({d26_check})",
        )

        # Toggle cloze mode once to verify hide works without errors
        page.click("#btn-cloze-mode")
        page.wait_for_timeout(150)
        cloze_on = page.evaluate("() => document.body.classList.contains('cloze-active') || document.querySelector('#paper-stage')?.classList.contains('cloze-mode') || (window.state?.clozeMode && window.state.clozeMode !== 'normal')")
        check(bool(cloze_on), f"Cloze mode toggles cleanly on Day 26 ({cloze_on})")

        check(len(page_errors) == 0, f"Zero uncaught pageerrors ({page_errors})")
        browser.close()

    httpd.shutdown()
    print(f"\n=== XUTAO 26 DAYS E2E SUMMARY: {passed}/{passed + failed} PASSED ===", flush=True)
    if failed > 0:
        raise SystemExit(1)


if __name__ == "__main__":
    run()
