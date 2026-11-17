# -*- coding: utf-8 -*-
"""
Targeted Playwright E2E regression tests for v3.4.8 audit fixes (#1-#22):
- Blocks all external hosts (never hits sync.2026706.xyz or DeepSeek).
- Exercises:
  #1  Track switch invalidates stale loadedmetadata/canplay seek & play callbacks
  #2  Manual seek (forward/rewind/progress bar) cancels pending sentence seek
  #3  Mode switch or startRangePicking during loop gap wait leaves consistent state
  #4  Pol Track 2 subCard switch clears stale range selection & DOM highlight
  #5  Finite range replay resets to startIdx and plays full repeat count
  #6  Mutation during active sync schedules followup push before clearing syncDirty
  #11 Range pick registers cleanly under keyword and body cloze modes
  #15 Per-device buckets add listen duration/counts without doubling legacyListen
  #16 Cross-device chatThreads sync without leaking __sys_chat_threads__ into aiMemories
  #19 POST /api/ai/cloze checks HTTP response ok before succeeding
  #20 AI item/quote jump pills render inline <svg> with zero UI emojis
"""

import http.server
import json
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


def setup_isolated_context(browser, port):
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, service_workers="block")
    page = ctx.new_page()

    def block_external(route):
        url = route.request.url
        if (
            url.startswith(f"http://127.0.0.1:{port}")
            or url.startswith(f"http://localhost:{port}")
            or url.startswith("data:")
            or url.startswith("blob:")
        ):
            route.continue_()
        else:
            route.abort()

    page.route("**/*", block_external)
    return ctx, page


