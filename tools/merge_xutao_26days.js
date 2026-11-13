/**
 * merge_xutao_26days.js
 *
 * 将 D:\AI_file\背诵手册\xutao_26days_final.json 中的 Day 17..26（238 个考点）
 * 安全无损地合并进 D:\AI_file\706_807专业课背诵手卷\data\kaoyan_data_pol.js：
 * - 严格保留现有 chapters47、tuijie11 以及 xutao16 前 16 天（Day 1..16）的原样数据与 v3.2.8 修复
 * - 按 kaoyan_data_pol.js 规范精简点位字段为 { id, num, tag, html, voice_start, voice_end, anlang_start, anlang_end }
 * - 校验全部 26 个 audio_xutao/xt_voice_dXX.mp3 与 xt_anlang_dXX.mp3 均存在
 * - 强制以严格 LF (\n) 写回 data/kaoyan_data_pol.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const REPO_DIR = path.resolve(__dirname, '..');
const POL_JS_PATH = path.join(REPO_DIR, 'data', 'kaoyan_data_pol.js');
const FINAL_26_JSON = 'D:\\AI_file\\背诵手册\\xutao_26days_final.json';

function main() {
  assert(fs.existsSync(POL_JS_PATH), `Missing ${POL_JS_PATH}`);
  assert(fs.existsSync(FINAL_26_JSON), `Missing ${FINAL_26_JSON}`);

  const curRaw = fs.readFileSync(POL_JS_PATH, 'utf8');
  const ctx = { window: {} };
  vm.runInNewContext(curRaw, ctx);
  const polData = ctx.window.KAOYAN_POL_DATA;
  assert(polData && Array.isArray(polData.chapters47), 'Invalid chapters47');
  assert(Array.isArray(polData.xutao16), 'Invalid xutao16');
  assert(Array.isArray(polData.tuijie11), 'Invalid tuijie11');

  const existing16 = polData.xutao16.filter(d => d.day >= 1 && d.day <= 16);
  assert.strictEqual(existing16.length, 16, `Expected 16 existing days, got ${existing16.length}`);

  const final26 = JSON.parse(fs.readFileSync(FINAL_26_JSON, 'utf8'));
  const newDays17to26 = final26
    .filter(d => d.day >= 17 && d.day <= 26)
    .map(d => ({
      id: d.id,
      day: d.day,
      title: d.title,
      subtitle: d.subtitle,
      subject: d.subject,
      duration_sec: d.duration_sec,
      anlang_audio: d.anlang_audio,
      voice_audio: d.voice_audio,
      points: d.points.map(p => ({
        id: p.id,
        num: p.num,
        tag: p.tag,
        html: p.html,
        voice_start: p.voice_start,
        voice_end: p.voice_end,
        anlang_start: p.anlang_start,
        anlang_end: p.anlang_end
      }))
    }));

  assert.strictEqual(newDays17to26.length, 10, `Expected 10 new days (17..26), got ${newDays17to26.length}`);

  const merged26 = [...existing16, ...newDays17to26];
  assert.strictEqual(merged26.length, 26, 'Expected 26 days total');

  let totalPts = 0;
  for (let i = 0; i < merged26.length; i++) {
    const d = merged26[i];
    assert.strictEqual(d.day, i + 1, `Day sequence mismatch at index ${i}: ${d.day}`);
    assert(fs.existsSync(path.join(REPO_DIR, d.voice_audio)), `Missing voice file: ${d.voice_audio}`);
    assert(fs.existsSync(path.join(REPO_DIR, d.anlang_audio)), `Missing anlang file: ${d.anlang_audio}`);
    totalPts += d.points.length;
    for (const p of d.points) {
      assert(typeof p.voice_start === 'number' && typeof p.voice_end === 'number' && p.voice_start < p.voice_end, `Bad voice span in ${p.id}`);
      assert(typeof p.anlang_start === 'number' && typeof p.anlang_end === 'number' && p.anlang_start < p.anlang_end, `Bad anlang span in ${p.id}`);
      assert(typeof p.html === 'string' && p.html.trim().length > 0, `Empty html in ${p.id}`);
      if (d.day >= 17) {
        assert(p.html.includes('cloze'), `Missing cloze highlight in ${p.id}`);
      }
    }
  }
  assert.strictEqual(totalPts, 608, `Expected 608 total points, got ${totalPts}`);

  const nextPolData = {
    version: polData.version || '3.0.4',
    chapters47: polData.chapters47,
    xutao16: merged26,
    tuijie11: polData.tuijie11
  };

  const jsonText = JSON.stringify(nextPolData, null, 2).replace(/\r\n/g, '\n');
  const outText = `window.KAOYAN_POL_DATA = ${jsonText};\n`;
  fs.writeFileSync(POL_JS_PATH, outText, 'utf8');

  // Verify lossless preservation vs HEAD (ignoring cross-VM prototypes)
  const { execSync } = require('child_process');
  const headRaw = execSync('git show HEAD:data/kaoyan_data_pol.js', { cwd: REPO_DIR, maxBuffer: 60 * 1024 * 1024, encoding: 'utf8' });
  const headCtx = { window: {} };
  vm.runInNewContext(headRaw, headCtx);
  const headPol = headCtx.window.KAOYAN_POL_DATA;

  const verifyCtx = { window: {} };
  vm.runInNewContext(fs.readFileSync(POL_JS_PATH, 'utf8'), verifyCtx);
  const newPol = verifyCtx.window.KAOYAN_POL_DATA;

  assert.strictEqual(JSON.stringify(newPol.chapters47), JSON.stringify(headPol.chapters47), 'chapters47 mutated vs HEAD!');
  assert.strictEqual(JSON.stringify(newPol.tuijie11), JSON.stringify(headPol.tuijie11), 'tuijie11 mutated vs HEAD!');
  assert.strictEqual(JSON.stringify(newPol.xutao16.slice(0, 16)), JSON.stringify(headPol.xutao16), 'Days 1..16 mutated vs HEAD!');

  const sizeMB = (fs.statSync(POL_JS_PATH).size / (1024 * 1024)).toFixed(2);
  console.log(`✅ Merged 26 days (${totalPts} points) into ${POL_JS_PATH} (${sizeMB} MB, strict LF) with 0 loss to chapters47/tuijie11/Day1-16.`);
}

main();
