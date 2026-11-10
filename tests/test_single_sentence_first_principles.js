// ======================================================================
// Unit Test: Single-Sentence & Section Loop Engine - First Principles
// ======================================================================
const assert = require('assert');

console.log("======================================================================");
console.log("RUNNING FIRST-PRINCIPLES UNIT TESTS: SINGLE-SENTENCE & SECTION LOOPS");
console.log("======================================================================\n");

// Mock environment
function createMockEngine() {
  const activeSentences = [
    { id: 'sent_A', start: 0.100, end: 1.390, text: 'Sentence A' },
    { id: 'sent_B', start: 2.083, end: 15.533, text: 'Sentence B' },
    { id: 'sent_C', start: 17.102, end: 25.119, text: 'Sentence C' }
  ];

  const frameworkSections = [
    { index: 0, start: 0.100, end: 16.000, badge: '一、引言与诉求', cardEl: { classList: { toggle: () => {} } } },
    { index: 1, start: 16.000, end: 40.000, badge: '二、核心论证', cardEl: { classList: { toggle: () => {} } } }
  ];

  const state = {
    isPlaying: true,
    playMode: 'sentence',
    currentSentIndex: 0,
    loopCount: 0,
    activeSentences: activeSentences
  };

  let currentActiveSectionIndex = 0;
  let isLoopSeeking = false;
  let lastSeekTs = 0;
  let seekTargetHistory = [];
  let highlightedSentenceHistory = [];

  function triggerLoopSeek(target) {
    seekTargetHistory.push(target);
    isLoopSeeking = true;
    lastSeekTs = Date.now();
  }

  function highlightSentence(id) {
    highlightedSentenceHistory.push(id);
  }

  function findActiveSentenceIndex(t) {
    for (let i = 0; i < activeSentences.length; i++) {
      const s = activeSentences[i];
      const next = activeSentences[i + 1];
      const nextStart = next ? next.start : Infinity;
      if (t >= s.start && t <= s.end) return i;
      if (next && t > s.end && t < nextStart) {
        return (t < nextStart - 0.1) ? i : i + 1;
      }
    }
    return activeSentences.length - 1;
  }

  // Exact logic implemented in runSyncLoop
  function testSyncLoopFrame(curTime) {
    const cur = curTime;

    if (state.playMode === 'sentence' && state.activeSentences && state.activeSentences.length > 0) {
      if (state.currentSentIndex < 0 || state.currentSentIndex >= state.activeSentences.length) {
        const initialIdx = findActiveSentenceIndex(cur);
        state.currentSentIndex = initialIdx !== -1 ? initialIdx : 0;
        state.loopCount = 0;
      }

      const sent = state.activeSentences[state.currentSentIndex];
      const nextSent = (state.currentSentIndex + 1 < state.activeSentences.length) ? state.activeSentences[state.currentSentIndex + 1] : null;
      const sStart = typeof sent.start === 'number' ? sent.start : parseFloat(sent.start || 0);
      const sEnd = typeof sent.end === 'number' ? sent.end : parseFloat(sent.end || (nextSent ? nextSent.start : Infinity));
      const nextStart = nextSent ? (typeof nextSent.start === 'number' ? nextSent.start : parseFloat(nextSent.start)) : Infinity;
      const loopCutoff = Math.min(sEnd - 0.05, isFinite(nextStart) ? (nextStart - 0.08) : (sEnd - 0.05));

      if (isLoopSeeking && (Date.now() - lastSeekTs < 150)) {
        return { action: 'seeking_wait' };
      }

      if (cur >= loopCutoff - 0.04 || cur > sEnd) {
        triggerLoopSeek(sStart);
        return { action: 'loop_seek', target: sStart };
      } else {
        highlightSentence(sent.id);
        return { action: 'playing', currentSent: state.currentSentIndex };
      }
    } else if (state.playMode === 'loop3' && state.activeSentences && state.activeSentences.length > 0) {
      if (state.currentSentIndex < 0 || state.currentSentIndex >= state.activeSentences.length) {
        const initialIdx = findActiveSentenceIndex(cur);
        state.currentSentIndex = initialIdx !== -1 ? initialIdx : 0;
        state.loopCount = 0;
      }

      const sent = state.activeSentences[state.currentSentIndex];
      const nextSent = (state.currentSentIndex + 1 < state.activeSentences.length) ? state.activeSentences[state.currentSentIndex + 1] : null;
      const sStart = typeof sent.start === 'number' ? sent.start : parseFloat(sent.start || 0);
      const sEnd = typeof sent.end === 'number' ? sent.end : parseFloat(sent.end || (nextSent ? nextSent.start : Infinity));
      const nextStart = nextSent ? (typeof nextSent.start === 'number' ? nextSent.start : parseFloat(nextSent.start)) : Infinity;
      const loopCutoff = Math.min(sEnd - 0.05, isFinite(nextStart) ? (nextStart - 0.08) : (sEnd - 0.05));

      if (isLoopSeeking && (Date.now() - lastSeekTs < 150)) {
        return { action: 'seeking_wait' };
      }

      if (cur >= loopCutoff - 0.04 || cur > sEnd) {
        if (state.loopCount < 2) {
          state.loopCount++;
          triggerLoopSeek(sStart);
          return { action: 'loop3_seek_same', loopCount: state.loopCount, target: sStart };
        } else {
          state.loopCount = 0;
          if (nextSent) {
            state.currentSentIndex++;
            triggerLoopSeek(nextStart);
            highlightSentence(nextSent.id);
            return { action: 'loop3_advance', target: nextStart, newIndex: state.currentSentIndex };
          } else {
            triggerLoopSeek(sStart);
            return { action: 'loop3_seek_same', loopCount: 0, target: sStart };
          }
        }
      } else {
        highlightSentence(sent.id);
        return { action: 'playing', currentSent: state.currentSentIndex };
      }
    } else if (state.playMode === 'section' && frameworkSections.length > 0) {
      if (currentActiveSectionIndex < 0 || currentActiveSectionIndex >= frameworkSections.length) {
        const matchedSecIdx = frameworkSections.findIndex(s => cur >= s.start - 0.05 && cur <= s.end + 0.05);
        currentActiveSectionIndex = matchedSecIdx !== -1 ? matchedSecIdx : 0;
      }

      const curSec = frameworkSections[currentActiveSectionIndex];
      const nextSec = (currentActiveSectionIndex + 1 < frameworkSections.length) ? frameworkSections[currentActiveSectionIndex + 1] : null;
      if (curSec && typeof curSec.start === 'number' && typeof curSec.end === 'number' && curSec.end > curSec.start) {
        const nextSecStart = nextSec && typeof nextSec.start === 'number' ? nextSec.start : Infinity;
        const secCutoff = Math.min(curSec.end - 0.05, isFinite(nextSecStart) ? (nextSecStart - 0.08) : (curSec.end - 0.05));

        if (isLoopSeeking && (Date.now() - lastSeekTs < 150)) {
          return { action: 'seeking_wait' };
        }

        if (cur >= secCutoff - 0.04 || cur > curSec.end) {
          triggerLoopSeek(curSec.start);
          return { action: 'section_seek', target: curSec.start };
        } else {
          return { action: 'section_playing', sectionIndex: currentActiveSectionIndex };
        }
      }
    }
  }

  // updateHUDDisplay logic for section lock
  function testUpdateHUD(curTime) {
    let activeSecIdx = 0;
    if (state.playMode === 'section' && currentActiveSectionIndex >= 0 && currentActiveSectionIndex < frameworkSections.length) {
      activeSecIdx = currentActiveSectionIndex;
    } else {
      for (let i = 0; i < frameworkSections.length; i++) {
        if (curTime >= frameworkSections[i].start - 0.1) {
          activeSecIdx = i;
        } else {
          break;
        }
      }
    }
    if (state.playMode !== 'section') {
      currentActiveSectionIndex = activeSecIdx;
    }
    return { activeSecIdx, currentActiveSectionIndex };
  }

  return {
    state,
    frameworkSections,
    testSyncLoopFrame,
    testUpdateHUD,
    resetSeekLock: () => { isLoopSeeking = false; lastSeekTs = 0; },
    getSeekTargetHistory: () => seekTargetHistory,
    getCurrentSectionIndex: () => currentActiveSectionIndex,
    setSectionIndex: (idx) => { currentActiveSectionIndex = idx; }
  };
}

