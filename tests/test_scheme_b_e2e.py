# -*- coding: utf-8 -*-
"""
Playwright E2E tests for Scheme B (orthogonal repeat count + gap pause + HUD/card repeat badges):
1. Xutao 16 '2遍' (AABBCC) repeat progression + live HUD & card badges ('第 1/2 遍' -> '第 2/2 遍' -> next point '第 1/2 遍')
2. Loop gap pause state: audio pauses cleanly with state.isPlaying=true and '停顿' indicator, resumes after gap, and Space/Pause during gap aborts gap immediately
3. Xutao 16 '3遍' (AAABBBCCC) repeat progression check (with >150ms seek-lock safe wait)
4. 807 '单段 2遍' section repeat progression (sec[0] rep 1 -> rep 2 -> advances to sec[1] rep 1)
5. Infinite fallback ('∞ 无限') + persistence across reload (kaoyan_sent_repeat_count, kaoyan_sec_repeat_count, kaoyan_loop_gap_ms)
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
    results = []
    page_errors = []

    def check(cond, msg):
        status = "PASS" if cond else "FAIL"
        results.append((cond, msg))
        print(f"  [{status}] {msg}", flush=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        def abort_external(route):
            url = route.request.url
            if any(h in url for h in ("fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net")):
                route.abort()
            else:
                route.continue_()

        page.route("**/*", abort_external)
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        page.goto(base_url, wait_until="domcontentloaded", timeout=20000)
        page.wait_for_function("() => !!window.audio && !!window.state && !!window.KAOYAN_POL_DATA", timeout=15000)

        def select_scope_pill(scope_substr, rep_val_str):
            page.click("#btn-loop-mode")
            page.wait_for_selector("#playModeDrawer.open .mode-option-card", timeout=5000)
            still_open = page.evaluate("""([sub, val]) => {
                const cards = Array.from(document.querySelectorAll('#playModeList .mode-option-card'));
                const card = cards.find(c => (c.querySelector('.mode-option-name')?.textContent || '').includes(sub));
                if (!card) throw new Error('Scope card not found: ' + sub);
                const pill = card.querySelector(`.mode-repeat-pill[data-rep-val="${val}"]`);
                if (!pill) throw new Error('Repeat pill not found: ' + val);
                pill.click();
                return document.getElementById('playModeDrawer')?.classList.contains('open');
            }""", [scope_substr, rep_val_str])
            assert still_open, f"Drawer should remain open after clicking repeat pill ({scope_substr}, {rep_val_str})"
            page.keyboard.press("Escape")
            page.wait_for_timeout(150)

        def set_gap_ms(ms_str):
            page.click("#btn-loop-mode")
            page.wait_for_selector("#playModeDrawer.open .mode-gap-pill", timeout=5000)
            page.evaluate("""(ms) => {
                const pill = document.querySelector(`#playModeList .mode-gap-pill[data-gap-ms="${ms}"]`);
                if (!pill) throw new Error('Gap pill not found: ' + ms);
                pill.click();
            }""", ms_str)
            page.wait_for_timeout(120)
            page.keyboard.press("Escape")
            page.wait_for_timeout(150)

        # 1. Xutao 16 '2遍' (AABBCC) + gap pause + HUD/card badges
        print("\n[1] Xutao 16 2-pass AABBCC + gap pause + badges", flush=True)
        page.click("#btn-subject-pol")
        page.wait_for_selector('.pol-submode-btn[data-pol-submode="xutao16"]', timeout=8000)
        page.click('.pol-submode-btn[data-pol-submode="xutao16"]')
        page.wait_for_selector('#item-list .question-card-item[data-id="pol_xt_d01"]', timeout=8000)
        page.click('#item-list .question-card-item[data-id="pol_xt_d01"]')
        page.wait_for_function("() => window.state?.activeItemId === 'pol_xt_d01' && window.audio.readyState >= 1", timeout=12000)

        set_gap_ms("500")
        select_scope_pill("单句循环", "2")
        page.evaluate("""() => {
            const card0 = document.querySelector('#paper-content .xt-day-point-card[data-point-idx="0"]');
            card0.click();
        }""")
        page.wait_for_timeout(150)

        init_badge = page.evaluate("""() => ({
            mode: window.state.playMode,
            reps: window.state.sentenceRepeatCount,
            btnText: document.querySelector('#btn-loop-mode .mode-text')?.textContent.trim(),
            svgTextCount: document.querySelectorAll('#btn-loop-mode svg text').length,
            btnTitle: document.getElementById('btn-loop-mode')?.title || '',
            hudText: document.getElementById('hudRepeatBadge')?.textContent.trim(),
            cardText: document.querySelector('#paper-content .xt-day-point-card.active-spotlight .live-repeat-badge')?.textContent.trim()
        })""")
        check(
            init_badge["mode"] == "loop3" and init_badge["reps"] == 2
            and init_badge["btnText"] == "句×2" and init_badge["svgTextCount"] == 0
            and "2遍推进" in init_badge["btnTitle"]
            and init_badge["hudText"] == "第 1/2 遍"
            and init_badge["cardText"] == "第 1/2 遍",
            f"Xutao 2-pass UI synced ({init_badge})"
        )

        # Trigger end of Point 0 pass 1 -> enters 500ms gap pause, loopCount=1, stays on Point 0!
        mid_gap = page.evaluate("""async () => {
            await window.audio.play();
            const s0 = window.state.activeSentences[0];
            window.audio.currentTime = s0.end + 0.05;
            await new Promise(r => setTimeout(r, 120));
            return {
                curIdx: window.state.currentSentIndex,
                loopCount: window.state.loopCount,
                audioPaused: window.audio.paused,
                isPlaying: window.state.isPlaying,
                curTime: window.audio.currentTime,
                s0Start: s0.start,
                hudText: document.getElementById('hudRepeatBadge')?.textContent.trim(),
                cardText: document.querySelector('#paper-content .xt-day-point-card.active-spotlight .live-repeat-badge')?.textContent.trim()
            };
        }""")
        check(
            mid_gap["curIdx"] == 0 and mid_gap["loopCount"] == 1
            and mid_gap["audioPaused"] is True and mid_gap["isPlaying"] is True
            and abs(mid_gap["curTime"] - mid_gap["s0Start"]) < 0.25
            and "第 2/2 遍" in (mid_gap["hudText"] or "")
            and "停顿" in (mid_gap["hudText"] or "")
            and "第 2/2 遍" in (mid_gap["cardText"] or ""),
            f"Gap wait keeps state.isPlaying=true & displays 第 2/2 遍 · 停顿 ({mid_gap})"
        )

        # Wait past 500ms gap -> audio resumes playing Point 0 pass 2 automatically!
        page.wait_for_timeout(550)
        resumed_p2 = page.evaluate("""() => ({
            curIdx: window.state.currentSentIndex,
            loopCount: window.state.loopCount,
            audioPaused: window.audio.paused,
            hudText: document.getElementById('hudRepeatBadge')?.textContent.trim()
        })""")
        check(
            resumed_p2["curIdx"] == 0 and resumed_p2["loopCount"] == 1
            and resumed_p2["audioPaused"] is False
            and resumed_p2["hudText"] == "第 2/2 遍",
            f"After 500ms gap audio auto-resumes Point 0 pass 2 ({resumed_p2})"
        )

        # Trigger end of Point 0 pass 2 -> advances cleanly to Point 1 (B) pass 1!
        page.evaluate("""async () => {
            const s0 = window.state.activeSentences[0];
            window.audio.currentTime = s0.end + 0.05;
        }""")
        page.wait_for_timeout(120)
        gap_to_b = page.evaluate("""() => ({
            curIdx: window.state.currentSentIndex,
            loopCount: window.state.loopCount,
            curTime: window.audio.currentTime,
            s1Start: window.state.activeSentences[1]?.start,
            hudText: document.getElementById('hudRepeatBadge')?.textContent.trim()
        })""")
        check(
            gap_to_b["curIdx"] == 1 and gap_to_b["loopCount"] == 0
            and abs(gap_to_b["curTime"] - gap_to_b["s1Start"]) < 0.25
            and "第 1/2 遍" in (gap_to_b["hudText"] or ""),
            f"Pass 2 complete advances A -> B 第 1/2 遍 ({gap_to_b})"
        )

        # Test clicking Pause during gap pause aborts timer immediately
        page.click("#dock-play-btn")
        page.wait_for_timeout(600)
        paused_in_gap = page.evaluate("""() => ({
            isPlaying: window.state.isPlaying,
            audioPaused: window.audio.paused
        })""")
        check(
            paused_in_gap["isPlaying"] is False and paused_in_gap["audioPaused"] is True,
            f"Clicking pause during gap cancels resume timer cleanly ({paused_in_gap})"
        )

        # 2. Xutao 16 '3遍' (AAABBBCCC) check
        print("\n[2] Xutao 16 3-pass AAABBBCCC", flush=True)
        set_gap_ms("0")
        select_scope_pill("单句循环", "3")
        aaabbb = page.evaluate("""async () => {
            document.querySelector('#paper-content .xt-day-point-card[data-point-idx="0"]').click();
            await window.audio.play();
            await new Promise(r => setTimeout(r, 180));
            const s0 = window.state.activeSentences[0];
            const trace = [];
            for (let k = 0; k < 3; k++) {
                window.audio.currentTime = s0.end + 0.05;
                window.audio.dispatchEvent(new Event('timeupdate'));
                await new Promise(r => setTimeout(r, 180));
                trace.push({ idx: window.state.currentSentIndex, lc: window.state.loopCount, hud: document.getElementById('hudRepeatBadge')?.textContent.trim() });
            }
            window.audio.pause();
            return {
                trace,
                btnText: document.querySelector('#btn-loop-mode .mode-text')?.textContent.trim(),
                btnTitle: document.getElementById('btn-loop-mode')?.title || ''
            };
        }""")
        t0, t1, t2 = aaabbb["trace"]
        check(
            aaabbb["btnText"] == "句×3" and "3遍推进" in aaabbb["btnTitle"]
            and t0["idx"] == 0 and t0["lc"] == 1 and t0["hud"] == "第 2/3 遍"
            and t1["idx"] == 0 and t1["lc"] == 2 and t1["hud"] == "第 3/3 遍"
            and t2["idx"] == 1 and t2["lc"] == 0 and t2["hud"] == "第 1/3 遍",
            f"Xutao 3-pass AAABBBCCC trace accurate ({aaabbb})"
        )

        # 3. 807 section '2遍' advance (sec[0] -> sec[0] rep 2 -> sec[1] rep 1)
        print("\n[3] 807 section 2-pass advance", flush=True)
        page.click("#btn-subject-807")
        page.wait_for_selector('#item-list .question-card-item', timeout=8000)
        page.click('#item-list .question-card-item')
        page.wait_for_function("() => window.audio && window.audio.readyState >= 1", timeout=12000)
        select_scope_pill("单段循环", "2")
        sec_trace = page.evaluate("""async () => {
            const headers = Array.from(document.querySelectorAll('#paper-content .section-card-header, #paper-content .sec-head'));
            headers[0].click();
            await window.audio.play();
            await new Promise(r => setTimeout(r, 200));
            const s0Start = window.audio.currentTime;
            headers[1].click();
            await new Promise(r => setTimeout(r, 200));
            const s1Start = window.audio.currentTime;
            headers[0].click();
            await new Promise(r => setTimeout(r, 220));
            const firstHud = document.getElementById('hudRepeatBadge')?.textContent.trim();
            // Finish sec[0] pass 1
            window.audio.currentTime = s1Start + 0.05;
            window.audio.dispatchEvent(new Event('timeupdate'));
            await new Promise(r => setTimeout(r, 180));
            const after1 = { t: window.audio.currentTime, lc: window.state.loopCount, hud: document.getElementById('hudRepeatBadge')?.textContent.trim() };
            // Finish sec[0] pass 2 -> should advance to sec[1]!
            window.audio.currentTime = s1Start + 0.05;
            window.audio.dispatchEvent(new Event('timeupdate'));
            await new Promise(r => setTimeout(r, 180));
            const after2 = { t: window.audio.currentTime, lc: window.state.loopCount, hud: document.getElementById('hudRepeatBadge')?.textContent.trim() };
            window.audio.pause();
            return {
                btnText: document.querySelector('#btn-loop-mode .mode-text')?.textContent.trim(),
                btnTitle: document.getElementById('btn-loop-mode')?.title || '',
                s0Start, s1Start, firstHud, after1, after2
            };
        }""")
        check(
            sec_trace["btnText"] == "段×2" and "2遍推进" in sec_trace["btnTitle"]
            and sec_trace["firstHud"] == "第 1/2 遍"
            and abs(sec_trace["after1"]["t"] - sec_trace["s0Start"]) < 0.8 and sec_trace["after1"]["lc"] == 1 and sec_trace["after1"]["hud"] == "第 2/2 遍"
            and abs(sec_trace["after2"]["t"] - sec_trace["s1Start"]) < 0.8 and sec_trace["after2"]["lc"] == 0 and sec_trace["after2"]["hud"] == "第 1/2 遍",
            f"807 section 2-pass advances sec[0]x2 -> sec[1] ({sec_trace})"
        )

        # 4. Persistence across reload + infinite fallback
        print("\n[4] LocalStorage persistence across reload", flush=True)
        set_gap_ms("800")
        page.reload(wait_until="domcontentloaded", timeout=20000)
        page.wait_for_function("() => !!window.audio && !!window.state", timeout=15000)
        persisted = page.evaluate("""() => ({
            playMode: window.state.playMode,
            sentReps: window.state.sentenceRepeatCount,
            secReps: window.state.sectionRepeatCount,
            gapMs: window.state.loopGapMs,
            btnText: document.querySelector('#btn-loop-mode .mode-text')?.textContent.trim(),
            btnTitle: document.getElementById('btn-loop-mode')?.title || ''
        })""")
        check(
            persisted["playMode"] == "section"
            and persisted["sentReps"] == 3
            and persisted["secReps"] == 2
            and persisted["gapMs"] == 800
            and persisted["btnText"] == "段×2" and "2遍推进" in persisted["btnTitle"],
            f"Settings persisted cleanly across reload ({persisted})"
        )

        # Verify '∞ 无限' works and hides finite repeat badge
        select_scope_pill("单句循环", "0")
        inf_btn = page.evaluate("() => ({ mode: window.state.playMode, btn: document.querySelector('#btn-loop-mode .mode-text')?.textContent.trim(), title: document.getElementById('btn-loop-mode')?.title || '', hudVis: getComputedStyle(document.getElementById('hudRepeatBadge')).display })")
        check(
            inf_btn["mode"] == "sentence" and inf_btn["btn"] == "单句" and "单句循环" in inf_btn["title"] and inf_btn["hudVis"] == "none",
            f"Infinite single sentence ('∞ 无限') works and hides finite badge ({inf_btn})"
        )

        check(len(page_errors) == 0, f"Zero uncaught pageerrors ({page_errors})")
        browser.close()
    httpd.shutdown()

    passed = sum(1 for c, _ in results if c)
    total = len(results)
    print(f"\n=== SCHEME B E2E SUMMARY: {passed}/{total} PASSED ===", flush=True)
    if passed != total:
        raise SystemExit(1)


if __name__ == "__main__":
    run()
