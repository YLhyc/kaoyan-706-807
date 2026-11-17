"""Opaque artwork and in-place v3.4.12 PWA upgrade; blocks all external requests."""
import json
from pathlib import Path
import subprocess
import threading
from urllib.parse import urlsplit

from PIL import Image
from playwright.sync_api import sync_playwright
from test_v348_audit_fixes_e2e import Mp3RangeHandler, ReusableTCPServer

ROOT = Path(__file__).resolve().parents[1]
BASELINE = "08587fc"


def previous(path):
    return subprocess.run(["git", "show", f"{BASELINE}:{path}"], cwd=ROOT,
                          check=True, capture_output=True).stdout


def main():
    for size in (512, 1024):
        with Image.open(ROOT / f"media-artwork-{size}.png") as image:
            assert image.size == (size, size) and image.mode == "RGB"
            assert "transparency" not in image.info
            # All four edges must be filled with the dark background, without white seams.
            for edge in [(0, 0, size, 1), (0, size - 1, size, size),
                         (0, 0, 1, size), (size - 1, 0, size, size)]:
                assert max(channel[1] for channel in image.crop(edge).getextrema()) < 100
    print("[PASS] Both artwork sizes are opaque RGB with fully filled dark edges", flush=True)

    for path in ("manifest.json", "icon.svg", "icon-192.png", "icon-256.png", "icon-512.png"):
        assert (ROOT / path).read_bytes() == previous(path), path
    print("[PASS] Existing PWA identity, launch URL, scope and application icons unchanged", flush=True)

    snapshots = {path: previous(path) for path in ("index.html", "app.js", "sw.js", "version.json")}

    class UpgradeHandler(Mp3RangeHandler):
        def do_GET(self):
            path = urlsplit(self.path).path.lstrip("/") or "index.html"
            if path not in snapshots:
                return super().do_GET()
            body = snapshots[path] if self.server.baseline else (ROOT / path).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(path) + "; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

    server = ReusableTCPServer(("127.0.0.1", 0), UpgradeHandler)
    server.baseline = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True)
            context = browser.new_context(service_workers="allow")
            context.route("**/*", lambda route: route.continue_()
                          if urlsplit(route.request.url).hostname == "127.0.0.1" else route.abort())
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin + "/index.html", wait_until="domcontentloaded")
            page.wait_for_function("() => navigator.serviceWorker.controller && window.__kaoyanBridge && navigator.mediaSession.metadata")
            old_artwork = page.evaluate("() => navigator.mediaSession.metadata.artwork.map(a => a.src)")
            assert all("icon-" in url for url in old_artwork), old_artwork
            before = page.evaluate("""async () => {
                localStorage.setItem('audit-installed-pwa', 'keep-this-install');
                const itemId = state.activeItemId;
                __kaoyanBridge.applyMergedStudyLogs({
                    dates: ['2026-11-16'], completedIds: [itemId], totalCardsCompleted: 1,
                    totalListenSec: 600, dailyListenSec: {'2026-11-16': 600}, itemListenCounts: {[itemId]: 3},
                    listenProgress: { audit: { itemId, windows: [[0,60]],
                        wholeDevices: { audit_phone: { completed: 2, coverage: [[0,20]], sealedAt: null } }, practice: {} } }
                });
                return { logs: __kaoyanBridge.getStudyLogs(), scope: (await navigator.serviceWorker.getRegistration()).scope };
            }""")
            print("[PASS] Existing v3.4.12 PWA started with study records and partial coverage", flush=True)

            server.baseline = False
            page.evaluate("""async () => {
                const reg = await navigator.serviceWorker.getRegistration();
                let timer;
                const changed = new Promise((resolve, reject) => {
                    navigator.serviceWorker.addEventListener('controllerchange', resolve, {once: true});
                    timer = setTimeout(() => reject(new Error('PWA controller upgrade timed out')), 30000);
                });
                try { await reg.update(); await changed; }
                finally { clearTimeout(timer); }
            }""")
            version = json.loads((ROOT / "version.json").read_text(encoding="utf-8"))["version"]
            cache_name = "kaoyan-all-in-one-v" + version
            ready = page.evaluate("""async name => {
                const cache = await caches.open(name);
                const index = await cache.match('./index.html');
                return !!index && (await index.text()).includes('app.js?v=' + name.split('-v')[1]);
            }""", cache_name)
            assert ready, "New worker must finish precaching before reloading"
            page.reload(wait_until="domcontentloaded")
            try:
                page.wait_for_function("() => navigator.mediaSession.metadata && navigator.mediaSession.metadata.artwork.some(a => a.src.includes('media-artwork-'))")
            except Exception:
                print(page.evaluate("""async () => ({ scripts: Array.from(document.scripts).map(s => s.src),
                    caches: await caches.keys(), artwork: navigator.mediaSession.metadata?.artwork,
                    stateLoaded: !!window.state, controller: navigator.serviceWorker.controller?.state })"""), flush=True)
                print("Page errors:", errors, flush=True)
                raise
            after = page.evaluate("""async name => {
                const cache = await caches.open(name);
                return { logs: __kaoyanBridge.getStudyLogs(), scope: (await navigator.serviceWorker.getRegistration()).scope,
                    sentinel: localStorage.getItem('audit-installed-pwa'),
                    cached: await Promise.all([512,1024].map(async n => !!await cache.match('./media-artwork-' + n + '.png'))),
                    artwork: navigator.mediaSession.metadata.artwork.map(a => ({ src: a.src, sizes: a.sizes, type: a.type })) };
            }""", cache_name)
            assert after["logs"]["listenProgress"] == before["logs"]["listenProgress"], (before, after)
            assert after["logs"]["completedIds"] == before["logs"]["completedIds"]
            assert after["logs"]["totalListenSec"] >= before["logs"]["totalListenSec"]
            assert after["logs"]["itemListenCounts"][before["logs"]["completedIds"][0]] >= 3
            assert after["scope"] == before["scope"] and after["sentinel"] == "keep-this-install"
            assert all(after["cached"]), after
            assert [a["sizes"] for a in after["artwork"]] == ["512x512", "1024x1024"]
            assert all(a["type"] == "image/png" for a in after["artwork"])
            print(f"[PASS] In-place upgrade to {version}: same registration, study logs and unfinished coverage preserved", flush=True)
            print("[PASS] MediaSession selects the dedicated artwork, both sizes precached", flush=True)

            context.set_offline(True)
            page.reload(wait_until="domcontentloaded")
            page.wait_for_function("() => window.__kaoyanBridge && navigator.mediaSession.metadata")
            pixels = page.evaluate("""async () => {
                const results = [];
                for (const artwork of navigator.mediaSession.metadata.artwork) {
                    const img = new Image(); img.src = artwork.src; await img.decode();
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
                    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
                    results.push({ width: img.naturalWidth,
                        corners: [[0,0],[canvas.width-1,0],[0,canvas.height-1],[canvas.width-1,canvas.height-1]]
                            .map(([x,y]) => Array.from(ctx.getImageData(x,y,1,1).data)) });
                }
                return results;
            }""")
            assert [p["width"] for p in pixels] == [512, 1024]
            assert all(corner[3] == 255 and max(corner[:3]) < 100 for p in pixels for corner in p["corners"])
            offline_logs = page.evaluate("() => __kaoyanBridge.getStudyLogs()")
            assert offline_logs["listenProgress"] == before["logs"]["listenProgress"]
            assert not errors, errors
            print("[PASS] Offline restart loads opaque artwork and preserves records; zero page errors", flush=True)
            context.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
