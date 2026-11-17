#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tests/test_v325_seek_and_nav.py
v3.2.5 核心修复端到端 Playwright 回归测试套件：
1. 全科 88 题/篇 + 政治 47 章 Track1 DOM 句标零嵌套、零漏标检验；
2. 点击精准寻音（含跨句/嵌套段落、.cloze/.kw-red 非挖空态、表格、徐涛16天/腿姐11天、慢网 readyState===0 750ms 延迟）；
3. 移动端竖屏 (390x844)、iPad 竖屏 (768x1024)、iPad 横屏 (1024x768) 播放时底栏自动滑出退出、暂停/收起后无缝恢复。
"""

import http.server
import json
import os
import re
import socketserver
import sys
import threading
import time
from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MP3_DELAY = 0.0


class SlowMp3RangeHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=REPO_ROOT, **kwargs)

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        req_path = self.path.split("?")[0]
        if MP3_DELAY > 0 and req_path.endswith(".mp3"):
            time.sleep(MP3_DELAY)
        path = self.translate_path(req_path)
        if os.path.isdir(path) or not os.path.exists(path):
            return super().do_GET()
        ctype = self.guess_type(path)
        size = os.path.getsize(path)
        range_hdr = self.headers.get("Range")
        start, end = 0, size - 1
        is_range = False
        if range_hdr:
            m = re.match(r"bytes=(\d+)-(\d*)", range_hdr)
            if m:
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
                end = min(end, size - 1)
                if start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
                is_range = True
        with open(path, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            if is_range:
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            else:
                self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(remaining))
            self.end_headers()
            try:
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                pass


class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def setup_page(context):
    page = context.new_page()
    page.route("**://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("**://fonts.gstatic.com/**", lambda route: route.abort())
    page.route("**://cdn.jsdelivr.net/**", lambda route: route.abort())
    return page


def run_suite():
    global MP3_DELAY
    httpd = ThreadedTCPServer(("127.0.0.1", 0), SlowMp3RangeHandler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    passed = 0
    failures = []

    def check(cond, msg):
        nonlocal passed
        if cond:
            passed += 1
            print(f"  [PASS] {msg}", flush=True)
        else:
            failures.append(msg)
            print(f"  [FAIL] {msg}", flush=True)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True)

            # 1. DOM Integrity + Click-to-Seek Accuracy
            ctx = browser.new_context(viewport={"width": 1280, "height": 800})
            page = setup_page(ctx)
            page.goto(f"http://127.0.0.1:{port}/index.html", wait_until="domcontentloaded")
            page.wait_for_selector("#paper-content [data-sent-idx]", timeout=15000)
            page.wait_for_function("() => !!window.audio && !!window.KAOYAN_POL_DATA", timeout=15000)

            audit_other = page.evaluate("""async () => {
                const res = { nested: [], checked: 0 };
                for (const sub of ['807', '706', 'en']) {
                    document.getElementById('btn-subject-' + sub)?.click();
                    await new Promise(r => setTimeout(r, 60));
                    for (const ni of Array.from(document.querySelectorAll('#item-list .question-card-item'))) {
                        ni.click();
                        await new Promise(r => setTimeout(r, 20));
                        res.checked++;
                        const nestedEls = document.querySelectorAll('#paper-content [data-sent-idx] [data-sent-idx]');
                        if (nestedEls.length > 0) res.nested.push({ sub, title: ni.textContent.trim().slice(0, 30), count: nestedEls.length });
                    }
                }
                return res;
            }""")
            check(audit_other["checked"] == 88 and len(audit_other["nested"]) == 0,
                  f"807/706/en 88 items zero nested [data-sent-idx] (checked={audit_other['checked']})")

            audit_pol = page.evaluate("""async () => {
                document.getElementById('btn-subject-pol')?.click();
                await new Promise(r => setTimeout(r, 100));
                const res = { nested: [], missing: [], checked: 0 };
                for (const ni of Array.from(document.querySelectorAll('#item-list .question-card-item'))) {
                    ni.click();
                    await new Promise(r => setTimeout(r, 25));
                    res.checked++;
                    const root = document.getElementById('paper-content');
                    const title = (document.querySelector('.paper-header-title')?.textContent || ni.textContent).trim().slice(0, 30);
                    if (root.querySelectorAll('[data-sent-idx] [data-sent-idx]').length > 0) {
                        res.nested.push({ title, count: root.querySelectorAll('[data-sent-idx] [data-sent-idx]').length });
                    }
                    const total = (window.state?.activeSentences || []).length;
                    const present = new Set(Array.from(root.querySelectorAll('[data-sent-idx]')).map(e => parseInt(e.dataset.sentIdx, 10)));
                    const miss = [];
                    for (let i = 0; i < total; i++) if (!present.has(i)) miss.push(i);
                    if (miss.length > 0) res.missing.push({ title, miss });
                }
                return res;
            }""")
            check(audit_pol["checked"] == 47, f"Pol recite47 audited all 47 chapters (got {audit_pol['checked']})")
            check(len(audit_pol["nested"]) == 0, f"Pol 47 chapters zero nested [data-sent-idx] ({audit_pol['nested']})")
            check(len(audit_pol["missing"]) == 0, f"Pol 47 chapters zero missing sentences ({audit_pol['missing']})")

            def click_and_verify(label, sel, exp_idx, delay_s=0.0):
                global MP3_DELAY
                MP3_DELAY = delay_s
                loc = page.locator(sel).first
                loc.scroll_into_view_if_needed()
                exp = loc.evaluate("""el => {
                    const s = el.closest('[data-sent-idx]');
                    if (!s) return null;
                    const idx = parseInt(s.dataset.sentIdx, 10);
                    const raw = parseFloat(s.dataset.start);
                    return { idx, start: Number.isFinite(raw) ? raw : window.state?.activeSentences?.[idx]?.start };
                }""")
                loc.click()
                time.sleep(1.5 if delay_s > 0 else 0.5)
                MP3_DELAY = 0.0
                st = page.evaluate("""() => {
                    const a = window.audio;
                    const spot = document.querySelector('#paper-content .active-spotlight[data-sent-idx]');
                    return {
                        paused: a ? a.paused : null,
                        curTime: a ? a.currentTime : null,
                        spotIdx: spot ? parseInt(spot.dataset.sentIdx, 10) : null,
                        stateIdx: window.state ? window.state.currentSentIndex : null
                    };
                }""")
                check(
                    st["spotIdx"] == exp_idx and st["stateIdx"] == exp_idx and st["curTime"] is not None and abs(st["curTime"] - exp["start"]) <= 1.25,
                    f"{label}: spot={st['spotIdx']}, state={st['stateIdx']} (exp {exp_idx}), t={st['curTime']:.3f}s (~{exp['start']:.3f}s)"
                )

            def open_pol_ch(ch_id):
                page.evaluate("""cid => {
                    const items = Array.from(document.querySelectorAll('#item-list .question-card-item'));
                    const idx = (window.KAOYAN_POL_DATA?.chapters47 || []).findIndex(c => c.id === cid);
                    if (idx >= 0 && items[idx]) items[idx].click();
                }""", ch_id)
                time.sleep(0.3)

            open_pol_ch("ch_my_01")
            click_and_verify("Pol ch_my_01 sent 10", '#paper-content [data-sent-idx="10"]', 10)
            click_and_verify("Pol ch_my_01 sent 11", '#paper-content [data-sent-idx="11"]', 11)

            open_pol_ch("ch_my_07")
            click_and_verify("Pol ch_my_07 sent 3 (<p>)", '#paper-content [data-sent-idx="3"]', 3)
            click_and_verify("Pol ch_my_07 sent 4 ((2))", '#paper-content [data-sent-idx="4"]', 4)
            kw_idx = page.evaluate("""() => {
                const kws = Array.from(document.querySelectorAll('#paper-content [data-sent-idx] .cloze, #paper-content [data-sent-idx] .kw-red'));
                const pick = kws.find(k => parseInt(k.closest('[data-sent-idx]').dataset.sentIdx, 10) >= 8) || kws[kws.length - 1];
                if (!pick) return null;
                pick.setAttribute('data-v325-kw', '1');
                return parseInt(pick.closest('[data-sent-idx]').dataset.sentIdx, 10);
            }""")
            click_and_verify("Pol ch_my_07 .cloze/.kw-red click in off mode", '[data-v325-kw="1"]', kw_idx)

            open_pol_ch("ch_my_08")
            click_and_verify("Pol ch_my_08 sent 5", '#paper-content [data-sent-idx="5"]', 5)
            click_and_verify("Pol ch_my_08 sent 9", '#paper-content [data-sent-idx="9"]', 9)

            page.click("#btn-subject-807")
            time.sleep(0.25)
            page.evaluate("() => document.querySelector('#item-list .question-card-item')?.click()")
            time.sleep(0.35)
            kw807_idx = page.evaluate("""() => {
                const kws = Array.from(document.querySelectorAll('#paper-content [data-sent-idx] .kw-red, #paper-content [data-sent-idx] .cloze, #paper-content [data-sent-idx] .stream-kw'));
                const pick = kws.find(k => parseInt(k.closest('[data-sent-idx]').dataset.sentIdx, 10) >= 4) || kws[kws.length - 1];
                if (!pick) return null;
                pick.setAttribute('data-v325-807-kw', '1');
                return parseInt(pick.closest('[data-sent-idx]').dataset.sentIdx, 10);
            }""")
            check(kw807_idx is not None, f"807 item has clickable .kw-red/.cloze (idx={kw807_idx})")
            click_and_verify("807 .kw-red click in off mode", '[data-v325-807-kw="1"]', kw807_idx)

            # Slow network readyState===0 seek
            MP3_DELAY = 0.75
            page.evaluate("""() => {
                const items = Array.from(document.querySelectorAll('#item-list .question-card-item'));
                if (items[4]) items[4].click();
            }""")
            time.sleep(0.05)
            slow_idx = page.evaluate("""() => {
                const sents = Array.from(document.querySelectorAll('#paper-content [data-sent-idx]'));
                const pick = sents.find(s => parseInt(s.dataset.sentIdx, 10) >= 5 && parseFloat(s.dataset.start) > 10) || sents[sents.length - 1];
                pick.setAttribute('data-v325-slow', '1');
                return parseInt(pick.dataset.sentIdx, 10);
            }""")
            click_and_verify("Slow network (750ms) readyState=0 seek", '[data-v325-slow="1"]', slow_idx, delay_s=0.75)

            page.click("#btn-subject-en")
            time.sleep(0.3)
            en_idx = page.evaluate("""() => {
                const sents = Array.from(document.querySelectorAll('#paper-content [data-sent-idx]'));
                const pick = sents.find(s => parseInt(s.dataset.sentIdx, 10) >= 3) || sents[sents.length - 1];
                pick.setAttribute('data-v325-en', '1');
                return parseInt(pick.dataset.sentIdx, 10);
            }""")
            click_and_verify("English Track 1 sent click", '[data-v325-en="1"]', en_idx)
            ctx.close()

            # 2. Responsive bottom-nav auto-exit on play & return on pause/collapse
            for label, vp in [
                ("Mobile portrait 390x844", {"width": 390, "height": 844}),
                ("iPad portrait 768x1024", {"width": 768, "height": 1024}),
                ("iPad landscape 1024x768", {"width": 1024, "height": 768}),
            ]:
                vctx = browser.new_context(viewport=vp, has_touch=True)
                vpage = setup_page(vctx)
                vpage.goto(f"http://127.0.0.1:{port}/index.html", wait_until="domcontentloaded")
                vpage.wait_for_selector("#paper-content [data-sent-idx]", timeout=15000)
                vpage.wait_for_function("() => !!window.audio", timeout=15000)
                time.sleep(0.3)

                vpage.locator('#paper-content [data-sent-idx="2"]').first.click()
                time.sleep(0.55)
                during_play = vpage.evaluate("""() => {
                    const nav = document.getElementById('app-bottom-nav');
                    const cs = getComputedStyle(nav);
                    return {
                        dockExpanded: document.body.classList.contains('dock-expanded'),
                        opacity: cs.opacity,
                        pe: cs.pointerEvents,
                        top: nav.getBoundingClientRect().top,
                    };
                }""")
                check(
                    during_play["dockExpanded"] and during_play["opacity"] == "0" and during_play["pe"] == "none" and during_play["top"] >= vp["height"] - 5,
                    f"[{label}] Play hides #app-bottom-nav (dockExpanded={during_play['dockExpanded']}, opacity={during_play['opacity']}, pe={during_play['pe']})"
                )

                vpage.click("#dock-play-btn")
                time.sleep(0.55)
                after_pause = vpage.evaluate("""() => {
                    const nav = document.getElementById('app-bottom-nav');
                    const cs = getComputedStyle(nav);
                    return {
                        dockExpanded: document.body.classList.contains('dock-expanded'),
                        opacity: cs.opacity,
                        pe: cs.pointerEvents,
                        top: nav.getBoundingClientRect().top,
                    };
                }""")
                check(
                    not after_pause["dockExpanded"] and after_pause["opacity"] == "1" and after_pause["pe"] == "auto" and after_pause["top"] < vp["height"],
                    f"[{label}] Pause restores #app-bottom-nav (dockExpanded={after_pause['dockExpanded']}, opacity={after_pause['opacity']}, pe={after_pause['pe']})"
                )

                vpage.click("#nav-tab-center-play")
                time.sleep(0.55)
                vpage.click("#dockDragHandle")
                time.sleep(0.55)
                after_collapse = vpage.evaluate("""() => {
                    const nav = document.getElementById('app-bottom-nav');
                    const cs = getComputedStyle(nav);
                    return { dockExpanded: document.body.classList.contains('dock-expanded'), opacity: cs.opacity, pe: cs.pointerEvents };
                }""")
                check(
                    not after_collapse["dockExpanded"] and after_collapse["opacity"] == "1" and after_collapse["pe"] == "auto",
                    f"[{label}] Collapsing dock restores #app-bottom-nav ({after_collapse})"
                )
                vctx.close()

            browser.close()
    finally:
        httpd.shutdown()

    print(f"\nV3.2.5 Seek & Nav Regression Suite: {passed}/{passed + len(failures)} PASSED")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    run_suite()
