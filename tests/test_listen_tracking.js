const assert = require('node:assert/strict');
const L = require('../listen_tracking.js');
let passed = 0;
function test(name, fn) { fn(); console.log('[PASS] ' + name); passed++; }
function track(progress = {}, key = 'audio') {
  const t = L.ensure(progress, key, 'item', [[0, 600]]);
  t.wholeDevices.pc ||= L.emptyRound();
  return t;
}
function play(t, start, end, device = 'pc', targets = []) {
  for (let pos = start; pos < end; pos += 0.5) L.record(t, device, pos, Math.min(end, pos + 0.5), targets);
}

test('Repeating a 10% segment twenty times never earns a whole-item credit', () => {
  const t = track();
  const target = { id: 'section:0:60', windows: [[0, 60]] };
  for (let i = 0; i < 20; i++) play(t, 0, 60, 'pc', [target]);
  assert.equal(t.wholeDevices.pc.completed, 0);
  assert.equal(L.ratio(t.wholeDevices.pc, t.windows), 0.1);
  assert.equal(L.practiceCount(t, target.id), 20);
});
test('Partial coverage survives JSON reload, repeated fragments are deduplicated', () => {
  const p = {}, t = track(p);
  play(t, 0, 240); play(t, 0, 240);
  const resumed = L.normalize(JSON.parse(JSON.stringify(p))).audio;
  assert.equal(L.ratio(resumed.wholeDevices.pc, resumed.windows), 0.4);
  play(resumed, 240, 540);
  assert.equal(resumed.wholeDevices.pc.completed, 1);
});
test('Local practice requires reaching its end; 90% then skipping does not finish a pass', () => {
  const t = track(), target = { id: 'section:0:60', windows: [[0, 60]] };
  play(t, 0, 54, 'pc', [target]);
  assert.equal(L.practiceCount(t, target.id), 0);
  play(t, 59, 60, 'pc', [target]);
  assert.equal(L.practiceCount(t, target.id), 0);
  play(t, 54, 59.9, 'pc', [target]);
  assert.equal(L.practiceCount(t, target.id), 1);
});
test('Traversal tails cannot leak into the next round or inflate ten plays', () => {
  const t = track();
  for (let i = 0; i < 10; i++) play(t, 0, 600);
  assert.equal(t.wholeDevices.pc.completed, 10);
  assert.deepEqual(t.wholeDevices.pc.coverage, []);
});
test('Speech windows exclude silent gaps from the coverage denominator', () => {
  const t = L.ensure({}, 'gaps', 'item', [[10, 30], [60, 80]]);
  t.wholeDevices.pc = L.emptyRound();
  play(t, 10, 30); play(t, 60, 76);
  assert.equal(t.wholeDevices.pc.completed, 1);
});
test('Track/voice definitions stay isolated while whole-item totals aggregate', () => {
  const p = {};
  play(track(p, 'track1'), 0, 300); play(track(p, 'track2'), 300, 600);
  assert.equal(L.totals(p).item, 0);
  play(p.track1, 300, 540);
  assert.equal(L.totals(p).item, 1);
});
test('Same-device complementary halves resume; merging alone never awards a pass', () => {
  const a = {}, b = {};
  play(track(a), 0, 300); play(track(b), 300, 600);
  const ab = L.merge(a, b), ba = L.merge(b, a);
  assert.deepEqual(ab, ba);
  assert.equal(ab.audio.wholeDevices.pc.completed, 0);
  assert.equal(ab.audio.wholeDevices.pc.coverage[0][1], 600);
  play(ab.audio, 0, 1);
  assert.equal(ab.audio.wholeDevices.pc.completed, 1);
  assert.deepEqual(L.merge(ab, a), ab);
  assert.deepEqual(L.merge(ab, b), ab);
  assert.deepEqual(L.merge(ab, ab), ab);
});
test('A stale completed snapshot cannot erase the next partial round', () => {
  const a = {}; play(track(a), 0, 600);
  const old = JSON.parse(JSON.stringify(a));
  play(a.audio, 0, 120);
  const merged = L.merge(a, old);
  assert.equal(merged.audio.wholeDevices.pc.completed, 1);
  assert.equal(L.ratio(merged.audio.wholeDevices.pc, merged.audio.windows), 0.2);
  assert.deepEqual(L.merge(old, a), merged);
});
test('Independent offline whole plays add; devices cannot borrow each others partial coverage', () => {
  const a = {}, b = {};
  for (let i = 0; i < 2; i++) play(track(a), 0, 600, 'pc');
  for (let i = 0; i < 3; i++) play(track(b), 0, 600, 'phone');
  const ab = L.merge(a, b);
  assert.equal(L.totals(ab).item, 5);
  assert.deepEqual(L.merge(ab, a), ab);
  assert.deepEqual(L.merge(b, a), ab);
  assert.equal(ab.audio.wholeDevices.pc.completed, 2);
  const seed = {}; play(track(seed), 0, 480, 'pc');
  const left = L.normalize(seed), right = L.normalize(seed);
  play(left.audio, 480, 540, 'phone');
  play(right.audio, 480, 540, 'tablet');
  const merged = L.merge(left, right);
  assert.equal(L.totals(merged).item, 0);
  assert.equal(merged.audio.wholeDevices.pc.completed, 0);
  assert.equal(merged.audio.wholeDevices.phone.completed, 0);
  assert.equal(merged.audio.wholeDevices.tablet.completed, 0);
});
test('Three-device same-device replicas merge coverage associatively, commutatively and idempotently', () => {
  let seed = 20261117;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let trial = 0; trial < 100; trial++) {
    const peers = Array.from({ length: 3 }, (_, peer) => {
      const p = {}, t = track(p);
      t.wholeDevices.pc = L.emptyRound();
      for (let n = 0; n < 7; n++) {
        const start = Math.floor(random() * 10) * 60;
        play(t, start, Math.min(600, start + (peer === 0 ? 60 : 30)));
      }
      return p;
    });
    const [a, b, c] = peers, ab = L.merge(a, b);
    assert.deepEqual(L.merge(ab, a), ab);
    assert.deepEqual(L.merge(a, b), L.merge(b, a));
    assert.deepEqual(L.merge(ab, c), L.merge(a, L.merge(b, c)));
  }
});
test('Fixed practice counts add across devices and preserve unfinished portions', () => {
  const a = {}, b = {}, target = { id: 'section:0:60', windows: [[0, 60]] };
  play(track(a), 0, 60, 'pc', [target]);
  play(track(b), 0, 60, 'phone', [target]);
  play(b.audio, 0, 20, 'phone', [target]);
  const merged = L.merge(a, b);
  assert.equal(L.practiceCount(merged.audio, target.id), 2);
  assert.equal(merged.audio.practice[target.id].devices.phone.coverage[0][1], 20);
  assert.deepEqual(L.merge(merged, a), merged);
});
test('Samples count physical time at 2x, ignore jumps, stalls, seeking and paused anchors', () => {
  const a = { key: 'a', now: 1000, position: 0, rate: 2, active: true };
  const b = { key: 'a', now: 2000, position: 2, seeking: false };
  assert.equal(L.sample(a, b).seconds, 1);
  assert.equal(L.sample(a, { ...b, position: 60 }), null);
  assert.equal(L.sample(a, { ...b, position: 0 }), null);
  assert.equal(L.sample(a, { ...b, seeking: true }), null);
  assert.equal(L.sample(a, { ...b, key: 'b' }), null);
  assert.equal(L.sample({ ...a, active: false }, b), null);
  assert.equal(L.sample(a, { ...b, now: 61000, position: 120 }).seconds, 60);
});
test('Malformed records cannot introduce NaN, negative coverage or invalid practice keys', () => {
  const p = L.normalize({ x: { itemId: 'item', windows: [[-1, 10], [NaN, 20]], whole: { coverage: [[0, 999]], completed: Infinity }, practice: { arbitrary: {} } } });
  assert.deepEqual(p.x.wholeDevices, {});
  assert.deepEqual(p.x.windows, [[0, 10]]);
  assert.equal(Object.keys(p.x.wholeDevices).length, 0);
  assert.deepEqual(p.x.practice, {});
});
console.log(`${passed}/${passed} listen tracking checks passed`);
