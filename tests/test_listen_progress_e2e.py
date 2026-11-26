"""Production player/sync tests. Media and time are controlled; no external traffic."""
import os
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
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))

            def instrument(route):
                name = urlsplit(route.request.url).path.rsplit("/", 1)[-1]
                source = (ROOT / name).read_text(encoding="utf-8")
                export = """
                    window.listenAudit = {
                        accumulateListeningTime, getListenContext, getCurrentRangeItemKey,
                        setAudioPosition, selectItem, loadTrackData, setItemListenCount, buildStudyBackupPayload, importStudyBackup,
                        reset() { listenAnchor = null; listenContext = null; rangePractice = null; listenLogsDirty = false; },
                        setSections(sections) { currentFrameworkSections = sections; listenContext = null; currentActiveSectionIndex = 0; }
                    };
                """ if name == "app.js" else """
                    window.syncAudit = { mergeStudyLogsWithRemote, buildLocalStudyLogsPayload };
                """
                end = source.rfind("})();")
                route.fulfill(content_type="application/javascript", body=source[:end] + export + source[end:])

            page.route("**/app.js*", instrument)
            page.route("**/ai_sync.js*", instrument)
            page.goto(f"http://127.0.0.1:{port}/index.html", wait_until="domcontentloaded")
            page.wait_for_function("() => window.listenAudit && window.syncAudit && state.activeSentences.length > 5")
            results = page.evaluate("""async () => {
                audio.pause();
                const A = listenAudit, L = KaoyanListen, b = __kaoyanBridge;
                const realItem = state.activeItem;
                let clock = 1000, position = 0, paused = true, seeking = false, rate = 1;
                Object.defineProperty(performance, 'now', { configurable: true, value: () => clock });
                Object.defineProperties(audio, {
                    currentTime: { configurable: true, get: () => position, set: value => {
                        seeking = true; audio.dispatchEvent(new Event('seeking'));
                        position = Number(value); seeking = false; audio.dispatchEvent(new Event('seeked'));
                    } },
                    paused: { configurable: true, get: () => paused },
                    seeking: { configurable: true, get: () => seeking },
                    duration: { configurable: true, get: () => 600 },
                    readyState: { configurable: true, get: () => 4 },
                    playbackRate: { configurable: true, get: () => rate, set: value => {
                        rate = Number(value); audio.dispatchEvent(new Event('ratechange'));
                    } }
                });
                audio.play = () => { paused = false; audio.dispatchEvent(new Event('play')); return Promise.resolve(); };
                audio.pause = () => { paused = true; audio.dispatchEvent(new Event('pause')); };
                const sections = [{ start: 0, end: 60, index: 0, badge: '段一' },
                    { start: 60, end: 600, index: 1, badge: '段二' }];
                const sentences = Array.from({ length: 10 }, (_, i) => ({ id: i, start: i * 60, end: (i + 1) * 60 }));
                function reset(initial = {}) {
                    paused = true; position = 0; rate = 1;
                    localStorage.setItem('kaoyan_device_id', 'dev_audit_pc');
                    state.isPlaying = false; state.playMode = 'sequence'; state.loopGapMs = 0; state.speed = 1;
                    state.activeItem = realItem; state.activeItemId = realItem.id; state.currentSubject = '807'; state.currentTrack = 1;
                    state.activeSentences = sentences; state.currentSentIndex = 0;
                    audio.setAttribute('src', 'audio_cards/audit-no-network.mp3');
                    A.reset(); A.setSections(sections);
                    b.applyMergedStudyLogs({ dates: [], ...initial });
                    A.reset();
                }
                function jump(time) { A.setAudioPosition(time); }
                function playTo(end) {
                    audio.play();
                    while (position < end - 1e-8) {
                        const step = Math.min(0.5 * rate, end - position);
                        clock += step / rate * 1000; position += step;
                        A.accumulateListeningTime(false);
                    }
                }
                const snapshot = () => b.getStudyLogs();
                const currentTrack = () => snapshot().listenProgress[A.getListenContext().key];
                const currentWhole = () => currentTrack().wholeDevices.dev_audit_pc;
                const result = {};

                reset({ itemListenCounts: { [realItem.id]: 3 } });
                for (let i = 0; i < 10; i++) { jump(0); playTo(60); audio.pause(); }
                result.local = { count: snapshot().itemListenCounts[realItem.id], coverage: L.ratio(currentWhole(), currentTrack().windows),
                    practice: L.practiceCount(currentTrack(), 'section:0.000:60.000'), seconds: snapshot().totalListenSec,
                    text: document.getElementById('listenPracticeText').textContent };

                // The remainder belongs to a new day/session, but completes the same round.
                jump(60); playTo(540); audio.pause();
                result.completed = snapshot();
                const completedSnapshot = snapshot();
                jump(540); playTo(600); audio.pause();
                result.afterTail = snapshot().itemListenCounts[realItem.id];
                jump(0); playTo(120); audio.pause();
                const beforeSync = snapshot();
                syncAudit.mergeStudyLogsWithRemote(completedSnapshot);
                syncAudit.mergeStudyLogsWithRemote(completedSnapshot);
                result.stale = { count: snapshot().itemListenCounts[realItem.id], coverage: L.ratio(currentWhole(), currentTrack().windows) };
                // Undo also applies to a newly earned coverage credit and survives stale snapshots.
                A.setItemListenCount(realItem.id, 3);
                syncAudit.mergeStudyLogsWithRemote(beforeSync);
                result.undo = snapshot().itemListenCounts[realItem.id];

                reset(); state.speed = 2; rate = 2; playTo(60); audio.pause();
                result.speed = { seconds: snapshot().totalListenSec, coverage: L.ratio(currentWhole(), currentTrack().windows) };
                reset(); audio.play(); clock += 120000; A.accumulateListeningTime(true); audio.pause();
                result.stall = snapshot().totalListenSec;
                reset(); audio.play(); jump(599); audio.pause();
                result.jump = { seconds: snapshot().totalListenSec, counts: snapshot().itemListenCounts };

                reset(); state.playMode = 'range';
                state.rangeSelection = { step: 'ready', startIdx: 0, endIdx: 1, itemKey: A.getCurrentRangeItemKey(), completed: false };
                for (let i = 0; i < 3; i++) { jump(0); playTo(120); audio.pause(); }
                result.range = { whole: currentWhole().completed,
                    text: document.getElementById('listenPracticeText').textContent,
                    sentence: L.practiceCount(currentTrack(), 'sentence:0:0.000:60.000') };

                // Exercise the real RAF/timeupdate loop boundary, including terminal ended.
                reset(); state.playMode = 'range'; state.rangeRepeatCount = 2;
                state.rangeSelection = { step: 'ready', startIdx: 9, endIdx: 9, itemKey: A.getCurrentRangeItemKey(), completed: false };
                jump(540); playTo(599.9);
                audio.dispatchEvent(new Event('timeupdate'));
                // If RAF has not had a frame yet, ended must use the same transition.
                if (position > 599) { position = 600; audio.dispatchEvent(new Event('ended')); }
                playTo(599.9); position = 600; audio.dispatchEvent(new Event('ended'));
                result.ended = { paused, completed: state.rangeSelection.completed,
                    whole: currentWhole().completed, text: document.getElementById('listenPracticeText').textContent };

                // Cross-device partial progress can produce one credit during actual sync merge.
                reset(); playTo(300); audio.pause(); const left = snapshot();
                reset(); jump(300); playTo(600); audio.pause(); const right = snapshot();
                b.applyMergedStudyLogs(left); syncAudit.mergeStudyLogsWithRemote(right);
                const once = snapshot(); syncAudit.mergeStudyLogsWithRemote(right);
                result.merge = { once: once.itemListenCounts[realItem.id], repeated: snapshot().itemListenCounts[realItem.id],
                    dirty: syncAudit.mergeStudyLogsWithRemote({}).localHasNewer,
                    payload: Object.keys(syncAudit.buildLocalStudyLogsPayload().listenProgress).length };

                // Leave a partial round and a practice count to verify real browser reload.
                reset({ itemListenCounts: { [realItem.id]: 3 } });
                playTo(60); audio.pause(); playTo(240); audio.pause();
                const savedProgress = JSON.stringify(snapshot().listenProgress);
                A.selectItem(state.allData.items_807.find(item => item.id !== realItem.id).id, false);
                A.selectItem(realItem.id, false);
                A.loadTrackData(2, false); A.loadTrackData(1, false);
                result.switchPreserved = savedProgress === JSON.stringify(snapshot().listenProgress);
                result.persisted = snapshot();
                const backup = JSON.stringify(A.buildStudyBackupPayload());
                b.applyMergedStudyLogs({ dates: [] });
                await A.importStudyBackup({ text: async () => backup });
                result.backupPreserved = JSON.stringify(result.persisted.listenProgress) === JSON.stringify(snapshot().listenProgress);
                localStorage.setItem('listen_test_snapshot', JSON.stringify(result.persisted));
                return result;
            }""")
            item_id = next(iter(results["completed"]["itemListenCounts"]))
            assert results["local"]["count"] == 3, results["local"]
            assert results["local"]["coverage"] == 0.1 and results["local"]["practice"] == 10, results["local"]
            assert abs(results["local"]["seconds"] - 600) < 0.01, results["local"]
            print("[PASS] Repeated segment earns ten local passes and 600 seconds; legacy whole count stays at three")
            assert results["completed"]["itemListenCounts"][item_id] == 4 and results["afterTail"] == 4, results
            assert results["stale"] == {"count": 4, "coverage": 0.2}, results["stale"]
            assert results["undo"] == 3, results["undo"]
            print("[PASS] Whole coverage credit, tail suppression, stale sync and undo remain consistent")
            assert results["speed"] == {"seconds": 30, "coverage": 0.1}, results["speed"]
            assert results["stall"] == 0 and results["jump"]["seconds"] == 0, results
            print("[PASS] 2x uses physical time; buffering and seek jumps do not create listening effort")
            assert results["range"] == {"whole": 0, "text": "本次区间已完成 3 遍", "sentence": 3}, results["range"]
            assert results["ended"] == {"paused": True, "completed": True, "whole": 0, "text": "本次区间已完成 2 遍"}, results["ended"]
            print("[PASS] A-B and terminal ended count local practice without awarding a whole-item pass")
            assert results["merge"] == {"once": None, "repeated": None, "dirty": True, "payload": 1}, results["merge"]
            print("[PASS] Production sync merges complementary coverage without awarding a pass before playback resumes")
            assert results["switchPreserved"] and results["backupPreserved"], results
            print("[PASS] Real item/track switches and backup export/import preserve unfinished progress")

            page.reload(wait_until="domcontentloaded")
            page.wait_for_function("() => !!window.__kaoyanBridge && state.activeSentences.length > 5")
            restored = page.evaluate("""() => {
                const saved = JSON.parse(localStorage.getItem('listen_test_snapshot'));
                const logs = __kaoyanBridge.getStudyLogs();
                return { equal: JSON.stringify(logs.listenProgress) === JSON.stringify(saved.listenProgress),
                    counts: logs.itemListenCounts, expectedCounts: saved.itemListenCounts };
            }""")
            assert restored["equal"] and restored["counts"] == restored["expectedCounts"], restored
            assert not errors, errors
            print("[PASS] Real reload preserves unfinished coverage, segment counts and historical records; zero page errors")

            # New row must remain visible without horizontal overflow across the supported layouts.
            for width, height in [(390, 844), (834, 1194), (1194, 834), (1440, 900)]:
                page.set_viewport_size({"width": width, "height": height})
                page.evaluate("document.getElementById('playerDock').classList.remove('dock-collapsed', 'dock-receded'); document.body.classList.add('dock-expanded')")
                page.wait_for_timeout(400)
                page.evaluate("""() => {
                    document.getElementById('listenCoverageText').textContent = '本轨听读 2 遍 · 本轮覆盖 35%';
                    document.getElementById('listenPracticeText').textContent = '本次区间已完成 6 遍';
                }""")
                layout = page.evaluate("""() => {
                    const row = document.querySelector('.listen-progress-row').getBoundingClientRect();
                    const bar = document.querySelector('.dock-progress-row').getBoundingClientRect();
                    return { left: row.left, right: row.right, top: row.top, bottom: row.bottom, nextTop: bar.top,
                        scroll: document.documentElement.scrollWidth, width: innerWidth };
                }""")
                assert layout["left"] >= -1 and layout["right"] <= width + 1, (width, layout)
                assert layout["top"] >= 0 and layout["bottom"] <= height, (width, layout)
                assert layout["bottom"] <= layout["nextTop"] + 1 and layout["scroll"] <= width + 1, (width, layout)
                if width == 390 and os.environ.get("LISTEN_SCREENSHOT_DIR"):
                    destination = Path(os.environ["LISTEN_SCREENSHOT_DIR"])
                    page.screenshot(path=str(destination / "listen-progress-phone.png"))
                    page.evaluate("document.documentElement.setAttribute('data-theme', 'dark')")
                    page.screenshot(path=str(destination / "listen-progress-phone-dark.png"))
                    page.evaluate("document.documentElement.setAttribute('data-theme', 'parchment')")
            print("[PASS] Listening progress row fits phone, portrait/landscape tablet and desktop layouts")

            # Scheme A UI verification: Track 1 + Track 2 split badges on header, sidebar card, and dashboard
            scheme_a = page.evaluate("""() => {
                const b = __kaoyanBridge;
                const item = state.activeItem;
                const key1 = `${state.currentSubject}|${item.id}|1|audit1`;
                const key2 = `${state.currentSubject}|${item.id}|2|body|audit2`;
                b.applyMergedStudyLogs({
                    dates: [],
                    listenProgress: {
                        [key1]: {
                            itemId: item.id,
                            windows: [[0, 100]],
                            wholeDevices: { dev_a: { completed: 2, coverage: [], bank: [], sealedAt: null } },
                            practice: {}
                        },
                        [key2]: {
                            itemId: item.id,
                            windows: [[0, 60]],
                            wholeDevices: { dev_a: { completed: 3, coverage: [], bank: [], sealedAt: null } },
                            practice: {}
                        }
                    }
                });
                selectItem(item.id, false);
                document.getElementById('btn-study-dashboard').click();
                const headerText = document.getElementById('paperListenText').textContent;
                const sideBadge = document.querySelector(`.question-card-item[data-id="${item.id}"] .card-listen-badge`);
                const sideText = sideBadge ? sideBadge.textContent : '';
                const t1Passes = document.getElementById('dashT1Passes').textContent;
                const t2Passes = document.getElementById('dashT2Passes').textContent;
                const topText = document.getElementById('dashTopListenedList').textContent;
                const scrollOverflow = document.documentElement.scrollWidth > window.innerWidth + 1;
                document.getElementById('studyDashboardClose').click();
                return { headerText, sideText, t1Passes, t2Passes, topText, scrollOverflow };
            }""")
            assert scheme_a["headerText"] == "总 5 遍 · 轨1×2/轨2×3 · +1", scheme_a
            assert "5遍" in scheme_a["sideText"] and "轨1×2/轨2×3" in scheme_a["sideText"], scheme_a
            assert scheme_a["t1Passes"] == "2" and scheme_a["t2Passes"] == "3", scheme_a
            assert "轨1×2/轨2×3" in scheme_a["topText"] and not scheme_a["scrollOverflow"], scheme_a
            print("[PASS] Scheme A renders dual-track split listen counts cleanly on header, sidebar card and dashboard")

            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
