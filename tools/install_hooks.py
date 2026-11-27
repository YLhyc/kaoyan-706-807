#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Install local git pre-commit hook to run fast release gates automatically."""

from pathlib import Path
import stat

ROOT = Path(__file__).resolve().parent.parent
HOOK = ROOT / ".git" / "hooks" / "pre-commit"

SCRIPT = """#!/bin/sh
echo "[pre-commit] Running fast release gate..."
python tests/run_release_gate.py --fast
status=$?
if [ $status -ne 0 ]; then
  echo "[pre-commit] Blocked commit: fix failing gate checks first."
  exit $status
fi
"""


def main():
    HOOK.parent.mkdir(parents=True, exist_ok=True)
    HOOK.write_text(SCRIPT, encoding="utf-8", newline="\n")
    try:
        HOOK.chmod(HOOK.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    except Exception:
        pass
    print(f"Installed git pre-commit hook at {HOOK}")


if __name__ == "__main__":
    main()
