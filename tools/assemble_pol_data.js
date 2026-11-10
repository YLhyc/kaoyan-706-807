/**
 * assemble_pol_data.js
 * 
 * 1. 从 git 历史提交 365c0f6 中提取 xutao16（16天）和 tuijie11（11天）纯净数据
 * 2. 深度验证 xutao16 考点，特别是 Day 2 考点 1：纯知识点、无寒暄
 * 3. 读取当前最新的 data/kaoyan_data_pol.js 中的 chapters47（保持其毫秒级重校对齐的时间戳与 ID）
 * 4. 组装为标准的 window.KAOYAN_POL_DATA 对象并写回 data/kaoyan_data_pol.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_DIR = path.resolve(__dirname, '..');
const POL_JS_PATH = path.join(REPO_DIR, 'data', 'kaoyan_data_pol.js');

console.log('=== Step 1: Extracting xutao16 & tuijie11 from commit 365c0f6 ===');
const gitShowContent = execSync('git show 365c0f6:data/kaoyan_data_pol.js', {
  cwd: REPO_DIR,
  maxBuffer: 50 * 1024 * 1024,
  encoding: 'utf8'
});

const sandboxOld = { window: {} };
vm.runInNewContext(gitShowContent, sandboxOld);
const oldPolData = sandboxOld.window.KAOYAN_POL_DATA;

const xutao16 = oldPolData.xutao16;
const tuijie11 = oldPolData.tuijie11;

console.log(`Extracted xutao16: ${xutao16.length} days`);
console.log(`Extracted tuijie11: ${tuijie11.length} days`);

if (xutao16.length !== 16) throw new Error(`Expected 16 days of xutao16, got ${xutao16.length}`);
if (tuijie11.length !== 11) throw new Error(`Expected 11 days of tuijie11, got ${tuijie11.length}`);

console.log('\n=== Step 2: Validating xutao16 points, Day 2 Point 1, & Timestamps ===');
// Day 2 Point 1
const day2 = xutao16.find(d => d.day === 2);
if (!day2) throw new Error('Day 2 not found in xutao16');
const d2p1 = day2.points[0];

console.log('Day 2 Point 1 html:', d2p1.html);
console.log(`Day 2 Point 1 voice: ${d2p1.voice_start} ~ ${d2p1.voice_end}s | anlang: ${d2p1.anlang_start} ~ ${d2p1.anlang_end}s`);

const d2p1Clean = d2p1.html.replace(/<[^>]+>/g, '');
if (!d2p1Clean.includes('运动着的物质的基本存在形式是时间和空间')) {
  throw new Error(`Day 2 Point 1 content mismatch! Got: ${d2p1Clean}`);
}
if (d2p1Clean.includes('今天是我们背诵笔记') || d2p1Clean.includes('挖空带背')) {
  throw new Error(`Day 2 Point 1 contains greeting chatter! Got: ${d2p1Clean}`);
}
if (d2p1.voice_start < 15.0) {
  throw new Error(`Day 2 Point 1 voice_start (${d2p1.voice_start}) seems to include intro greeting!`);
}

// All points verification
let totalPoints = 0;
xutao16.forEach(day => {
  const pts = day.points;
  totalPoints += pts.length;
  pts.forEach((p, idx) => {
    if (typeof p.voice_start !== 'number' || typeof p.voice_end !== 'number' || p.voice_start >= p.voice_end) {
      throw new Error(`Day ${day.day} P${p.num}: invalid voice timestamps [${p.voice_start}, ${p.voice_end}]`);
    }
    if (typeof p.anlang_start !== 'number' || typeof p.anlang_end !== 'number' || p.anlang_start >= p.anlang_end) {
      throw new Error(`Day ${day.day} P${p.num}: invalid anlang timestamps [${p.anlang_start}, ${p.anlang_end}]`);
    }
    const clean = p.html.replace(/<[^>]+>/g, '');
    if (clean.includes('今天是我们背诵笔记') || clean.includes('挖空带背的第二天')) {
      throw new Error(`Day ${day.day} P${p.num} contains chatter: ${clean}`);
    }
  });
});
console.log(`Verified ${totalPoints} points across 16 days in xutao16 - all valid & chatter-free.`);

console.log('\n=== Step 3: Reading current aligned chapters47 from data/kaoyan_data_pol.js ===');
const currentPolJs = fs.readFileSync(POL_JS_PATH, 'utf8');
const sandboxCur = { window: {} };
vm.runInNewContext(currentPolJs, sandboxCur);
const currentPolData = sandboxCur.window.KAOYAN_POL_DATA;

const chapters47 = currentPolData.chapters47;
if (!Array.isArray(chapters47) || chapters47.length !== 47) {
  throw new Error(`Expected 47 chapters in current data, got ${chapters47 ? chapters47.length : 0}`);
}

const totalSubcards = chapters47.reduce((sum, ch) => sum + (ch.track2?.subCards?.length || 0), 0);
console.log(`Current chapters count: ${chapters47.length}, subcards count: ${totalSubcards}`);

console.log('\n=== Step 4: Assembling window.KAOYAN_POL_DATA & Writing to disk ===');
const polDataOutput = {
  version: currentPolData.version || "3.0.4",
  chapters47: chapters47,
  xutao16: xutao16,
  tuijie11: tuijie11
};

const outputJsText = 'window.KAOYAN_POL_DATA = ' + JSON.stringify(polDataOutput, null, 2) + ';\n';
fs.writeFileSync(POL_JS_PATH, outputJsText, 'utf8');

const stat = fs.statSync(POL_JS_PATH);
const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
console.log(`Successfully written to ${POL_JS_PATH}!`);
console.log(`File size: ${stat.size} bytes (${sizeMb} MB)`);

console.log('\n=== Assembly Complete! ===');
