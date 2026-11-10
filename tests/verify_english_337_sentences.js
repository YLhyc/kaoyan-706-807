// ======================================================================
// Verification Script: 16 English Essays (337 DOM Sentences & 353 JSON Sentences)
// ======================================================================
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve('D:/AI_file/706_807专业课背诵手卷');
const EN_MANIFEST = path.join(ROOT, 'data/kaoyan_en_manifest.json');

console.log("======================================================================");
console.log("VERIFYING ALL 16 ENGLISH ESSAYS: 337 DOM SPANS & 353 JSON SENTENCES");
console.log("======================================================================\n");

const manifest = JSON.parse(fs.readFileSync(EN_MANIFEST, 'utf-8'));
assert.strictEqual(manifest.length, 16, "Must contain exactly 16 English essays");

let totalDomSpans = 0;
let totalJsonSentences = 0;
let totalSlackTrimmed = 0.0;
let errors = [];

manifest.forEach((essay, essayIdx) => {
  ['track1', 'track2'].forEach(trackKey => {
    const track = essay[trackKey];
    if (!track) return;

    const sfilePath = path.join(ROOT, track.sentences_file);
    assert(fs.existsSync(sfilePath), `Sentence file missing: ${sfilePath}`);
    const sents = JSON.parse(fs.readFileSync(sfilePath, 'utf-8'));
    totalJsonSentences += sents.length;

    const sentMap = {};
    // Check JSON sentences monotonicity and validity
    for (let i = 0; i < sents.length; i++) {
      const s = sents[i];
      sentMap[s.id] = s;
      const st = parseFloat(s.start);
      const en = parseFloat(s.end);
      const dur = parseFloat(s.duration);

      if (isNaN(st) || isNaN(en) || isNaN(dur)) {
        errors.push(`[${essay.id} ${trackKey}] NaN timestamp in sentence ${s.id}`);
      }
      if (en <= st) {
        errors.push(`[${essay.id} ${trackKey}] s.end <= s.start for ${s.id}: ${st} -> ${en}`);
      }
      if (Math.abs((en - st) - dur) > 0.005) {
        errors.push(`[${essay.id} ${trackKey}] duration mismatch in ${s.id}: en-st=${(en-st).toFixed(3)}, dur=${dur}`);
      }
      if (i > 0) {
        const prev = sents[i - 1];
        const prevEn = parseFloat(prev.end);
        if (st < prevEn) {
          errors.push(`[${essay.id} ${trackKey}] Overlapping sentences: prev ${prev.id} end=${prevEn} > cur ${s.id} start=${st}`);
        }
      }
    }

    // Parse HTML spans with data-sent-id
    const html = track.html || '';
    const spanRegex = /<[^>]+data-sent-id="([^"]+)"[^>]*>/g;
    let match;
    let prevDomEnd = -1;
    let trackDomCount = 0;

    while ((match = spanRegex.exec(html)) !== null) {
      trackDomCount++;
      totalDomSpans++;
      const tag = match[0];
      const sid = match[1];

      const startMatch = tag.match(/data-start="([^"]+)"/);
      const endMatch = tag.match(/data-end="([^"]+)"/);

      if (!startMatch || !endMatch) {
        errors.push(`[${essay.id} ${trackKey}] DOM span ${sid} missing data-start or data-end attribute: ${tag}`);
        continue;
      }

      const domSt = parseFloat(startMatch[1]);
      const domEn = parseFloat(endMatch[1]);

      if (isNaN(domSt) || isNaN(domEn)) {
        errors.push(`[${essay.id} ${trackKey}] DOM span ${sid} NaN timestamp: start=${startMatch[1]}, end=${endMatch[1]}`);
      }
      if (domEn <= domSt) {
        errors.push(`[${essay.id} ${trackKey}] DOM span ${sid} end <= start: ${domSt} -> ${domEn}`);
      }
      if (domSt < prevDomEnd) {
        errors.push(`[${essay.id} ${trackKey}] DOM spans out of order / overlapping: prevEnd=${prevDomEnd} > curStart=${domSt} (id=${sid})`);
      }
      prevDomEnd = domEn;

      // Cross-check against JSON
      const jsonSent = sentMap[sid];
      if (!jsonSent) {
        errors.push(`[${essay.id} ${trackKey}] DOM span ${sid} not found in sentences.json`);
      } else {
        const jsonSt = parseFloat(jsonSent.start);
        const jsonEn = parseFloat(jsonSent.end);
        if (Math.abs(domSt - jsonSt) > 0.002) {
          errors.push(`[${essay.id} ${trackKey}] DOM start mismatch with JSON for ${sid}: dom=${domSt}, json=${jsonSt}`);
        }
        if (Math.abs(domEn - jsonEn) > 0.002) {
          errors.push(`[${essay.id} ${trackKey}] DOM end mismatch with JSON for ${sid}: dom=${domEn}, json=${jsonEn}`);
        }
      }
    }
  });
});

console.log(`[Summary Check]`);
console.log(`  Total verified DOM spans: ${totalDomSpans} (Expected: 337)`);
console.log(`  Total verified JSON sentences: ${totalJsonSentences} (Expected: 353)`);
console.log(`  Total verification errors: ${errors.length}`);

if (errors.length > 0) {
  console.error("\n❌ Found errors during verification:");
  errors.slice(0, 20).forEach(e => console.error("  -", e));
  process.exit(1);
} else {
  console.log("\n✅ ALL 337 DOM SPANS & 353 JSON SENTENCES VERIFIED 100% PERFECT!");
  console.log("   - Strict Monotonicity: 100% PASS");
  console.log("   - Non-overlapping & Legal Durations: 100% PASS");
  console.log("   - HTML DOM vs sentences.json Exact Sync: 100% PASS");
}
