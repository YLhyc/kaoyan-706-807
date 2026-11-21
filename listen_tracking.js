/* Listen coverage arithmetic shared by the player and sync. No storage or network. */
(function (root) {
  'use strict';
  const THRESHOLD = 0.9;
  const MAX_BANK_LAYERS = 50;
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const count = value => Math.max(0, Math.floor(number(value)));
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const millis = value => Math.round(number(value) * 1000) / 1000;

  function union(ranges) {
    const sorted = (Array.isArray(ranges) ? ranges : [])
      .filter(r => Array.isArray(r) && r.length === 2 && Number.isFinite(Number(r[0])) && Number.isFinite(Number(r[1])))
      .map(r => [Math.max(0, millis(r[0])), Math.max(0, millis(r[1]))])
      .filter(r => r[1] > r[0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const out = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else out.push(r);
    }
    return out;
  }

  function intersect(a, b) {
    const out = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      const start = Math.max(a[i][0], b[j][0]), end = Math.min(a[i][1], b[j][1]);
      if (end > start) out.push([start, end]);
      if (a[i][1] < b[j][1]) i++;
      else j++;
    }
    return out;
  }

  const seconds = ranges => ranges.reduce((sum, r) => sum + r[1] - r[0], 0);
  const ratio = (round, windows) => {
    const total = seconds(windows);
    return total > 0 ? Math.min(1, seconds(round.coverage) / total) : 0;
  };
  const emptyRound = () => ({ completed: 0, coverage: [], bank: [], sealedAt: null });

  function normalizeBank(rawBank, windows) {
    if (!Array.isArray(rawBank)) return [];
    const out = [];
    for (let i = 0; i < rawBank.length && out.length < MAX_BANK_LAYERS; i++) {
      const layer = intersect(union(rawBank[i]), windows);
      if (layer.length) out.push(layer);
    }
    return out;
  }

  function trimBank(bank) {
    if (!Array.isArray(bank)) return [];
    let end = bank.length;
    while (end > 0 && (!Array.isArray(bank[end - 1]) || bank[end - 1].length === 0)) end--;
    return bank.slice(0, Math.min(end, MAX_BANK_LAYERS));
  }

  function total(track) {
    if (!track) return 0;
    return Object.values(object(track.wholeDevices)).reduce((sum, round) => sum + count(round.completed), 0);
  }

  function roundEquivalent(round, windows) {
    if (!round) return 0;
    const totalSec = seconds(windows);
    let eq = count(round.completed);
    if (totalSec > 0) {
      eq += Math.min(1, seconds(Array.isArray(round.coverage) ? round.coverage : []) / totalSec);
      const bank = Array.isArray(round.bank) ? round.bank : [];
      for (const layer of bank) {
        eq += Math.min(1, seconds(Array.isArray(layer) ? layer : []) / totalSec);
      }
    }
    return eq;
  }

  function equivalent(track) {
    if (!track) return 0;
    const windows = Array.isArray(track.windows) ? track.windows : [];
    return Object.values(object(track.wholeDevices)).reduce((sum, round) => sum + roundEquivalent(round, windows), 0);
  }

  function normalizeRound(raw, windows) {
    const src = object(raw);
    return {
      completed: count(src.completed),
      coverage: intersect(union(src.coverage), windows),
      bank: normalizeBank(src.bank, windows),
      sealedAt: src.sealedAt != null && Number.isFinite(Number(src.sealedAt)) ? Math.max(0, millis(src.sealedAt)) : null
    };
  }

  function completeIfReady(round, windows, end, practice = false) {
    const totalSec = seconds(windows);
    const tailTolerance = Math.min(0.25, totalSec * 0.22);
    const requiredRatio = practice ? Math.min(0.98, (totalSec - tailTolerance) / totalSec) : THRESHOLD;
    if (ratio(round, windows) + 1e-8 < requiredRatio) return false;
    if (practice && end < windows[windows.length - 1][1] - tailTolerance - 1e-8) return false;
    let credited = false;
    while (ratio(round, windows) + 1e-8 >= requiredRatio) {
      if (practice && credited) break;
      round.completed++;
      credited = true;
      if (!practice && Array.isArray(round.bank) && round.bank.length > 0) {
        round.coverage = round.bank.shift();
        round.bank = trimBank(round.bank);
      } else {
        round.coverage = [];
      }
      // Ignore the rest of this traversal. Otherwise its tail leaks into the next
      // round and ten complete plays can eventually become eleven credits.
      round.sealedAt = millis(end);
    }
    return credited;
  }

  function advance(round, windows, from, to, practice = false) {
    const heard = intersect(union([[from, to]]), windows);
    if (!heard.length) return false;
    if (round.sealedAt != null) {
      if (from >= round.sealedAt - 0.05) return false;
      round.sealedAt = null;
    }
    if (practice) {
      round.coverage = union([...round.coverage, ...heard]);
      return completeIfReady(round, windows, to, true);
    }
    // Pour heard segments through layered coverage bank:
    // already-covered portions overflow into bank[0], bank[1], ... so repeated
    // section/sentence drills are banked instead of discarded by flat union().
    if (!Array.isArray(round.bank)) round.bank = [];
    let overflow = intersect(round.coverage, heard);
    round.coverage = union([...round.coverage, ...heard]);
    let layerIdx = 0;
    while (overflow.length > 0 && layerIdx < MAX_BANK_LAYERS) {
      const curLayer = Array.isArray(round.bank[layerIdx]) ? round.bank[layerIdx] : [];
      const nextOverflow = intersect(curLayer, overflow);
      round.bank[layerIdx] = union([...curLayer, ...overflow]);
      overflow = nextOverflow;
      layerIdx++;
    }
    round.bank = trimBank(round.bank);
    return completeIfReady(round, windows, to, false);
  }

  function mergeRound(left, right, windows, practice = false) {
    const a = normalizeRound(left, windows), b = normalizeRound(right, windows);
    if (a.completed !== b.completed) return a.completed > b.completed ? a : b;
    const coverage = union([...a.coverage, ...b.coverage]);
    const maxBankLen = practice ? 0 : Math.max(a.bank.length, b.bank.length);
    const bank = [];
    for (let i = 0; i < maxBankLen && i < MAX_BANK_LAYERS; i++) {
      const mergedLayer = union([...(a.bank[i] || []), ...(b.bank[i] || [])]);
      if (mergedLayer.length) bank.push(mergedLayer);
    }
    const out = {
      completed: a.completed,
      coverage,
      bank: trimBank(bank),
      sealedAt: (a.sealedAt == null || b.sealedAt == null) ? null : Math.max(a.sealedAt, b.sealedAt)
    };
    return out;
  }

  function normalize(raw) {
    const out = {};
    for (const key of Object.keys(object(raw)).sort()) {
      const src = object(raw[key]), windows = union(src.windows);
      if (!windows.length || typeof src.itemId !== 'string' || !src.itemId) continue;
      const practice = {};
      for (const id of Object.keys(object(src.practice)).sort()) {
        const p = object(src.practice[id]), w = intersect(union(p.windows), windows), devices = {};
        if (!w.length || !/^(section|sentence):/.test(id)) continue;
        for (const dev of Object.keys(object(p.devices)).sort()) {
          devices[dev] = normalizeRound(p.devices[dev], w);
        }
        practice[id] = { windows: w, devices };
      }
      const wholeDevices = {};
      Object.entries(object(src.wholeDevices)).forEach(([dev, round]) => { wholeDevices[dev] = normalizeRound(round, windows); });
      out[key] = { itemId: src.itemId, windows, wholeDevices, practice };
    }
    return out;
  }

  function merge(local, remote) {
    const a = normalize(local), b = normalize(remote), out = {};
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!a[key] || !b[key]) { out[key] = a[key] || b[key]; continue; }
      const left = a[key], right = b[key];
      // Keys include the timing fingerprint; reject inconsistent definitions
      // deterministically instead of combining positions from different audio.
      if (left.itemId !== right.itemId || JSON.stringify(left.windows) !== JSON.stringify(right.windows)) {
        out[key] = JSON.stringify(left) < JSON.stringify(right) ? left : right;
        continue;
      }
      const windows = left.windows, practice = {};
      for (const id of [...new Set([...Object.keys(left.practice), ...Object.keys(right.practice)])].sort()) {
        const p = left.practice[id], q = right.practice[id];
        if (!p || !q) { practice[id] = p || q; continue; }
        const w = p.windows, devices = {};
        for (const dev of [...new Set([...Object.keys(p.devices), ...Object.keys(q.devices)])].sort()) {
          devices[dev] = mergeRound(p.devices[dev], q.devices[dev], w, true);
        }
        practice[id] = { windows: w, devices };
      }
      const wholeDevices = {};
      for (const dev of [...new Set([...Object.keys(left.wholeDevices), ...Object.keys(right.wholeDevices)])].sort()) {
        wholeDevices[dev] = mergeRound(left.wholeDevices[dev], right.wholeDevices[dev], windows);
      }
      out[key] = { itemId: left.itemId, windows, wholeDevices, practice };
    }
    return out;
  }

  function ensure(progress, key, itemId, windows) {
    if (!progress[key]) progress[key] = { itemId, windows: union(windows), wholeDevices: {}, practice: {} };
    return progress[key];
  }

  function record(track, deviceId, from, to, targets = []) {
    const whole = track.wholeDevices[deviceId] || (track.wholeDevices[deviceId] = emptyRound());
    const credited = advance(whole, track.windows, from, to);
    for (const target of targets) {
      const w = intersect(union(target.windows), track.windows);
      if (!intersect([[from, to]], w).length) continue;
      const p = track.practice[target.id] || (track.practice[target.id] = { windows: w, devices: {} });
      const round = p.devices[deviceId] || (p.devices[deviceId] = emptyRound());
      advance(round, p.windows, from, to, true);
    }
    return credited;
  }

  function totals(progress) {
    const out = {};
    Object.values(object(progress)).forEach(track => {
      out[track.itemId] = (out[track.itemId] || 0) + total(track);
    });
    return out;
  }

  function practiceCount(track, id) {
    const p = track && track.practice[id];
    return p ? Object.values(p.devices).reduce((sum, r) => sum + count(r.completed), 0) : 0;
  }

  // A jump is never an interval. Rate changes are flushed by the player before
  // replacing the anchor, so real time is distinct from media position.
  function sample(previous, current) {
    if (!previous || !previous.active || previous.key !== current.key || current.seeking) return null;
    const wall = (current.now - previous.now) / 1000;
    const media = current.position - previous.position;
    if (!(wall > 0 && media > 0 && previous.rate > 0)) return null;
    if (media > wall * previous.rate + 0.35) return null;
    return { from: previous.position, to: current.position, seconds: Math.min(wall, media / previous.rate) };
  }

  const api = { THRESHOLD, union, intersect, seconds, ratio, emptyRound, roundEquivalent, equivalent, advance, normalize, merge, ensure, record, total, totals, practiceCount, sample };
  root.KaoyanListen = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