// -------------------------------------------------------------
// Test 1: Single Sentence Loop Drift Immunity
// -------------------------------------------------------------
console.log("[Test 1] Single Sentence Loop: Drift & Delay Immunity");
const engine1 = createMockEngine();
engine1.state.playMode = 'sentence';
engine1.state.currentSentIndex = 0; // Sentence A [0.100, 1.390]

// Normal playback
const res1 = engine1.testSyncLoopFrame(0.500);
assert.strictEqual(res1.action, 'playing');
assert.strictEqual(engine1.state.currentSentIndex, 0, "Sentence index must remain 0");

// Audio reaches cutoff boundary
engine1.resetSeekLock();
const res2 = engine1.testSyncLoopFrame(1.350); // loopCutoff is min(1.39-0.05, 2.083-0.08) = 1.34
assert.strictEqual(res2.action, 'loop_seek');
assert.strictEqual(res2.target, 0.100, "Must seek back to start of Sentence A");
assert.strictEqual(engine1.state.currentSentIndex, 0, "Sentence index must remain 0");

// CRUCIAL ADVERSARIAL TEST: Severe drift past sentence end (+1.5s = 2.89s, deep into Sentence B!)
engine1.resetSeekLock();
const res3 = engine1.testSyncLoopFrame(2.890); // 1.390 + 1.5s = 2.890s!
assert.strictEqual(res3.action, 'loop_seek');
assert.strictEqual(res3.target, 0.100, "MUST STILL seek back to Sentence A start!");
assert.strictEqual(engine1.state.currentSentIndex, 0, "Sentence index MUST NOT be corrupted to Sentence B!");
console.log("  ✓ Passed: Even when currentTime > sEnd + 1.5s (2.89s into Sentence B), currentSentIndex stays strictly 0 and seeks to 0.100s!");

