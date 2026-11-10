// Unit test for Audio Loop Precision & Forensic Fixes
const assert = require('assert');

console.log('Testing sanitizeSentences logic...');

function sanitizeSentences(sentences) {
  if (!sentences || !Array.isArray(sentences) || sentences.length === 0) return [];
  const list = sentences.map((s, idx) => {
    const start = typeof s.start === 'number' ? s.start : parseFloat(s.start || 0);
    let end = typeof s.end === 'number' ? s.end : parseFloat(s.end || 0);
    return {
      ...s,
      id: s.id !== undefined ? s.id : (s.idx !== undefined ? s.idx : idx),
      start: isNaN(start) ? 0 : start,
      end: isNaN(end) ? (start + 1.0) : end,
      idx: s.idx !== undefined ? s.idx : idx
    };
  });
  list.sort((a, b) => a.start - b.start);
  for (let i = 0; i < list.length - 1; i++) {
    if (list[i].end > list[i + 1].start) {
      list[i].end = list[i + 1].start;
    }
  }
  return list;
}

// Test 1: Overlapping sentences clamped
const rawSents = [
  { id: 1, start: 0.1, end: 5.5 },
  { id: 2, start: 5.0, end: 10.0 }
];
const cleaned = sanitizeSentences(rawSents);
assert.strictEqual(cleaned[0].end, 5.0, 'Sentence 0 end must be clamped to sentence 1 start');
assert.strictEqual(cleaned[1].start, 5.0);
console.log('  [PASS] sanitizeSentences clamps overlaps properly.');

// Test 2: Single Sentence Loop Cutoff calculation
function getSentenceLoopCutoff(sent, nextSent) {
  const sStart = typeof sent.start === 'number' ? sent.start : parseFloat(sent.start || 0);
  const sEnd = typeof sent.end === 'number' ? sent.end : parseFloat(sent.end || (nextSent ? nextSent.start : Infinity));
  const nextStart = nextSent ? (typeof nextSent.start === 'number' ? nextSent.start : parseFloat(nextSent.start)) : Infinity;
  const loopCutoff = Math.min(sEnd - 0.05, isFinite(nextStart) ? (nextStart - 0.08) : (sEnd - 0.05));
  return { sStart, sEnd, nextStart, loopCutoff, triggerTime: loopCutoff - 0.04 };
}

// Case A: Contiguous sentences without silence (Edge TTS typical)
const cA = getSentenceLoopCutoff({ start: 10.0, end: 15.0 }, { start: 15.0, end: 20.0 });
assert.ok(cA.triggerTime <= 15.0 - 0.12, 'Must trigger at least 120ms before next sentence start');
assert.ok(Math.abs(cA.triggerTime - 14.88) < 1e-6);
console.log('  [PASS] Contiguous sentence loop cutoff triggers at 14.88s (120ms before sentence B starts at 15.0s).');

// Case B: Sentences with natural silence gap
const cB = getSentenceLoopCutoff({ start: 10.0, end: 14.2 }, { start: 15.0, end: 20.0 });
assert.ok(Math.abs(cB.loopCutoff - 14.15) < 1e-6);
assert.ok(Math.abs(cB.triggerTime - 14.11) < 1e-6);
console.log('  [PASS] Sentence with silence gap loops promptly at 14.11s (end of sentence speech, no awkward silence wait).');

// Case C: Final sentence (no next sentence)
const cC = getSentenceLoopCutoff({ start: 10.0, end: 15.0 }, null);
assert.ok(Math.abs(cC.loopCutoff - 14.95) < 1e-6);
assert.ok(Math.abs(cC.triggerTime - 14.91) < 1e-6);
console.log('  [PASS] Final sentence loops at 14.91s.');

// Test 3: Section Loop Cutoff calculation
function getSectionLoopCutoff(curSec, nextSec) {
  const nextSecStart = nextSec && typeof nextSec.start === 'number' ? nextSec.start : Infinity;
  const secCutoff = Math.min(curSec.end - 0.05, isFinite(nextSecStart) ? (nextSecStart - 0.08) : (curSec.end - 0.05));
  return { secCutoff, triggerTime: secCutoff - 0.04 };
}

const secA = getSectionLoopCutoff({ start: 0.0, end: 30.0 }, { start: 30.0, end: 60.0 });
assert.ok(Math.abs(secA.triggerTime - 29.88) < 1e-6);
console.log('  [PASS] Section loop cutoff triggers at 29.88s (before next section starts at 30.0s).');

// Test 4: Seeking Anti-Reentry Simulation
let isLoopSeeking = false;
let lastSeekTs = 0;
let seekCount = 0;
function mockTriggerLoopSeek(t) {
  const now = Date.now();
  if (isLoopSeeking && (now - lastSeekTs < 150)) {
    return false; // throttled / protected
  }
  isLoopSeeking = true;
  lastSeekTs = now;
  seekCount++;
  return true;
}

assert.strictEqual(mockTriggerLoopSeek(10.0), true, 'First seek must trigger');
assert.strictEqual(mockTriggerLoopSeek(10.0), false, 'Immediate second seek within 150ms must be blocked');
assert.strictEqual(mockTriggerLoopSeek(10.0), false, 'Third seek within 150ms must be blocked');
assert.strictEqual(seekCount, 1, 'Only exactly 1 seek must execute');
console.log('  [PASS] Anti-reentry guard successfully prevents seek thrashing.');

console.log('\nAll loop precision unit tests passed with 100% success!');
