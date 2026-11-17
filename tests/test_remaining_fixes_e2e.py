"""Regression tests using production closures and DOM; external requests are blocked."""
import json
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright
from test_v348_audit_fixes_e2e import start_server, setup_isolated_context

ROOT = Path(__file__).resolve().parents[1]


def main():
    server, port = start_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True)
            context, page = setup_isolated_context(browser, port)
            page.add_init_script("""
                window.auditMediaHandlers = {};
                if (navigator.mediaSession) {
                    navigator.mediaSession.setActionHandler = (name, handler) => {
                        window.auditMediaHandlers[name] = handler;
                    };
                }
            """)

            def instrument(route):
                name = urlsplit(route.request.url).path.rsplit('/', 1)[-1]
                source = (ROOT / name).read_text(encoding="utf-8")
                exports = (
                    "window.auditApp = { setItemListenCount, recomputeListenAggregates, "
                    "enhanceClozeKeywords, renderPaperContent, resetDynamicClozeDom };"
                    if name == "app.js" else
                    "window.auditSync = { mergeStudyLogsWithRemote, mergeSyncBucketPair };"
                )
                end = source.rfind('})();')
                assert end > 0
                route.fulfill(content_type="application/javascript", body=source[:end] + exports + source[end:])

            page.route("**/app.js*", instrument)
            page.route("**/ai_sync.js*", instrument)
            page.goto(f"http://127.0.0.1:{port}/index.html", wait_until="domcontentloaded")
            page.wait_for_function("() => window.auditSync && window.auditApp && window.state.activeSentences.length > 5")

            results = page.evaluate("""async () => {
                const audio = window.audio;
                let time = 0, paused = true;
                Object.defineProperties(audio, {
                    currentTime: { configurable: true, get: () => time, set: v => { time = Number(v); } },
                    paused: { configurable: true, get: () => paused },
                    readyState: { configurable: true, get: () => 4 },
                    duration: { configurable: true, get: () => 600 }
                });
                audio.play = () => { paused = false; audio.dispatchEvent(new Event('play')); return Promise.resolve(); };
                audio.pause = () => { paused = true; audio.dispatchEvent(new Event('pause')); };
                state.loopGapMs = 0;
                document.getElementById('btn-range-pick').click();
                const spans = document.querySelectorAll('#paper-content .recite-sent');
                spans[0].click(); spans[1].click();
                document.querySelector('#rangeLoopRepsPills [data-range-rep="2"]').click();
                const start = state.activeSentences[0].start, end = state.activeSentences[1].end;
                const finish = () => { time = end + 0.05; audio.dispatchEvent(new Event('ended')); };
                const results = [];
                for (const entry of ['page', 'media', 'bridge']) {
                    state.loopCount = 0; state.rangeSelection.completed = false;
                    time = start; await audio.play(); finish(); finish();
                    const completed = paused && state.rangeSelection.completed;
                    if (entry === 'page') document.getElementById('dock-play-btn').click();
                    if (entry === 'media') auditMediaHandlers.play();
                    if (entry === 'bridge') __kaoyanBridge.play();
                    const restarted = !paused && !state.rangeSelection.completed && state.loopCount === 0 && Math.abs(time - start) < 0.05;
                    finish();
                    const fullFirstPass = !paused && state.loopCount === 1;
                    finish();
                    results.push({ entry, completed, restarted, fullFirstPass, finished: paused && state.rangeSelection.completed });
                }
                return results;
            }""")
            assert all(all(v for k, v in row.items() if k != 'entry') for row in results), results
            print("[PASS] Page, MediaSession and bridge each replay two complete range passes", flush=True)

            logs = page.evaluate("""() => {
                audio.pause();
                document.getElementById('btn-range-exit').click();
                const b = __kaoyanBridge, app = auditApp, sync = auditSync;
                localStorage.setItem('kaoyan_device_id', 'dev_audit_pc');
                const day = '2026-11-17';
                const bucket = (seconds, count) => ({ dailyListenSec: { [day]: seconds }, totalListenSec: seconds,
                    itemListenCounts: { audit: count } });
                b.applyMergedStudyLogs({ dailyListenSec: { [day]: 120 }, totalListenSec: 120,
                    itemListenCounts: { audit: 5 }, legacyListen: bucket(100, 4),
                    deviceBuckets: { dev_audit_pc: bucket(20, 1) } });
                const oldRemote = { dailyListenSec: { [day]: 150 }, totalListenSec: 150, itemListenCounts: { audit: 7 } };
                sync.mergeStudyLogsWithRemote(oldRemote);
                const imported = b.getStudyLogs();
                app.recomputeListenAggregates(state.studyLogs);
                const recomputed = b.getStudyLogs();
                sync.mergeStudyLogsWithRemote(oldRemote);
                const repeated = b.getStudyLogs();
                const snapshot = b.getStudyLogs();
                app.setItemListenCount('audit', 6);
                sync.mergeStudyLogsWithRemote(snapshot);
                sync.mergeStudyLogsWithRemote(oldRemote);
                app.recomputeListenAggregates(state.studyLogs);
                const afterUndo = b.getStudyLogs();
                app.setItemListenCount('audit', 0);
                const zeroSnapshot = b.getStudyLogs();
                sync.mergeStudyLogsWithRemote(snapshot);
                const afterZero = b.getStudyLogs();

                // A negative-only device bucket must survive serialization and a round trip.
                b.applyMergedStudyLogs({ legacyListen: bucket(100, 5), deviceBuckets: {},
                    dailyListenSec: { [day]: 100 }, totalListenSec: 100, itemListenCounts: { audit: 5 } });
                const beforeRemoteUndo = b.getStudyLogs();
                app.setItemListenCount('audit', 4);
                const decrementOnly = b.getStudyLogs();
                b.applyMergedStudyLogs(beforeRemoteUndo);
                sync.mergeStudyLogsWithRemote(decrementOnly);
                const remoteUndo = b.getStudyLogs();

                // Independent devices' increments and corrections must commute and remain idempotent.
                const left = { ...beforeRemoteUndo, deviceBuckets: { phone: { ...bucket(10, 2), itemListenDecrements: { audit: 1 } } } };
                const right = { ...beforeRemoteUndo, deviceBuckets: { tablet: bucket(20, 3) } };
                b.applyMergedStudyLogs(left); sync.mergeStudyLogsWithRemote(right);
                const lr = b.getStudyLogs();
                sync.mergeStudyLogsWithRemote(right);
                const lrAgain = b.getStudyLogs();
                b.applyMergedStudyLogs(right); sync.mergeStudyLogsWithRemote(left);
                const rl = b.getStudyLogs();

                const preUpgrade = { dailyListenSec: { [day]: 150 }, totalListenSec: 150,
                    itemListenCounts: { audit: 7 }, legacyListen: bucket(100, 4),
                    deviceBuckets: { dev_audit_pc: bucket(20, 1) } };
                b.applyMergedStudyLogs({ ...preUpgrade, dailyListenSec: { [day]: 120 }, totalListenSec: 120,
                    itemListenCounts: { audit: 5 } });
                sync.mergeStudyLogsWithRemote(preUpgrade);
                app.recomputeListenAggregates(state.studyLogs);
                const migratedPeer = b.getStudyLogs();
                b.applyMergedStudyLogs(afterUndo);
                return { imported, recomputed, repeated, afterUndo, zeroSnapshot, afterZero,
                    decrementOnly, remoteUndo, lr, lrAgain, rl, migratedPeer };
            }""")
            for key in ("imported", "recomputed", "repeated"):
                assert logs[key]["totalListenSec"] == 150, (key, logs[key])
                assert logs[key]["itemListenCounts"]["audit"] == 7, (key, logs[key])
            assert logs["afterUndo"]["itemListenCounts"]["audit"] == 6, logs["afterUndo"]
            assert logs["afterZero"]["itemListenCounts"].get("audit", 0) == 0, logs["afterZero"]
            assert logs["remoteUndo"]["itemListenCounts"]["audit"] == 4, logs["remoteUndo"]
            assert logs["migratedPeer"]["totalListenSec"] == 150 and logs["migratedPeer"]["itemListenCounts"]["audit"] == 7, logs["migratedPeer"]
            for key in ("lr", "lrAgain", "rl"):
                assert logs[key]["itemListenCounts"]["audit"] == 9, (key, logs[key])
                assert logs[key]["totalListenSec"] == 130, (key, logs[key])
            print("[PASS] Legacy floors persist; repeated merges and recomputation do not change totals", flush=True)
            print("[PASS] Undo, reset to zero and remote decrement-only buckets survive stale snapshots", flush=True)
            print("[PASS] Independent device increments and decrements merge commutatively and idempotently", flush=True)

            # Reload exercises the saved-data schema, not only in-memory recomputation.
            page.reload(wait_until="domcontentloaded")
            page.wait_for_function("() => window.auditApp && window.__kaoyanBridge && state.activeSentences.length > 5")
            persisted = page.evaluate("() => __kaoyanBridge.getStudyLogs()")
            assert persisted["totalListenSec"] == 150 and persisted["itemListenCounts"]["audit"] == 6, persisted
            print("[PASS] Migration baseline and undo survive a browser reload", flush=True)

            cloze = page.evaluate("""() => {
                const paper = document.getElementById('paper-content');
                const failures = [], stats = { items: 0, all: 0, skeleton: 0, scoring: 0 };
                const inspect = (term, tier) => {
                    const walker = document.createTreeWalker(paper, NodeFilter.SHOW_TEXT);
                    let node, text = '', mask = [];
                    while ((node = walker.nextNode())) {
                        const blank = node.parentElement.closest('.cloze-blank:not(.revealed)');
                        const covered = !!blank && (tier === 'all' || blank.dataset.clozeTier === tier);
                        text += node.nodeValue;
                        mask.push(...Array(node.nodeValue.length).fill(covered));
                    }
                    let from = 0, idx, found = false;
                    while ((idx = text.indexOf(term, from)) !== -1) {
                        found = true;
                        if (mask.slice(idx, idx + term.length).every(Boolean)) return true;
                        from = idx + 1;
                    }
                    return false;
                };
                for (const subject of ['706', '807']) {
                    for (const item of state.allData['items_' + subject]) {
                        state.currentSubject = subject;
                        state.currentTrack = 1;
                        state.activeItemId = item.id;
                        state.activeItem = item;
                        state.clozeMode = 'keyword';
                        auditApp.renderPaperContent(item.track1, []);
                        const originalText = paper.textContent;
                        const originalIds = [...paper.querySelectorAll('[data-sent-id]')].map(n => n.dataset.sentId).join('|');
                        const originalStrong = paper.querySelectorAll('strong').length;
                        const data = __kaoyanBridge.getAiClozeData(item.id);
                        stats.items++;
                        for (const filter of ['all', 'skeleton', 'scoring', 'all']) {
                            state.clozeFilterMode = filter;
                            auditApp.enhanceClozeKeywords();
                            if (paper.textContent !== originalText || paper.querySelectorAll('strong').length !== originalStrong ||
                                [...paper.querySelectorAll('[data-sent-id]')].map(n => n.dataset.sentId).join('|') !== originalIds) {
                                failures.push({ item: item.id, filter, reason: 'DOM structure/text changed' });
                            }
                            for (const field of filter === 'all' ? ['skeleton', 'scoring'] : [filter]) {
                                for (const term of data[field]) {
                                    if (!inspect(term, filter)) failures.push({ item: item.id, filter, term });
                                    stats[filter]++;
                                }
                            }
                            // Clicking one fragment reveals and hides the entire phrase.
                            const groups = new Map();
                            paper.querySelectorAll('[data-cloze-group]').forEach(n => {
                                const group = groups.get(n.dataset.clozeGroup) || [];
                                group.push(n); groups.set(n.dataset.clozeGroup, group);
                            });
                            const multi = [...groups.values()].find(nodes => nodes.length > 1);
                            if (multi) {
                                multi[0].click();
                                if (!multi.every(n => n.classList.contains('revealed'))) failures.push({ item: item.id, reason: 'partial group reveal' });
                                multi[multi.length - 1].click();
                                if (!multi.every(n => !n.classList.contains('revealed'))) failures.push({ item: item.id, reason: 'partial group hide' });
                            }
                        }
                        auditApp.resetDynamicClozeDom();
                        if (paper.querySelector('[data-ai-cloze], [data-cloze-group]')) failures.push({ item: item.id, reason: 'reset leaked wrappers' });
                    }
                }
                return { stats, failures };
            }""")
            assert not cloze["failures"], json.dumps(cloze, ensure_ascii=False)
            print(f"[PASS] Full built-in cloze coverage in all three filters: {cloze['stats']}", flush=True)
            print("[PASS] Cross-tag group reveal/reset preserves text, strong elements and sentence IDs", flush=True)
            context.close()

            # Load uninstrumented production resources under the real service worker.
            context = browser.new_context(service_workers="allow")
            context.route("**/*", lambda route: route.continue_()
                          if urlsplit(route.request.url).hostname in ("127.0.0.1", "localhost") else route.abort())
            page = context.new_page()
            page.goto(f"http://127.0.0.1:{port}/favicon.svg")
            page.evaluate("""async () => {
                for (const name of ['kaoyan-all-in-one-v3.4.10', 'audit-unrelated-cache']) {
                    const cache = await caches.open(name);
                    await cache.put('/audit-sentinel', new Response('preserve unrelated caches'));
                }
            }""")
            page.goto(f"http://127.0.0.1:{port}/index.html", wait_until="domcontentloaded")
            page.wait_for_function("() => navigator.serviceWorker.controller && window.__kaoyanBridge")
            installed = page.evaluate("""async () => {
                const version = await (await fetch('version.json')).json();
                const name = 'kaoyan-all-in-one-v' + version.version;
                const cache = await caches.open(name);
                return { version: version.version, names: await caches.keys(),
                    app: !!(await cache.match('./app.js?v=' + version.version)),
                    data: !!(await cache.match('./data/kaoyan_data.js?v=' + version.version)) };
            }""")
            assert installed["app"] and installed["data"], installed
            assert "kaoyan-all-in-one-v3.4.10" not in installed["names"], installed
            assert "audit-unrelated-cache" in installed["names"], installed
            context.set_offline(True)
            page.reload(wait_until="domcontentloaded")
            page.wait_for_function("() => window.__kaoyanBridge && state.activeSentences.length > 5")
            offline = page.evaluate("""() => {
                state.clozeMode = 'keyword';
                __kaoyanBridge.refreshCloze();
                return { items: Object.keys(window.KAOYAN_BUILTIN_CLOZE).length,
                    text: document.getElementById('paper-content').textContent.length,
                    blanks: document.querySelectorAll('[data-ai-cloze="1"]').length };
            }""")
            assert offline["items"] == 82 and offline["text"] > 100 and offline["blanks"] > 0, offline
            print(f"[PASS] PWA {installed['version']} upgrades caches and opens offline with built-in cloze", flush=True)
            context.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