// Test when currentTime < sStart - 0.3 (rewound slightly too much)
engine1.resetSeekLock();
const res4 = engine1.testSyncLoopFrame(-0.200);
assert.strictEqual(res4.action, 'playing');
assert.strictEqual(engine1.state.currentSentIndex, 0, "Sentence index must remain 0 when cur < sStart");
console.log("  ✓ Passed: Rewind past start preserves currentSentIndex locked.\n");

// -------------------------------------------------------------
// Test 2: Single Sentence 3-Loop Mode (loop3)
// -------------------------------------------------------------
console.log("[Test 2] Loop3 Mode: 3 Precise Iterations Before Advancing");
const engine2 = createMockEngine();
engine2.state.playMode = 'loop3';
engine2.state.currentSentIndex = 0; // Sentence A
engine2.state.loopCount = 0;

// Iteration 1 finished -> Loop count becomes 1, seeks back to Sentence A
engine2.resetSeekLock();
const l1 = engine2.testSyncLoopFrame(1.400);
assert.strictEqual(l1.action, 'loop3_seek_same');
assert.strictEqual(l1.loopCount, 1);
assert.strictEqual(l1.target, 0.100);
assert.strictEqual(engine2.state.currentSentIndex, 0);

// Iteration 2 finished (with +1.0s buffer drift) -> Loop count becomes 2, seeks back to Sentence A
engine2.resetSeekLock();
const l2 = engine2.testSyncLoopFrame(2.390); // drifted to 2.39s!
assert.strictEqual(l2.action, 'loop3_seek_same');
assert.strictEqual(l2.loopCount, 2);
assert.strictEqual(l2.target, 0.100);
assert.strictEqual(engine2.state.currentSentIndex, 0, "Must NOT advance on drift during iteration 2");

// Iteration 3 finished -> loopCount resets to 0, advances cleanly to Sentence B
engine2.resetSeekLock();
const l3 = engine2.testSyncLoopFrame(1.400);
assert.strictEqual(l3.action, 'loop3_advance');
assert.strictEqual(l3.target, 2.083, "Must seek to Sentence B start");
assert.strictEqual(engine2.state.currentSentIndex, 1, "Sentence index advanced to 1 (Sentence B)");
console.log("  ✓ Passed: Loop3 accurately loops 3 times on Sentence A then cleanly advances to Sentence B start!\n");

// -------------------------------------------------------------
// Test 3: Section Loop Mode (section)
// -------------------------------------------------------------
console.log("[Test 3] Section Loop Mode: Strict Outline Section Lock");
const engine3 = createMockEngine();
engine3.state.playMode = 'section';
engine3.setSectionIndex(0); // Section 0: [0.100, 16.000]

// Normal playback within section
const sRes1 = engine3.testSyncLoopFrame(8.000);
assert.strictEqual(sRes1.action, 'section_playing');
assert.strictEqual(engine3.getCurrentSectionIndex(), 0);

// Playback reaches section end cutoff (15.95s)
engine3.resetSeekLock();
const sRes2 = engine3.testSyncLoopFrame(15.950);
assert.strictEqual(sRes2.action, 'section_seek');
assert.strictEqual(sRes2.target, 0.100, "Must seek to Section 0 start");
assert.strictEqual(engine3.getCurrentSectionIndex(), 0);

// CRUCIAL ADVERSARIAL TEST: Audio drifts 1.5s past section end (17.5s, well inside Section 1!)
engine3.resetSeekLock();
const sRes3 = engine3.testSyncLoopFrame(17.500);
assert.strictEqual(sRes3.action, 'section_seek');
assert.strictEqual(sRes3.target, 0.100, "MUST seek back to Section 0 start!");
assert.strictEqual(engine3.getCurrentSectionIndex(), 0, "currentActiveSectionIndex MUST NOT be hijacked by Section 1!");
console.log("  ✓ Passed: In section loop, cur = curSec.end + 1.5s strictly seeks back to curSec.start with section index locked.");

// Test updateHUDDisplay in section mode
const hudRes = engine3.testUpdateHUD(25.000); // 25s is in section 1
assert.strictEqual(hudRes.currentActiveSectionIndex, 0, "updateHUDDisplay must NOT overwrite currentActiveSectionIndex in section mode!");
console.log("  ✓ Passed: updateHUDDisplay preserves locked currentActiveSectionIndex.\n");

console.log("======================================================================");
console.log("ALL FIRST-PRINCIPLES UNIT TESTS PASSED WITH 100% SUCCESS!");
console.log("======================================================================");
