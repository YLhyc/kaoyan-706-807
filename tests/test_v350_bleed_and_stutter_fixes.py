# -*- coding: utf-8 -*-
"""
Targeted E2E & Data Regression Tests for v3.5.0+ Audio Cutoff & First-Syllable Stutter Fixes:
1. Static Manifest Safety: All 82 706/807 items retain >=50ms inter-sentence gap across every adjacent sentence pair.
2. Cutoff Safety in Browser: Switching to 706 essays computes activeSentences whose next.start - end >= 50ms (no '12346' bleed).
3. Double-Seek Stutter Prevention:
   - Clicking a .recite-sent writes audio.currentTime only ONCE (must NOT re-seek inside synchronous 'play' or fast playPromise.then()).
   - Sentence loop transition with loopGapMs > 0 pauses BEFORE seeking to sentence start, waits for 'seeked' if audio.seeking is active, and performs a single clean seek + single play().
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


def calc_app_cutoff(sents, idx):
    cur = sents[idx]
    nxt = sents[idx + 1] if idx + 1 < len(sents) else None
    rate = 1.0
    end_guard = min(0.16, 0.065 * rate)
    cutoff = cur["end"] - end_guard
    if nxt and isinstance(nxt.get("start"), (int, float)):
        span = max(0.08, nxt["start"] - cur["start"])
        next_guard = min(0.26, 0.145 * rate, span * 0.28)
        cutoff = min(cutoff, nxt["start"] - next_guard)
    return max(cur["start"] + 0.05, cutoff)


def check_manifest_sentence_margins():
    total_pairs = 0
    tight_pairs = []
    cutoff_overshoots = []
    min_gap_ms = 999999.0
    min_cutoff_margin_ms = 999999.0

    for mf_rel in ("data/kaoyan_706_manifest.json", "data/kaoyan_807_manifest.json"):
        mf_path = os.path.join(REPO_ROOT, mf_rel)
        with open(mf_path, "r", encoding="utf-8") as f:
            items = json.load(f)
        for item in items:
            t1 = item.get("track1") or {}
            sf_rel = t1.get("sentences_file")
            if not sf_rel:
                continue
            sf_path = os.path.join(REPO_ROOT, sf_rel)
            with open(sf_path, "r", encoding="utf-8") as f:
                sents = json.load(f)
            for i in range(len(sents) - 1):
                cur, nxt = sents[i], sents[i + 1]
                total_pairs += 1
                gap_ms = (float(nxt["start"]) - float(cur["end"])) * 1000.0
                if gap_ms < min_gap_ms:
                    min_gap_ms = gap_ms
                if gap_ms < 20.0:
                    tight_pairs.append((item["id"], cur["id"], round(gap_ms, 1)))
                cutoff = calc_app_cutoff(sents, i)
                margin_ms = (float(nxt["start"]) - cutoff) * 1000.0
                if margin_ms < min_cutoff_margin_ms:
                    min_cutoff_margin_ms = margin_ms
                if margin_ms < 120.0:
                    cutoff_overshoots.append((item["id"], cur["id"], round(margin_ms, 1)))
    return total_pairs, min_gap_ms, tight_pairs, min_cutoff_margin_ms, cutoff_overshoots


def main():
    failures = []

    def check(cond, label, detail=""):
        status = "PASS" if cond else "FAIL"
        print(f"  [{status}] {label}" + (f" ({detail})" if detail else ""), flush=True)
        if not cond:
            failures.append(f"{label}: {detail}")

    # 1. Static Manifest Gap & Cutoff Safety across all 82 706/807 essays
    total_pairs, min_gap_ms, tight_pairs, min_cutoff_margin_ms, cutoff_overshoots = check_manifest_sentence_margins()
    check(
        total_pairs >= 2500 and len(tight_pairs) == 0 and len(cutoff_overshoots) == 0,
        "All 706/807 adjacent sentences retain >=20ms physical gap and >=120ms cutoff margin before next sentence onset",
        f"pairs={total_pairs}, min_gap={min_gap_ms:.1f}ms, min_cutoff_margin={min_cutoff_margin_ms:.1f}ms, tight={tight_pairs[:3]}, overshoots={cutoff_overshoots[:3]}",
    )

    httpd, port = start_server()
    base_url = f"http://127.0.0.1:{port}/index.html"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True)
            ctx, page = setup_isolated_context(browser, port)
            page.goto(base_url, wait_until="domcontentloaded", timeout=25000)
            page.wait_for_function(
                "() => !!window.__kaoyanBridge && !!window.state && !!window.state.activeSentences && window.state.activeSentences.length > 5 && !!window.audio",
                timeout=25000,
            )

            # 2. Switch to 706 Dufu in browser & verify loaded activeSentences + click-seek single write + loop gap pause-before-seek
            page.click("#btn-subject-706")
            page.wait_for_function(
                "() => window.state.currentSubject === '706' && window.state.activeSentences && window.state.activeSentences.length >= 20",
                timeout=10000,
            )

            res = page.evaluate("""async () => {
              const a = window.audio;
              let mockTime = 0;
              let mockPaused = true;
              let mockSeeking = false;
              let currentTimeWrites = [];
              let opOrder = [];

              Object.defineProperty(a, 'readyState', { configurable: true, get: () => 4 });
              Object.defineProperty(a, 'duration', { configurable: true, get: () => 280 });
              Object.defineProperty(a, 'paused', { configurable: true, get: () => mockPaused });
              Object.defineProperty(a, 'seeking', { configurable: true, get: () => mockSeeking });
              Object.defineProperty(a, 'currentTime', {
                configurable: true,
                get: () => mockTime,
                set: (v) => {
                  mockTime = Number(v) || 0;
                  const rounded = Math.round(mockTime * 1000) / 1000;
                  currentTimeWrites.push(rounded);
                  opOrder.push('seek:' + rounded);
                }
              });
              a.pause = () => {
                mockPaused = true;
                opOrder.push('pause');
                a.dispatchEvent(new Event('pause'));
              };
              a.play = () => {
                mockPaused = false;
                opOrder.push('play');
                a.dispatchEvent(new Event('play'));
                return Promise.resolve();
              };

              // A: activeSentences gap sanity on 706 first essay (Dufu)
              const sents = window.state.activeSentences || [];
              let minGapMs = 999999;
              for (let i = 0; i < sents.length - 1; i++) {
                const g = (sents[i + 1].start - sents[i].end) * 1000;
                if (g < minGapMs) minGapMs = g;
              }

              // B: Click sentence 2 -> must NOT write currentTime twice on immediate play
              const domSents = document.querySelectorAll('#paper-content .recite-sent');
              const s2 = sents[2];
              currentTimeWrites = [];
              opOrder = [];
              domSents[2].click();
              await new Promise(r => setTimeout(r, 40));
              const clickSeekWrites = currentTimeWrites.slice();

              // C: Sentence loop with loopGapMs = 280 -> pause MUST occur BEFORE seek on transition
              window.state.loopGapMs = 280;
              window.state.playMode = 'sentence';
              currentTimeWrites = [];
              opOrder = [];
              mockTime = s2.end + 0.03;
              mockPaused = false;
              a.dispatchEvent(new Event('ended'));
              const immediateOrder = opOrder.slice();

              // Wait past gap wait -> resumes cleanly with single play() and no extra seeks
              await new Promise(r => setTimeout(r, 360));
              const afterGapOrder = opOrder.slice();

              // D: Loop gap transition when audio.seeking is true at resume -> play waits until 'seeked'
              mockSeeking = true;
              currentTimeWrites = [];
              opOrder = [];
              mockTime = s2.end + 0.03;
              mockPaused = false;
              a.dispatchEvent(new Event('ended'));
              await new Promise(r => setTimeout(r, 310));
              const playsBeforeSeeked = opOrder.filter(x => x === 'play').length;
              mockSeeking = false;
              a.dispatchEvent(new Event('seeked'));
              await new Promise(r => setTimeout(r, 30));
              const playsAfterSeeked = opOrder.filter(x => x === 'play').length;

              return {
                activeItemId: window.state.activeItemId,
                sentCount: sents.length,
                minGapMs: Math.round(minGapMs),
                clickSeekWrites,
                s2Start: Math.round(s2.start * 1000) / 1000,
                immediateOrder,
                afterGapOrder,
                playsBeforeSeeked,
                playsAfterSeeked,
                deferredOrder: opOrder.slice()
              };
            }""")

            check(
                res["sentCount"] >= 20 and res["minGapMs"] >= 50,
                "706 item loaded in browser retains >=50ms inter-sentence gaps",
                f"item={res['activeItemId']}, sents={res['sentCount']}, minGapMs={res['minGapMs']}",
            )
            check(
                len(res["clickSeekWrites"]) == 1 and abs(res["clickSeekWrites"][0] - res["s2Start"]) < 0.02,
                "Click-to-seek writes audio.currentTime only ONCE on immediate play (zero double-seek stutter)",
                json.dumps(res["clickSeekWrites"]),
            )
            imm = res["immediateOrder"]
            pause_idx = imm.index("pause") if "pause" in imm else -1
            seek_idxs = [i for i, op in enumerate(imm) if op.startswith("seek:")]
            check(
                pause_idx == 0 and len(seek_idxs) == 1 and seek_idxs[0] > pause_idx,
                "Sentence loop with loopGapMs>0 pauses BEFORE seeking back to sentence start",
                json.dumps(imm),
            )
            after_plays = [op for op in res["afterGapOrder"] if op == "play"]
            after_seeks = [op for op in res["afterGapOrder"] if op.startswith("seek:")]
            check(
                len(after_plays) == 1 and len(after_seeks) == 1,
                "Sentence loop with loopGapMs>0 completes transition with single seek and single play()",
                json.dumps(res["afterGapOrder"]),
            )
            check(
                res["playsBeforeSeeked"] == 0 and res["playsAfterSeeked"] == 1,
                "Resume waits for 'seeked' before play() when audio.seeking is active (prevents first-syllable clip/stutter)",
                json.dumps(res["deferredOrder"]),
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
    print("\nALL BLEED & STUTTER REGRESSION CHECKS PASSED!")


if __name__ == "__main__":
    main()
