#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Single-source-of-truth release version bumper.
Updates version.json and synchronizes sw.js, app.js, and index.html atomically,
then runs verify_project.py to guarantee zero cache/version drift.
"""

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")


def bump_version(
    new_ver: str,
    title: str = "",
    notes: str = "",
    highlights: list[str] | None = None,
    dry_run: bool = False,
) -> None:
    if not SEMVER_RE.match(new_ver):
        raise ValueError(f"Invalid version format '{new_ver}', expected X.Y.Z")

    ver_path = ROOT / "version.json"
    sw_path = ROOT / "sw.js"
    app_path = ROOT / "app.js"
    html_path = ROOT / "index.html"

    ver_data = json.loads(ver_path.read_text(encoding="utf-8"))
    old_ver = ver_data.get("version", "")

    now_bj = datetime.now(timezone(timedelta(hours=8)))
    build_ms = int(time.time() * 1000)

    ver_data["version"] = new_ver
    ver_data["build_time"] = now_bj.strftime("%Y-%m-%d %H:%M:%S +08:00")
    ver_data["build_ts"] = build_ms
    ver_data["build"] = build_ms
    ver_data["releaseDate"] = now_bj.strftime("%Y-%m-%d")
    if title:
        ver_data["updateTitle"] = title
        ver_data["update_title"] = title
    if notes:
        ver_data["update_notes"] = notes
        ver_data["description"] = notes
    if highlights:
        ver_data["highlights"] = highlights

    sw_txt = sw_path.read_text(encoding="utf-8")
    sw_txt, n_cache = re.subn(r"kaoyan-all-in-one-v\d+\.\d+\.\d+", f"kaoyan-all-in-one-v{new_ver}", sw_txt)
    sw_txt, n_sw_q = re.subn(r"\?v=\d+\.\d+\.\d+", f"?v={new_ver}", sw_txt)

    app_txt = app_path.read_text(encoding="utf-8")
    app_txt, n_app = re.subn(
        r"(const\s+APP_BUILD_ID\s*=\s*['\"])\d+\.\d+\.\d+(['\"];)",
        rf"\g<1>{new_ver}\g<2>",
        app_txt,
        count=1,
    )

    html_txt = html_path.read_text(encoding="utf-8")
    html_txt, n_html = re.subn(r"\?v=\d+\.\d+\.\d+", f"?v={new_ver}", html_txt)

    if n_cache == 0 or n_sw_q == 0 or n_app == 0 or n_html == 0:
        raise RuntimeError(
            f"Replacement missed target(s): sw_cache={n_cache}, sw_q={n_sw_q}, app={n_app}, html={n_html}"
        )

    print(
        f"Bump {old_ver} -> {new_ver} (dry_run={dry_run}): "
        f"sw_cache={n_cache}, sw_assets={n_sw_q}, app_id={n_app}, html_assets={n_html}"
    )
    if dry_run:
        return

    ver_path.write_text(json.dumps(ver_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sw_path.write_text(sw_txt, encoding="utf-8")
    app_path.write_text(app_txt, encoding="utf-8")
    html_path.write_text(html_txt, encoding="utf-8")

    subprocess.run([sys.executable, str(ROOT / "verify_project.py")], check=True)


def main():
    parser = argparse.ArgumentParser(description="Bump project release version cleanly from version.json")
    parser.add_argument("version", help="Target semver e.g. 3.5.13")
    parser.add_argument("--title", default="", help="Optional updateTitle / update_title")
    parser.add_argument("--notes", default="", help="Optional update_notes / description")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    bump_version(args.version, title=args.title, notes=args.notes, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
