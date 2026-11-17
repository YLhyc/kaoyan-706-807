"""Render opaque square lock-screen artwork from the existing SVG application icon.

Run with: python tools/build_media_artwork.py
Requires Pillow, Playwright and the project's existing Edge browser.
"""
import io
from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    svg = ET.fromstring((ROOT / "icon.svg").read_text(encoding="utf-8"))
    background = svg.find("{http://www.w3.org/2000/svg}rect")
    assert background is not None and background.get("width") == "512"
    # The operating system supplies its own mask. Fill the entire image underneath it.
    background.attrib.pop("rx", None)
    background.attrib.pop("ry", None)
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        for size in (512, 1024):
            svg.set("width", str(size))
            svg.set("height", str(size))
            page = browser.new_page(viewport={"width": size, "height": size}, device_scale_factor=1)
            page.route("**/*", lambda route: route.abort())
            page.set_content("<style>html,body{margin:0;background:#080e15}svg{display:block}</style>"
                             + ET.tostring(svg, encoding="unicode"))
            rendered = page.screenshot()
            with Image.open(io.BytesIO(rendered)) as image:
                image.convert("RGB").save(ROOT / f"media-artwork-{size}.png", optimize=True)
            page.close()
            print(f"Generated media-artwork-{size}.png (opaque RGB)", flush=True)
        browser.close()


if __name__ == "__main__":
    main()
