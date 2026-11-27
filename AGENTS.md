# Project Engineering Rules (`706_807专业课背诵手卷`)

These rules codify invariants derived from past regressions (`v3.4.3–v3.5.12`) and are enforced automatically by `tests/run_release_gate.py`.

## 1. Dual-Track Audio & Voice Contracts (Never Mix or Blanket-Overwrite)
- **Track 1 (`*_exam.mp3`)**: Must use **Aliyun CosyVoice (`cosyvoice-v3-flash`, `longanlang_v3` 龙安朗, 48kHz source)** at native clarity (`~ -23 dB`, 44.1kHz mono 96kbps). Never overwrite Track 1 with Edge TTS (`YunyangNeural`) or low-band `cosyvoice-v2` (`22050Hz`).
- **Track 2 (`*_micro.mp3`)**: Must use **Edge TTS (`zh-CN-YunyangNeural`, `-4%`, `volume=4dB`)**, 44.1kHz mono 96kbps. Avoid bare 1-char classical verb/preposition glues (`立平等`, `化主观情`) and bare noun stacks (`权威盲从思维`) in `tts_text` that trigger Edge TTS `WordBoundary` mis-splits; always validate via `tools/fix_micro_tts_phrasing.py` and WordBoundary audit before synthesis.
- **Surgical Updates Only**: When fixing phrasing/prosody/timestamps, synthesize ONLY the specific items that fail audit rules. Preserve untouched `*_exam.mp3` and `*_micro.mp3` files byte-for-byte from `HEAD` unless a full rebuild is explicitly requested.
- **No Forced Punctuation Mangling**: Never blindly rewrite mid-sentence commas/semicolons to periods (`。`). Expand decade abbreviations (`20s` -> `20年代`) and normalize ordinal dots (`1. ` -> `1、`) before TTS.

## 2. Four-Layer Data Synchronization (Single Bundle Builder)
- Never hand-craft `data/kaoyan_data.js` in ad-hoc synthesis scripts (which previously dropped `window.KAOYAN_BUILTIN_CLOZE` in `v3.5.7`).
- Always rebuild `data/kaoyan_all_manifest.json` and `data/kaoyan_data.js` via `tools/build_kaoyan_bundle.py` (which preserves `KAOYAN_MANIFEST`, `KAOYAN_SENTENCES`, and `window.KAOYAN_BUILTIN_CLOZE` from `data/kaoyan_builtin_cloze.json`).
- Track 1 HTML timestamp syncing MUST match `data-sent-id` (`by_id`) before positional `data-sent-idx` (legacy Track 1 HTML uses 1-based `data-sent-idx`). Track 2 is rendered dynamically from `track2.micro_slots` + `track2.sentences_file`.

## 3. Player, Loop & iOS PWA State-Machine Invariants (`app.js`)
- **Pause Before Seek on Loop Gaps**: During `gapMs > 0` (`isLoopGapWaiting = true`) in `performLoopTransition`, ALWAYS `audio.pause()` BEFORE calling `triggerLoopSeek(targetTime, ...)`. Never rely solely on mute guards (which iOS/PWA disables) to hide pre-seek bleed / 2-char stutters.
- **Seek Lock Closure**: Async seeks must remain gated by `isLoopSeekInFlight(cur)` until `!audio.seeking && audio.readyState >= 2` and playback time converges near `loopSeekTargetTime` (with `850ms` fallback max), never merely a short fixed ms timer.
- **Strict Non-Sequence Containment**: Only `state.playMode === 'sequence'` may advance across items via `playNextItem()`. Modes `sentence`, `loop3`, `section`, `item`, and `range` must stay within the current item (and Track 2 `t2BoundsSent` body bounds when active) until paused.
- **Lockscreen / Hidden Safety**: Never engage `internalMuteLock` while `document.hidden === true`; unlock/visibility return must respect `userExplicitPause` and never auto-resume a manually paused session.

## 4. Release Versioning & Required Verification Gate
- **Single Source of Truth**: `version.json` owns the release version. Bump releases ONLY via:
  ```powershell
  python tools/bump_release.py <version> --title "..." --notes "..."
  ```
- **No Unverified Commits / Pushes**:
  - Local `pre-commit` hook runs `python tests/run_release_gate.py --fast` (`verify_project.py`, `verify_all_sync.py`, `tests/test_audio_and_bundle_contract.py`, `tests/test_listen_tracking.js`).
  - Before any release push or UI/audio change, run `python tests/run_release_gate.py --full` (adds all Playwright E2E suites) and verify zero failures.
- **UI / CSS Discipline**: All UI icons must use inline SVG (`kubai_icons.js` / inline `<svg>`), zero emoji UI icons. Avoid piling new `!important` viewport overrides onto `.player-dock` at the tail of `app.css` without running `tests/test_ipad_responsive.py` and `tests/test_listen_progress_e2e.py`.
