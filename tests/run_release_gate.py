#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unified release gate runner.
  --fast : syntax, version/PWA consistency, DOM/data sync, audio & bundle contract, listen tracking unit tests (~8s).
  --full : runs --fast plus all Playwright E2E regression suites.
"""

import argparse
import subprocess
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent

FAST_STEPS = [
    ("Project Manifest & Cache Gate", [sys.executable, "verify_project.py"]),
    ("Cross-Track HTML & Cloze Sync", [sys.executable, "verify_all_sync.py"]),
    ("Audio, Bundle & Loop Contract", [sys.executable, "tests/test_audio_and_bundle_contract.py"]),
    ("Listen Tracking Unit Suite", ["node", "tests/test_listen_tracking.js"]),
]

FULL_E2E_STEPS = [
    ("E2E Listen Progress & UI Layout", [sys.executable, "tests/test_listen_progress_e2e.py"]),
    ("E2E Track 2, Lockscreen & Loop Wrap", [sys.executable, "tests/test_v358_track2_and_lockscreen.py"]),
    ("E2E Track 1 Bleed & Stutter Regression", [sys.executable, "tests/test_v350_bleed_and_stutter_fixes.py"]),
    ("E2E iPad & Responsive Layouts", [sys.executable, "tests/test_ipad_responsive.py"]),
]


def main():
    parser = argparse.ArgumentParser(description="Unified verification gate")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--fast", action="store_true", help="Run fast contract & unit gates only")
    mode.add_argument("--full", action="store_true", help="Run fast gates plus Playwright E2E suites (default)")
    args = parser.parse_args()

    steps = list(FAST_STEPS)
    if not args.fast:
        steps.extend(FULL_E2E_STEPS)

    t_all = time.time()
    for idx, (label, cmd) in enumerate(steps, 1):
        print(f"\n[{idx}/{len(steps)}] {label}: {' '.join(cmd)}", flush=True)
        t0 = time.time()
        res = subprocess.run(cmd, cwd=str(ROOT))
        if res.returncode != 0:
            print(f"\n❌ GATE BLOCKED at [{idx}/{len(steps)}] {label} (exit={res.returncode})")
            sys.exit(res.returncode)
        print(f"  -> OK in {time.time() - t0:.1f}s", flush=True)

    print(f"\n✅ RELEASE GATE PASSED ({len(steps)} suites in {time.time() - t_all:.1f}s)")


if __name__ == "__main__":
    main()
