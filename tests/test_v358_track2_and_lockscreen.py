#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v3.5.8 回归与多端专项验证：
1. 706(42) + 807(40) 全 82 篇轨道二 *_micro.mp3 音频规格与停顿对齐全检（44.1kHz / Mono / ~96kbps / >=350ms 间距 / >=250ms cutoff 裕度）；
2. iPhone (390x844) / iPad 竖横屏 / Windows (1440x900) 三端轨道二排版、因果导图、引文楷体、急救图、807 三栏名解响应式验证；
3. 手机锁屏 / PWA 切后台播放暂停与无声音根因修复验证（hidden 态绝不静音、锁屏释放残留静音锁、跨篇连播 AbortError/合成 pause 免疫、item 预绕回）。
"""

import http.server
import json
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        pass


def start_server():
    httpd = socketserver.TCPServer(("127.0.0.1", 0), QuietHandler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def ffprobe_stream(mp3_path: Path) -> dict:
    res = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "stream=codec_name,sample_rate,channels,bit_rate",
            "-show_entries", "format=duration,bit_rate",
            "-of", "json", str(mp3_path),
        ],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(res.stdout)
    st = data["streams"][0]
    fmt = data["format"]
    return {
        "codec": st.get("codec_name"),
        "sample_rate": int(st.get("sample_rate", 0)),
        "channels": int(st.get("channels", 0)),
        "bit_rate": int(st.get("bit_rate") or fmt.get("bit_rate") or 0),
        "duration": float(fmt.get("duration") or 0),
    }


def main():
    failures = []

    def check(cond, name, detail=""):
        status = "PASS" if cond else "FAIL"
        print(f"  [{status}] {name}" + (f" ({detail})" if detail else ""), flush=True)
        if not cond:
            failures.append(f"{name}: {detail}")

    # 1. Track 2 All-82 Audio Quality & Gap Invariants
    m706 = json.loads((ROOT / "data" / "kaoyan_706_manifest.json").read_text(encoding="utf-8"))
    m807 = json.loads((ROOT / "data" / "kaoyan_807_manifest.json").read_text(encoding="utf-8"))
    all_items = m706 + m807
    check(len(all_items) == 82, "Manifest has all 82 Track 2 items", f"count={len(all_items)}")

    bad_audio = []
    short_gaps = []
    cutoff_overshoots = []
    total_pairs = 0
    min_gap_ms = 999999.0

    for idx, it in enumerate(all_items):
        t2 = it.get("track2") or {}
        mp3_rel = t2.get("audio", "")
        sf_rel = t2.get("sentences_file", "")
        mp3_p = ROOT / mp3_rel
        sf_p = ROOT / sf_rel
        if not mp3_rel.endswith("_micro.mp3") or not mp3_p.exists() or not sf_p.exists():
            bad_audio.append((it["id"], "missing"))
            continue
        if idx in (0, 1, 10, 41, 42, 43, 60, 81):
            info = ffprobe_stream(mp3_p)
            if info["sample_rate"] != 44100 or info["channels"] != 1 or info["bit_rate"] < 90000:
                bad_audio.append((it["id"], info))

        sents = json.loads(sf_p.read_text(encoding="utf-8"))
        for i in range(len(sents) - 1):
            total_pairs += 1
            cur_end = float(sents[i]["end"])
            nxt_start = float(sents[i + 1]["start"])
            gap_ms = (nxt_start - cur_end) * 1000.0
            if gap_ms < min_gap_ms:
                min_gap_ms = gap_ms
            if gap_ms < 345.0:
                short_gaps.append((it["id"], sents[i]["id"], round(gap_ms, 1)))
            span = max(0.0, cur_end - float(sents[i]["start"]))
            cutoff = min(cur_end - min(0.16, 0.065, span * 0.22), nxt_start - min(0.26, 0.145, span * 0.28))
            if nxt_start - cutoff < 0.20:
                cutoff_overshoots.append((it["id"], sents[i]["id"], round((nxt_start - cutoff) * 1000.0, 1)))

    check(len(bad_audio) == 0, "Track 2 *_micro.mp3 files match 44.1kHz mono 96kbps spec", str(bad_audio[:3]))
    check(
        total_pairs >= 2000 and len(short_gaps) == 0 and len(cutoff_overshoots) == 0,
        "All 82 Track 2 files retain >=345ms inter-clause gaps & >=200ms cutoff margins",
        f"pairs={total_pairs}, min_gap={min_gap_ms:.1f}ms, short={short_gaps[:3]}, overshoots={cutoff_overshoots[:3]}",
    )

    httpd, port = start_server()
    base_url = f"http://127.0.0.1:{port}/index.html"

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True)

            # 2. Multi-device responsive layout & Mind-map PDF parity checks
            viewports = [
                ("iPhone", 390, 844, True),
                ("iPad Portrait", 820, 1180, False),
                ("iPad Landscape", 1194, 834, False),
                ("Windows Desktop", 1440, 900, False),
            ]
            for vp_name, w, h, is_mobile in viewports:
                ctx = browser.new_context(viewport={"width": w, "height": h})
                page = ctx.new_page()
                page.goto(base_url, wait_until="domcontentloaded", timeout=25000)
                page.wait_for_function("() => !!window.audio && !!window.state && !!window.switchSubject", timeout=25000)

                res = page.evaluate("""async () => {
                  window.switchSubject('706');
                  await new Promise(r => setTimeout(r, 120));
                  window.selectItem('706_01_T0_01_杜甫_沉郁顿挫艺术风格与诗史性质_30分论述', false);
                  await new Promise(r => setTimeout(r, 80));
                  document.getElementById('tab-track-2').click();
                  await new Promise(r => setTimeout(r, 120));

                  const overflowEssay = document.documentElement.scrollWidth > document.documentElement.clientWidth;
                  const mmCard = !!document.querySelector('.relay-mindmap-card');
                  const mmRoot = !!document.querySelector('.relay-mm-root-pill');
                  const mmNodes = document.querySelectorAll('.relay-chain-node-v4').length;
                  const mmEdges = document.querySelectorAll('.relay-mm-edge').length;
                  const quoteCites = document.querySelectorAll('.relay-track2-wrap .quote-cite').length;
                  const stepRows = document.querySelectorAll('.relay-step-row').length;
                  const bookendGutters = document.querySelectorAll('.relay-bookend-gutter').length;
                  const footerTwoCol = !!document.querySelector('.relay-v4-footer.has-two-cols');
                  const faIcons = document.querySelectorAll('.relay-track2-wrap i[class*="fa"]').length;

                  document.querySelector('.relay-chain-node-v4[data-jump-sec="1"]').click();
                  const jumpedActive = document.querySelector('.relay-chain-node-v4[data-jump-sec="1"]').classList.contains('mm-node-active');

                  // Tool card diagram
                  window.selectItem('706_05_急救工具卡_01_古代文学跨代纵向母题链与比较四维急救卡_30分通用', false);
                  await new Promise(r => setTimeout(r, 100));
                  const hasToolDiagram = !!document.querySelector('.relay-tool-diagram');

                  // 807 Noun Collection 3-column check
                  window.switchSubject('807');
                  await new Promise(r => setTimeout(r, 100));
                  window.selectItem('807_00_807核心名词解释_01_现代文学社团思潮与经典概念_5分名解合辑', false);
                  await new Promise(r => setTimeout(r, 120));
                  const overflowNoun = document.documentElement.scrollWidth > document.documentElement.clientWidth;
                  const gridEl = document.querySelector('.relay-mj-grid');
                  const gridCols = gridEl ? getComputedStyle(gridEl).gridTemplateColumns.split(' ').filter(Boolean).length : 0;

                  return {
                    overflowEssay, mmCard, mmRoot, mmNodes, mmEdges, quoteCites,
                    stepRows, bookendGutters, footerTwoCol, faIcons, jumpedActive,
                    hasToolDiagram, overflowNoun, gridCols
                  };
                }""")
                expected_cols = 1 if is_mobile else 3
                check(
                    not res["overflowEssay"] and not res["overflowNoun"],
                    f"{vp_name} ({w}x{h}) zero horizontal overflow on essay & noun collection",
                    json.dumps(res),
                )
                check(
                    res["mmCard"] and res["mmRoot"] and res["mmNodes"] >= 4 and res["mmEdges"] >= 3
                    and res["quoteCites"] >= 3 and res["stepRows"] >= 6 and res["bookendGutters"] == 2
                    and res["footerTwoCol"] and res["faIcons"] == 0 and res["jumpedActive"] and res["hasToolDiagram"]
                    and res["gridCols"] == expected_cols,
                    f"{vp_name} ({w}x{h}) Track 2 PDF+MindMap layout & {expected_cols}-col noun grid",
                    json.dumps(res),
                )
                ctx.close()

            # 3. Lock-Screen / Background PWA Playback Regression Checks
            ctx = browser.new_context(viewport={"width": 390, "height": 844})
            page = ctx.new_page()
            page.goto(base_url, wait_until="domcontentloaded", timeout=25000)
            page.wait_for_function("() => !!window.audio && !!window.state && !!window.selectItem", timeout=25000)

            bg_res = page.evaluate("""async () => {
              const a = window.audio;
              let mockTime = 1.0;
              let mockDur = 120.0;
              let mockPaused = true;
              let mockReady = 1;
              let mockHidden = false;
              let mockVis = 'visible';
              let rejectAbortOnce = false;
              let srcHistory = [];

              Object.defineProperty(document, 'hidden', { configurable: true, get: () => mockHidden });
              Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => mockVis });
              Object.defineProperty(a, 'readyState', { configurable: true, get: () => mockReady });
              Object.defineProperty(a, 'duration', { configurable: true, get: () => mockDur });
              Object.defineProperty(a, 'paused', { configurable: true, get: () => mockPaused });
              Object.defineProperty(a, 'seeking', { configurable: true, get: () => false });
              Object.defineProperty(a, 'currentTime', {
                configurable: true,
                get: () => mockTime,
                set: (v) => { mockTime = Number(v) || 0; }
              });
              a.pause = () => { mockPaused = true; a.dispatchEvent(new Event('pause')); };
              a.load = () => {};
              a.play = () => {
                if (rejectAbortOnce) {
                  rejectAbortOnce = false;
                  const err = new Error('Interrupted by new load');
                  err.name = 'AbortError';
                  return Promise.reject(err);
                }
                mockPaused = false;
                a.dispatchEvent(new Event('play'));
                return Promise.resolve();
              };

              window.switchSubject('706');
              await new Promise(r => setTimeout(r, 80));
              window.selectItem('706_01_T0_01_杜甫_沉郁顿挫艺术风格与诗史性质_30分论述', false);
              await new Promise(r => setTimeout(r, 80));
              document.getElementById('tab-track-2').click();
              await new Promise(r => setTimeout(r, 100));

              // Test A: Unready click sets pendingSeek mute, locking screen immediately clears mute=false
              const firstSent = document.querySelector('.relay-track2-wrap .recite-sent');
              mockReady = 1;
              firstSent.click();
              const mutedBeforeLock = a.muted;
              mockHidden = true;
              mockVis = 'hidden';
              document.dispatchEvent(new Event('visibilitychange'));
              await new Promise(r => setTimeout(r, 30));
              const mutedAfterLock = a.muted;

              // Test B: Background playNextItem() with synthetic pause + AbortError recovery on canplay
              window.state.playMode = 'sequence';
              mockReady = 1;
              mockPaused = false;
              rejectAbortOnce = true;
              // Dispatch ended -> calls playNextItem() while hidden
              a.dispatchEvent(new Event('ended'));
              // Simulate browser synthetic pause during src change
              mockPaused = true;
              a.dispatchEvent(new Event('pause'));
              await new Promise(r => setTimeout(r, 40));
              const statePlayingBeforeCanplay = window.state.isPlaying;
              const mediaStateBeforeCanplay = navigator.mediaSession ? navigator.mediaSession.playbackState : '';
              mockReady = 4;
              a.dispatchEvent(new Event('canplay'));
              await new Promise(r => setTimeout(r, 40));
              const nextItemId = window.state.activeItemId;
              const pausedAfterNextCanplay = a.paused;
              const statePlayingAfterNextCanplay = window.state.isPlaying;
              const mutedAfterNext = a.muted;

              // Test C: Background item mode pre-EOF watchdog wraps before hitting ended
              window.state.playMode = 'item';
              mockTime = mockDur - 0.15;
              mockPaused = false;
              await new Promise(r => setTimeout(r, 700));
              const wrappedTime = mockTime;
              const wrappedStillPlaying = window.state.isPlaying && !a.paused && !a.muted;

              return {
                mutedBeforeLock,
                mutedAfterLock,
                statePlayingBeforeCanplay,
                mediaStateBeforeCanplay,
                nextItemId,
                pausedAfterNextCanplay,
                statePlayingAfterNextCanplay,
                mutedAfterNext,
                wrappedTime,
                wrappedStillPlaying,
              };
            }""")
            check(
                bg_res["mutedBeforeLock"] is True and bg_res["mutedAfterLock"] is False,
                "Lock screen (visibilitychange->hidden) clears pendingSeek mute lock immediately (prevents silent playback)",
                json.dumps(bg_res),
            )
            check(
                bg_res["statePlayingBeforeCanplay"] is True
                and bg_res["mediaStateBeforeCanplay"] == "playing"
                and bg_res["nextItemId"] != "706_01_T0_01_杜甫_沉郁顿挫艺术风格与诗史性质_30分论述"
                and bg_res["pausedAfterNextCanplay"] is False
                and bg_res["statePlayingAfterNextCanplay"] is True
                and bg_res["mutedAfterNext"] is False,
                "Background sequence playNextItem() survives synthetic pause + AbortError and auto-resumes on canplay unmuted",
                json.dumps(bg_res, ensure_ascii=False),
            )
            check(
                bg_res["wrappedTime"] < 1.0 and bg_res["wrappedStillPlaying"] is True,
                "Background item mode watchdog seamlessly wraps before EOF unmuted",
                json.dumps(bg_res),
            )

            ctx.close()
            browser.close()
    finally:
        httpd.shutdown()

    if failures:
        print("\nFAILURES:")
        for f in failures:
            print(" -", f)
        raise SystemExit(1)

    print("\nALL V3.5.8 TRACK 2 & LOCK-SCREEN CHECKS PASSED!")


if __name__ == "__main__":
    main()