def main():
    httpd, port = start_server()
    base_url = f"http://127.0.0.1:{port}/index.html"
    passed = 0
    total = 0

    def check(cond, name, detail=""):
        nonlocal passed, total
        total += 1
        if cond:
            passed += 1
            print(f"  [PASS] {name}", flush=True)
        else:
            print(f"  [FAIL] {name} :: {detail}", flush=True)
            raise AssertionError(f"{name}: {detail}")

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)

        # ------------------------------------------------------------------
        # Group A: Audio state machine & range loop (#1, #2, #3, #4, #5, #11)
        # ------------------------------------------------------------------
        ctx, page = setup_isolated_context(browser, port)
        page.goto(base_url, wait_until="domcontentloaded", timeout=25000)
        page.wait_for_function(
            "() => !!window.__kaoyanBridge && !!window.state && !!window.state.activeSentences && window.state.activeSentences.length > 5 && !!window.KAOYAN_POL_DATA",
            timeout=25000,
        )

        # Test #11: Range pick priority under keyword + body cloze
        res11 = page.evaluate("""() => {
          window.__kaoyanBridge.pause();
          const clozeBtn = document.getElementById('btn-cloze-mode');
          clozeBtn.click(); // -> keyword
          const btnStartRange = document.getElementById('btn-range-pick');
          btnStartRange.click();
          const kwEl = document.querySelector('#paper-content .recite-sent .cloze, #paper-content .recite-sent .kw-red');
          const sents = document.querySelectorAll('#paper-content .recite-sent');
          const s1 = kwEl ? kwEl.closest('.recite-sent') : sents[1];
          const s3 = sents[3];
          (kwEl || s1).click();
          const afterFirst = window.state.rangeSelection.step;
          s3.click();
          const rsKw = { ...window.state.rangeSelection };
          document.getElementById('btn-range-exit').click();

          clozeBtn.click(); // -> body
          btnStartRange.click();
          const s2 = document.querySelectorAll('#paper-content .recite-sent')[2];
          const s4 = document.querySelectorAll('#paper-content .recite-sent')[4];
          s2.click();
          s4.click();
          const rsBody = { ...window.state.rangeSelection };
          document.getElementById('btn-range-exit').click();
          clozeBtn.click(); // -> off
          return { afterFirst, rsKw, rsBody };
        }""")
        check(
            res11["afterFirst"] == "pick-end" and res11["rsKw"]["step"] == "ready" and res11["rsBody"]["step"] == "ready",
            "#11 Range pick registers cleanly under keyword and body cloze modes",
            json.dumps(res11),
        )

        # Test #1 & #2: Stale loadedmetadata callback & manual seek cancelling pending seek
        res12 = page.evaluate("""() => {
          const a = window.audio;
          let fakeTime = 0;
          let fakeReady = 0;
          let playCalls = 0;
          Object.defineProperty(a, 'readyState', { configurable: true, get: () => fakeReady });
          Object.defineProperty(a, 'currentTime', {
            configurable: true,
            get: () => fakeTime,
            set: (v) => { fakeTime = Number(v) || 0; }
          });
          Object.defineProperty(a, 'duration', { configurable: true, get: () => 240 });
          a.play = () => { playCalls++; return Promise.resolve(); };
          a.pause = () => {};

          // #2: click sentence -> unready -> manual forward seek -> metadata arrives
          const sents = document.querySelectorAll('#paper-content .recite-sent');
          sents[5].click();
          fakeTime = 12;
          document.getElementById('dock-forward-btn').click();
          const manualAfterClick = fakeTime;
          fakeReady = 3;
          a.dispatchEvent(new Event('loadedmetadata'));
          a.dispatchEvent(new Event('canplay'));
          const timeAfterReady = fakeTime;

          // #1: click sentence 8 while unready -> switch to Track 2 -> metadata fires
          fakeReady = 0;
          fakeTime = 0;
          playCalls = 0;
          sents[8].click();
          document.getElementById('tab-track-2').click();
          fakeTime = 0;
          fakeReady = 3;
          const playsRightAfterSwitch = playCalls;
          a.dispatchEvent(new Event('loadedmetadata'));
          a.dispatchEvent(new Event('canplay'));
          return {
            manualAfterClick,
            timeAfterReady,
            timeAfterSwitchMeta: fakeTime,
            playsDelta: playCalls - playsRightAfterSwitch
          };
        }""")
        check(
            abs(res12["manualAfterClick"] - res12["timeAfterReady"]) < 0.01,
            "#2 Manual seek cancels pending sentence seek on slow metadata arrival",
            json.dumps(res12),
        )
        check(
            res12["timeAfterSwitchMeta"] == 0 and res12["playsDelta"] == 0,
            "#1 Track switch invalidates previous track seek/play listeners",
            json.dumps(res12),
        )
        ctx.close()

        # Fresh context cleanly for #3, #4, #5
        ctx, page = setup_isolated_context(browser, port)
        page.goto(base_url, wait_until="domcontentloaded", timeout=25000)
        page.wait_for_function(
            "() => !!window.__kaoyanBridge && !!window.state && !!window.state.activeSentences && window.state.activeSentences.length > 5 && !!window.KAOYAN_POL_DATA",
            timeout=25000,
        )

        # Test #5: Finite range loop completes 2 passes cleanly and pressing Play restarts pass 1 at startIdx
        res5 = page.evaluate("""async () => {
          const a = window.audio;
          let curT = 0;
          let paused = true;
          Object.defineProperty(a, 'readyState', { configurable: true, get: () => 4 });
          Object.defineProperty(a, 'duration', { configurable: true, get: () => 240 });
          Object.defineProperty(a, 'paused', { configurable: true, get: () => paused });
          Object.defineProperty(a, 'currentTime', {
            configurable: true,
            get: () => curT,
            set: (v) => { curT = Number(v) || 0; }
          });
          a.play = () => { paused = false; a.dispatchEvent(new Event('play')); return Promise.resolve(); };
          a.pause = () => { paused = true; a.dispatchEvent(new Event('pause')); };

          window.state.loopGapMs = 0;
          document.getElementById('btn-range-pick').click();
          const spans = document.querySelectorAll('#paper-content .recite-sent');
          spans[0].click();
          spans[1].click();
          document.querySelector('#rangeLoopRepsPills [data-range-rep="2"]').click();

          const s0Start = window.state.activeSentences[0].start;
          const s1End = window.state.activeSentences[1].end;
          window.state.loopCount = 0;
          curT = s0Start;
          await a.play();

          // Pass 1 end
          curT = s1End + 0.05;
          a.dispatchEvent(new Event('ended'));
          const afterPass1LoopCount = window.state.loopCount;
          const afterPass1Playing = !paused;

          // Pass 2 end -> finishes 2 passes
          curT = s1End + 0.05;
          a.dispatchEvent(new Event('ended'));
          const afterPass2Paused = paused;
          const completedFlag = Boolean(window.state.rangeSelection.completed);

          // User presses Play again -> seeks back to startIdx and starts pass 1 cleanly
          document.getElementById('dock-play-btn').click();
          return {
            afterPass1LoopCount,
            afterPass1Playing,
            afterPass2Paused,
            completedFlag,
            restartedTime: curT,
            s0Start,
            restartedLoopCount: window.state.loopCount,
            restartedPaused: paused
          };
        }""")
        check(
            res5["afterPass1LoopCount"] == 1
            and res5["afterPass1Playing"]
            and res5["afterPass2Paused"]
            and res5["completedFlag"]
            and abs(res5["restartedTime"] - res5["s0Start"]) < 0.05
            and res5["restartedLoopCount"] == 0
            and not res5["restartedPaused"],
            "#5 Finite range replay resets to startIdx and delivers full repeat count",
            json.dumps(res5),
        )

        # Test #3: Switching playMode or starting range pick during loop gap wait leaves consistent state
        res3 = page.evaluate("""async () => {
          const a = window.audio;
          let curT = 0;
          let paused = true;
          Object.defineProperty(a, 'paused', { configurable: true, get: () => paused });
          Object.defineProperty(a, 'currentTime', {
            configurable: true,
            get: () => curT,
            set: (v) => { curT = Number(v) || 0; }
          });
          a.play = () => { paused = false; a.dispatchEvent(new Event('play')); return Promise.resolve(); };
          a.pause = () => { paused = true; a.dispatchEvent(new Event('pause')); };

          document.getElementById('btn-range-exit')?.click();
          window.state.loopGapMs = 800;
          window.state.playMode = 'sentence';
          const s0 = window.state.activeSentences[0];
          curT = s0.start;
          await a.play();
          curT = s0.end + 0.05;
          a.dispatchEvent(new Event('ended'));
          const gapPaused = paused;
          const gapStatePlaying = window.state.isPlaying;

          // Switch play mode to 'sequence' via drawer during gap wait
          window.state.loopGapMs = 0;
          document.getElementById('btn-loop-mode').click();
          const seqCard = Array.from(document.querySelectorAll('#playModeList .mode-option-card')).find(
            c => (c.querySelector('.mode-option-name')?.textContent || '').includes('按顺序依次播放')
          );
          seqCard.click();
          await new Promise(r => setTimeout(r, 350));
          const seqAligned = (window.state.isPlaying === !paused) && window.state.isPlaying;

          // Re-enter gap wait and start range picking -> both must pause cleanly
          window.state.loopGapMs = 800;
          window.state.playMode = 'sentence';
          curT = s0.end + 0.05;
          a.dispatchEvent(new Event('ended'));
          document.getElementById('btn-range-pick').click();
          const pickAligned = (window.state.isPlaying === !paused) && !window.state.isPlaying;
          document.getElementById('btn-range-exit')?.click();
          const mb = document.getElementById('playModeBackdrop');
          if (mb && getComputedStyle(mb).display !== 'none') mb.click();
          return { gapPaused, gapStatePlaying, seqAligned, pickAligned };
        }""")
        check(
            res3["gapPaused"] and res3["gapStatePlaying"] and res3["seqAligned"] and res3["pickAligned"],
            "#3 Switching playMode or entering range pick during loop gap keeps audio/UI state consistent",
            json.dumps(res3),
        )

        # Test #4: Politics Track 2 subCard range selection isolation
        page.wait_for_timeout(350)
        page.click("#btn-subject-pol")
        page.wait_for_selector('#pol-submode-bar button[data-pol-submode="recite47"]', timeout=10000)
        page.click('#pol-submode-bar button[data-pol-submode="recite47"]')
        res4 = page.evaluate("""async () => {
          document.getElementById('tab-track-2').click();
          await new Promise(r => setTimeout(r, 150));
          const chips = document.querySelectorAll('#polSubcardPills .playlist-chip-btn');
          if (chips.length < 2) throw new Error('Need >=2 pol subcards');
          chips[0].click();
          await new Promise(r => setTimeout(r, 120));
          document.getElementById('btn-range-pick').click();
          const sents = document.querySelectorAll('#polSubcardBody .recite-sentence, #polSubcardBody [data-sent-idx]');
          sents[0].click();
          sents[Math.min(1, sents.length - 1)].click();
          const beforeSwitchReady = window.state.rangeSelection.step === 'ready';
          const selectedCountBefore = document.querySelectorAll('.range-loop-selected').length;
          chips[1].click();
          await new Promise(r => setTimeout(r, 120));
          const afterSwitchStep = window.state.rangeSelection.step;
          const selectedCountAfter = document.querySelectorAll('.range-loop-selected').length;
          const rangeBarHiddenAfter = document.getElementById('rangeLoopBar').hidden;
          return { beforeSwitchReady, selectedCountBefore, afterSwitchStep, selectedCountAfter, rangeBarHiddenAfter };
        }""")
        check(
            res4["beforeSwitchReady"]
            and res4["selectedCountBefore"] > 0
            and res4["afterSwitchStep"] == "idle"
            and res4["selectedCountAfter"] == 0
            and res4["rangeBarHiddenAfter"],
            "#4 Pol Track 2 subcard switch clears stale range selection & DOM highlight",
            json.dumps(res4),
        )
        ctx.close()

        # ------------------------------------------------------------------
        # Group B: Sync Engine (#6, #15, #16, #19, #20)
        # ------------------------------------------------------------------
        ctx, page = setup_isolated_context(browser, port)

        sync_state = {
            "pulls": 0,
            "pushes": 0,
            "last_push": None,
            "pull_data": {
                "mastery": {},
                "studyLogs": {
                    "dates": ["2026-11-16"],
                    "completedIds": [],
                    "dailyListenSec": {"2026-11-16": 600, "2026-11-17": 120},
                    "totalListenSec": 720,
                    "itemListenCounts": {"item_a": 2},
                    "legacyListen": {
                        "dailyListenSec": {"2026-11-16": 600},
                        "totalListenSec": 600,
                        "itemListenCounts": {"item_a": 1}
                    },
                    "deviceBuckets": {
                        "dev_remote_phone": {
                            "dailyListenSec": {"2026-11-17": 120},
                            "totalListenSec": 120,
                            "itemListenCounts": {"item_a": 1},
                            "updatedAt": 1700000000000
                        }
                    },
                    "updatedAt": 1700000000000
                },
                "aiMemories": {
                    "__sys_chat_threads__": {
                        "kind": "system_chat_threads",
                        "text": json.dumps({
                            "807_01_T0_鲁迅_01_呐喊仿徨艺术成就_30分论述::全文": {
                                "msgs": [{"role": "user", "content": "手机端同步来的提问"}],
                                "updatedAt": 1799999999000
                            }
                        }),
                        "updatedAt": 1799999999000
                    }
                },
                "reciteLogs": [],
                "learningProfile": None,
                "ai_cloze_cache": {}
            }
        }

        def handle_sync_routes(route):
            url = route.request.url
            if url.endswith("/api/sync/pull"):
                sync_state["pulls"] += 1
                route.fulfill(status=200, content_type="application/json", body=json.dumps(sync_state["pull_data"]))
                return
            if url.endswith("/api/sync/push"):
                sync_state["pushes"] += 1
                body = json.loads(route.request.post_data or "{}")
                sync_state["last_push"] = body
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True, "merged": body}))
                return
            if url.endswith("/api/ai/cloze"):
                route.fulfill(status=500, content_type="application/json", body='{"ok":false,"message":"Simulated 500"}')
                return
            if url.startswith(f"http://127.0.0.1:{port}") or url.startswith("data:") or url.startswith("blob:"):
                route.continue_()
            else:
                route.abort()

        page.unroute("**/*")
        page.route("**/*", handle_sync_routes)
        page.goto(base_url, wait_until="domcontentloaded", timeout=25000)
        page.wait_for_function(
            "() => !!window.__kaoyanBridge && !!window.__kaoyanAiHooks && !!document.getElementById('btnCloudSyncNow')",
            timeout=25000,
        )

        res_sync = page.evaluate("""async () => {
          localStorage.setItem('kaoyan_sync_url', window.location.origin);
          localStorage.setItem('kaoyan_sync_pin', 'test-pin');
          localStorage.setItem('kaoyan_device_id', 'dev_local_pc');
          window.__kaoyanBridge.applyMergedStudyLogs({
            dates: ['2026-11-16', '2026-11-17'],
            completedIds: [],
            totalCardsCompleted: 0,
            dailyListenSec: { '2026-11-16': 600, '2026-11-17': 180 },
            totalListenSec: 780,
            itemListenCounts: { 'item_a': 2 },
            legacyListen: {
              dailyListenSec: { '2026-11-16': 600 },
              totalListenSec: 600,
              itemListenCounts: { 'item_a': 1 }
            },
            deviceBuckets: {
              dev_local_pc: {
                dailyListenSec: { '2026-11-17': 180 },
                totalListenSec: 180,
                itemListenCounts: { 'item_a': 1 },
                updatedAt: Date.now()
              }
            }
          });

          // #6: Mutate dirty mid-sync while btnCloudSyncNow runs
          const origFetch = window.fetch.bind(window);
          let delayedOnce = false;
          window.fetch = async (url, opts) => {
            if (!delayedOnce && String(url).includes('/api/sync/push')) {
              delayedOnce = true;
              setTimeout(() => {
                document.getElementById('btn-mastery-toggle').click();
              }, 30);
              await new Promise(r => setTimeout(r, 150));
            }
            return origFetch(url, opts);
          };

          document.getElementById('btnCloudSyncNow').click();
          await new Promise(r => setTimeout(r, 700));

          const logs = window.__kaoyanBridge.getStudyLogs();
          const mems = JSON.parse(localStorage.getItem('kaoyan_ai_memories') || '{}');
          const dirtyAfter = localStorage.getItem('kaoyan_sync_dirty');
          const threadsRaw = JSON.parse(localStorage.getItem('kaoyan_ai_chat_threads_v1') || '{}');
          return {
            logsDaily17: logs.dailyListenSec['2026-11-17'],
            logsDaily16: logs.dailyListenSec['2026-11-16'],
            itemACount: logs.itemListenCounts['item_a'],
            hasSysKeyInMemories: Object.prototype.hasOwnProperty.call(mems, '__sys_chat_threads__'),
            dirtyAfter,
            syncedThreadFound: Boolean((threadsRaw.entries || []).some(e => e[0].includes('鲁迅_01')))
          };
        }""")
        check(
            abs(res_sync["logsDaily17"] - 300) < 0.01
            and abs(res_sync["logsDaily16"] - 600) < 0.01
            and res_sync["itemACount"] == 3,
            "#15 Per-device buckets add listen duration/counts across devices without doubling legacyListen",
            json.dumps(res_sync),
        )
        check(
            not res_sync["hasSysKeyInMemories"] and res_sync["syncedThreadFound"],
            "#16 Cross-device chatThreads syncs cleanly without leaking __sys_chat_threads__ into aiMemories",
            json.dumps(res_sync),
        )
        check(
            res_sync["dirtyAfter"] == "0" and sync_state["pushes"] >= 2,
            "#6 Mutation during active sync schedules followup push before clearing syncDirty",
            f"dirty={res_sync['dirtyAfter']} pushes={sync_state['pushes']}",
        )

        # Test #20 zero emoji in AI jump pills (renderAiMarkdown + empty hint)
        res20 = page.evaluate("""() => {
          const item = window.state.activeItem;
          const sent0 = window.state.activeSentences[0];
          const raw = `参考 [[item:${item.id}|${item.title}]]：\\n\\n> ${sent0.text}`;
          const renderedHtml = window.__kaoyanAiHooks.renderAiMarkdown(raw, window.state.activeSentences);
          const mdContainer = document.getElementById('aiChatStream');
          const emptyHint = mdContainer ? mdContainer.innerHTML : '';
          const tmp = document.createElement('div');
          tmp.innerHTML = renderedHtml;
          const itemBtnSvg = Boolean(tmp.querySelector('.ai-item-jump svg[viewBox]'));
          const quoteBtnSvg = Boolean(tmp.querySelector('.ai-quote-jump svg[viewBox]'));
          return { renderedHtml, emptyHint, itemBtnSvg, quoteBtnSvg };
        }""")
        check(
            res20["itemBtnSvg"]
            and res20["quoteBtnSvg"]
            and ("📖" not in res20["renderedHtml"])
            and ("🔊" not in res20["renderedHtml"])
            and ("📖" not in res20["emptyHint"])
            and ("🔊" not in res20["emptyHint"]),
            "#20 AI jump pills render inline <svg> with zero 📖/🔊 emojis",
            res20["renderedHtml"],
        )

        ai_sync_src = open(os.path.join(REPO_ROOT, "ai_sync.js"), "r", encoding="utf-8").read()
        check(
            ("📖" not in ai_sync_src) and ("🔊" not in ai_sync_src),
            "#20 ai_sync.js contains zero 📖 or 🔊 emoji icons",
        )
        check(
            "if (!clozeRes.ok)" in ai_sync_src,
            "#19 POST /api/ai/cloze checks HTTP response ok before succeeding",
        )

        ctx.close()
        browser.close()

    httpd.shutdown()
    print(f"\nALL {passed}/{total} v3.4.8 AUDIT FIX REGRESSION TESTS PASSED!", flush=True)


if __name__ == "__main__":
    main()
