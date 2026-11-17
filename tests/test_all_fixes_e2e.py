# -*- coding: utf-8 -*-
"""
Targeted Playwright E2E verification for all frontend + alignment fixes:
1. 807 buildFrameworkIndex() 0-based idx & 单段循环 (section loop) locks playback strictly inside section bounds
2. 807 / 706 Track 2 .t1-linked-sent clicks (including explicit data-linked-sent-idx in 寻根文学_01)
3. pol47 ch_my_01 Card 0 section loop chronological order + ch_xsx_00 Track 2 '暂无伴读音频' audio:null guard
4. English aligned click-to-seek + highlight + 单句循环 (sentence loop)
5. Xu Tao xt_voice aligned click-to-seek (d08 #11/#18, d12 #9) + single-point highlight
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

        def select_play_mode(label_substr):
            page.click("#btn-loop-mode")
            page.wait_for_selector("#playModeDrawer.open .mode-option-card", timeout=5000)
            page.evaluate(
                """(targetName) => {
                    const cards = Array.from(document.querySelectorAll('#playModeList .mode-option-card'));
                    const card = cards.find(c => (c.querySelector('.mode-option-name')?.textContent || '').includes(targetName));
                    if (!card) throw new Error('Mode card not found: ' + targetName + ' | avail=' + cards.map(c => c.querySelector('.mode-option-name')?.textContent).join(','));
                    card.click();
                }""",
                label_substr,
            )
            page.wait_for_timeout(120)

        def click_card(substr, require_audio=True):
            qid = page.evaluate("""(sub) => {
                const cards = Array.from(document.querySelectorAll('#item-list .question-card-item'));
                const c = cards.find(el => (el.dataset.id || '').includes(sub) || (el.textContent || '').includes(sub));
                if (!c) throw new Error('Card not found matching: ' + sub + ' (avail: ' + cards.slice(0, 5).map(x => x.dataset.id).join(',') + ')');
                c.scrollIntoView({ block: 'center' });
                c.click();
                return c.dataset.id;
            }""", substr)
            page.wait_for_function("(id) => window.state?.activeItemId === id", arg=qid, timeout=8000)
            if require_audio:
                page.wait_for_function("() => window.audio && window.audio.readyState >= 1", timeout=12000)
            page.wait_for_timeout(150)
            return qid

        # 1. 807 郭沫若 Track 1 section loop + Track 2 .t1-linked-sent
        print("\n[1] 807 section loop & .t1-linked-sent", flush=True)
        page.click("#btn-subject-807")
        page.wait_for_selector('#item-list .question-card-item', timeout=8000)
        guo_id = click_card("郭沫若")
        if not page.locator("#tab-track-1.active").count():
            page.click("#tab-track-1")
            page.wait_for_timeout(200)

        sec_info = page.evaluate("""() => {
            const headers = Array.from(document.querySelectorAll('#paper-content .section-card-header, #paper-content .sec-head'));
            if (headers.length < 2) return { count: headers.length };
            headers[1].click();
            return {
                count: headers.length,
                tAfterHeaderClick: window.audio.currentTime,
                sentIdx: window.state.currentSentIndex
            };
        }""")
        page.wait_for_timeout(250)
        select_play_mode("单段循环")
        loop_res = page.evaluate("""async () => {
            const headers = Array.from(document.querySelectorAll('#paper-content .section-card-header, #paper-content .sec-head'));
            const s1Start = window.state.activeSentences[window.state.currentSentIndex]?.start || 0;
            headers[2]?.click();
            const s2Start = window.audio.currentTime;
            headers[1].click();
            if (s2Start > s1Start + 1.0) {
                window.audio.currentTime = s2Start + 0.15;
            }
            window.audio.dispatchEvent(new Event('timeupdate'));
            await new Promise(r => setTimeout(r, 350));
            window.audio.pause();
            return {
                playMode: window.state.playMode,
                sentIdxAfter: window.state.currentSentIndex,
                tAfterLoop: window.audio.currentTime,
                s1Start,
                s2Start
            };
        }""")
        check(
            sec_info.get("count", 0) >= 3 and sec_info.get("sentIdx", -1) > 0
            and loop_res.get("playMode") == "section"
            and abs(loop_res["tAfterLoop"] - loop_res["s1Start"]) < 0.8,
            f"807 {guo_id} section[1] click & 单段循环 bounds locked ({loop_res})"
        )

        # Switch to Track 2 and click .t1-linked-sent spans
        page.click("#tab-track-2")
        page.wait_for_timeout(300)
        linked_guo = page.evaluate("""() => {
            const spans = Array.from(document.querySelectorAll('#paper-content .t1-linked-sent'));
            const valid = spans.filter(s => s.dataset.linkedSentIdx !== undefined && parseInt(s.dataset.linkedSentIdx, 10) >= 0);
            const target = valid.find(el => (el.textContent || '').includes('暴躁') || (el.textContent || '').includes('狂飙') || (el.textContent || '').includes('天狗')) || valid[valid.length - 1];
            if (!target) return { found: false, total: spans.length, validCount: valid.length };
            const lidx = parseInt(target.dataset.linkedSentIdx, 10);
            target.click();
            window.audio.pause();
            return {
                found: true,
                total: spans.length,
                validCount: valid.length,
                linkedSentIdx: lidx,
                curTime: window.audio.currentTime,
                expected: window.state.activeSentences?.[lidx]?.start,
                stateSentIdx: window.state.currentSentIndex,
                txt: target.textContent.trim().slice(0, 24)
            };
        }""")
        check(
            linked_guo.get("found") and linked_guo.get("validCount") == linked_guo.get("total")
            and linked_guo.get("linkedSentIdx", -1) >= 0
            and abs(linked_guo.get("curTime", -9) - linked_guo.get("expected", -1)) < 0.35,
            f"{guo_id} Track 2 .t1-linked-sent ({linked_guo.get('validCount')}/{linked_guo.get('total')}) click seeks ({linked_guo})"
        )
        select_play_mode("按顺序")

        # 2. 寻根文学 explicit data-linked-sent-idx spans & 706 .t1-linked-sent
        print("\n[2] 寻根文学 explicit linked spans & 706 linked spans", flush=True)
        xungen_id = click_card("寻根文学")
        page.click("#tab-track-2")
        page.wait_for_timeout(300)
        xungen_res = page.evaluate("""() => {
            const spans = Array.from(document.querySelectorAll('#paper-content .t1-linked-sent'));
            const valid = spans.filter(s => s.dataset.linkedSentIdx !== undefined && parseInt(s.dataset.linkedSentIdx, 10) >= 0);
            const sample = valid.slice(0, 3).map(s => {
                s.click();
                return { txt: s.textContent.trim().slice(0, 18), lidx: parseInt(s.dataset.linkedSentIdx, 10), t: window.audio.currentTime };
            });
            window.audio.pause();
            return { total: spans.length, validCount: valid.length, sample };
        }""")
        check(
            xungen_res.get("total", 0) >= 15 and xungen_res.get("validCount") == xungen_res.get("total") and all(x["t"] >= 0 for x in xungen_res.get("sample", [])),
            f"{xungen_id} all {xungen_res.get('validCount')}/{xungen_res.get('total')} .t1-linked-sent stamped & clickable ({xungen_res.get('sample')})"
        )

        page.click("#btn-subject-706")
        page.wait_for_selector('#item-list .question-card-item', timeout=8000)
        for qsub, needle in [("窦娥冤", "天地也"), ("诸子散文", "道家散文")]:
            qid = click_card(qsub)
            page.click("#tab-track-2")
            page.wait_for_timeout(300)
            res706 = page.evaluate("""(kw) => {
                const spans = Array.from(document.querySelectorAll('#paper-content .t1-linked-sent'));
                const target = spans.find(el => (el.textContent || '').includes(kw));
                if (!target) return { found: false, total: spans.length };
                const lidx = parseInt(target.dataset.linkedSentIdx, 10);
                target.click();
                window.audio.pause();
                return { found: true, lidx, t: window.audio.currentTime, expected: window.state.activeSentences?.[lidx]?.start };
            }""", needle)
            check(
                res706.get("found") and res706.get("lidx", -1) >= 0 and abs(res706.get("t", -1) - res706.get("expected", -9)) < 0.35,
                f"706 Track 2 .t1-linked-sent {qid} '{needle}' -> sent {res706.get('lidx')} ({res706.get('t')}s vs exp {res706.get('expected')}s)"
            )

        # 3. pol47 ch_my_01 Card 0 order & ch_xsx_00 empty audio guard
        print("\n[3] pol47 ch_my_01 Card 0 & ch_xsx_00 Track 2 guard", flush=True)
        page.click("#btn-subject-pol")
        page.wait_for_selector('#pol-submode-bar button[data-pol-submode="recite47"]', timeout=8000)
        page.click('#pol-submode-bar button[data-pol-submode="recite47"]')
        page.wait_for_selector('#item-list .question-card-item[data-id="ch_my_01"]', timeout=8000)
        click_card("ch_my_01")
        if not page.locator("#tab-track-1.active").count():
            page.click("#tab-track-1")
            page.wait_for_timeout(200)
        ch_my_res = page.evaluate("""() => {
            const firstBtn = document.querySelector('#paper-content .card-audio-btn, #paper-content .sec-badge');
            const s0 = window.state?.activeSentences?.[0]?.start;
            const s1 = window.state?.activeSentences?.[1]?.start;
            return { s0, s1, monotonic: Number.isFinite(s0) && Number.isFinite(s1) && s0 < s1, hasBtn: !!firstBtn };
        }""")
        check(
            ch_my_res.get("monotonic"),
            f"pol47 ch_my_01 chronological order verified (s0={ch_my_res.get('s0')} < s1={ch_my_res.get('s1')})"
        )

        click_card("ch_xsx_00", require_audio=False)
        page.click("#tab-track-2")
        page.wait_for_timeout(200)
        xsx_res = page.evaluate("""() => {
            const btns = Array.from(document.querySelectorAll('#paper-content .card-audio-btn'));
            const texts = btns.map(b => b.textContent.trim());
            if (btns[0]) btns[0].click();
            return {
                texts,
                sentIdxAfterClick: window.state.currentSentIndex,
                srcAttr: window.audio.getAttribute('src')
            };
        }""")
        check(
            any("暂无伴读音频" in t for t in xsx_res.get("texts", [])) and not xsx_res.get("srcAttr"),
            f"pol47 ch_xsx_00 Track 2 audio:null guard ({xsx_res})"
        )

        # 4. English realigned click + sentence loop
        print("\n[4] English click-to-seek & 单句循环", flush=True)
        page.click("#btn-subject-en")
        page.wait_for_selector('#item-list .question-card-item', timeout=8000)
        en_id = click_card("en_essay_09")
        if not page.locator("#tab-track-1.active").count():
            page.click("#tab-track-1")
            page.wait_for_function("() => window.audio && window.audio.readyState >= 1", timeout=12000)
            page.wait_for_timeout(200)
        en_click = page.evaluate("""() => {
            const spans = Array.from(document.querySelectorAll('#paper-content [data-sent-idx]'));
            const target = spans.find(el => (el.textContent || '').includes('Furthermore,'));
            if (!target) return { found: false };
            const idx = parseInt(target.dataset.sentIdx, 10);
            target.click();
            const s = window.state.activeSentences[idx];
            return {
                found: true,
                idx,
                start: s?.start,
                end: s?.end,
                curTime: window.audio.currentTime,
                activeCls: target.classList.contains('active-spotlight')
            };
        }""")
        check(
            en_click.get("found") and abs(en_click.get("curTime", -9) - en_click.get("start", -1)) < 0.35 and en_click.get("activeCls"),
            f"{en_id} 'Furthermore,' click & highlight ({en_click})"
        )
        select_play_mode("单句循环")
        page.evaluate("""(idx) => {
            const s = window.state.activeSentences[idx];
            window.audio.currentTime = s.end + 0.05;
            window.audio.dispatchEvent(new Event('timeupdate'));
        }""", en_click["idx"])
        page.wait_for_timeout(450)
        loop_check = page.evaluate("""(idx) => {
            const s = window.state.activeSentences[idx];
            window.audio.pause();
            return { curTime: window.audio.currentTime, sStart: s.start, sEnd: s.end, curIdx: window.state.currentSentIndex };
        }""", en_click["idx"])
        check(
            loop_check["curIdx"] == en_click["idx"]
            and (loop_check["sStart"] - 0.1) <= loop_check["curTime"] <= (loop_check["sStart"] + 0.8)
            and loop_check["curTime"] < loop_check["sEnd"] - 5.0,
            f"{en_id} 单句循环 stays locked at sent[{en_click['idx']}] ({loop_check})"
        )
        select_play_mode("按顺序")

        # 5. Xu Tao xt_voice realigned point clicks (d08 #11/#18, d12 #9)
        print("\n[5] Xu Tao xt_voice click-to-seek (d08 #11/#18, d12 #9)", flush=True)
        page.click("#btn-subject-pol")
        page.wait_for_selector('.pol-submode-btn[data-pol-submode="xutao16"]', timeout=8000)
        page.click('.pol-submode-btn[data-pol-submode="xutao16"]')
        page.wait_for_selector('#item-list .question-card-item', timeout=8000)

        click_card("d08")
        page.wait_for_selector('#xtVoiceSwitcher .xt-voice-btn[data-voice="voice"]', timeout=5000)
        page.click('#xtVoiceSwitcher .xt-voice-btn[data-voice="voice"]')
        page.wait_for_function("() => window.state?.polXtVoice === 'voice' && window.audio.readyState >= 1", timeout=12000)

        d08_11 = page.evaluate("""() => {
            const card = document.querySelector('#paper-content .xt-day-point-card[data-point-idx="10"]');
            card.click();
            window.audio.pause();
            return { idx: window.state.currentSentIndex, t: window.audio.currentTime, expStart: window.state.activeSentences[10]?.start };
        }""")
        page.wait_for_timeout(150)
        d08_18 = page.evaluate("""() => {
            const card = document.querySelector('#paper-content .xt-day-point-card[data-point-idx="17"]');
            card.click();
            window.audio.pause();
            return { idx: window.state.currentSentIndex, t: window.audio.currentTime, expStart: window.state.activeSentences[17]?.start };
        }""")
        check(
            d08_11["idx"] == 10 and abs(d08_11["t"] - d08_11["expStart"]) < 0.35 and 126.0 <= d08_11["expStart"] <= 127.5,
            f"xt_voice d08 pt[10] #11 -> {d08_11}"
        )
        check(
            d08_18["idx"] == 17 and abs(d08_18["t"] - d08_18["expStart"]) < 0.35 and 229.0 <= d08_18["expStart"] <= 231.5,
            f"xt_voice d08 pt[17] #18 -> {d08_18}"
        )

        click_card("d12")
        page.wait_for_function("() => window.state?.activeItemId?.includes('d12') && window.audio.readyState >= 1", timeout=12000)
        d12_9 = page.evaluate("""() => {
            const card = document.querySelector('#paper-content .xt-day-point-card[data-point-idx="8"]');
            card.click();
            window.audio.pause();
            return { idx: window.state.currentSentIndex, t: window.audio.currentTime, expStart: window.state.activeSentences[8]?.start };
        }""")
        check(
            d12_9["idx"] == 8 and abs(d12_9["t"] - d12_9["expStart"]) < 0.35 and 105.5 <= d12_9["expStart"] <= 107.2,
            f"xt_voice d12 pt[8] #9 -> {d12_9}"
        )

        check(len(page_errors) == 0, f"Zero uncaught pageerrors ({page_errors})")
        browser.close()
    httpd.shutdown()

    passed = sum(1 for c, _ in results if c)
    total = len(results)
    print(f"\n=== ALL FIXES E2E SUMMARY: {passed}/{total} PASSED ===", flush=True)
    if passed != total:
        raise SystemExit(1)


if __name__ == "__main__":
    run()
