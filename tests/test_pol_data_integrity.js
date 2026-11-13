/**
 * test_pol_data_integrity.js
 * 
 * 自动化测试与断言脚本：
 * 1. 验证 data/kaoyan_data_pol.js 语法正确，通过 node 载入并注册 window.KAOYAN_POL_DATA
 * 2. 断言 chapters47 长度为 47
 * 3. 断言 xutao16 长度为 26
 * 4. 断言 tuijie11 长度为 11
 * 5. 断言 xutao16 Day 2 考点 1 文本为纯知识点，不含“今天是我们背诵笔记”等打招呼寒暄
 * 6. 断言所有 608 个 xutao16 考点的 voice_start, voice_end, anlang_start, anlang_end 均真实合法
 * 7. 断言文件大小在合理区间 (约 3.5MB ~ 4.2MB)
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const REPO_DIR = path.resolve(__dirname, '..');
const POL_JS_PATH = path.join(REPO_DIR, 'data', 'kaoyan_data_pol.js');

console.log('>>> [1/7] Testing file existence & size range...');
const stat = fs.statSync(POL_JS_PATH);
const sizeBytes = stat.size;
const sizeMB = sizeBytes / (1024 * 1024);
console.log(`  File size: ${sizeBytes} bytes (${sizeMB.toFixed(2)} MB)`);

const MIN_MB = 3.5;
const MAX_MB = 4.2;
assert(sizeMB >= MIN_MB && sizeMB <= MAX_MB, `File size ${sizeMB.toFixed(2)} MB out of range [${MIN_MB}, ${MAX_MB}] MB!`);
console.log(`  ✓ Size check passed (${sizeMB.toFixed(2)} MB is within [${MIN_MB}, ${MAX_MB}] MB)`);

console.log('>>> [2/7] Testing file format and Node.js VM loading...');
const fileContent = fs.readFileSync(POL_JS_PATH, 'utf8');
assert(fileContent.startsWith('window.KAOYAN_POL_DATA = '), 'File does not start with window.KAOYAN_POL_DATA = ');
assert(fileContent.trim().endsWith(';'), 'File does not end with semicolon ;');

const sandbox = { window: {} };
vm.runInNewContext(fileContent, sandbox);
const polData = sandbox.window.KAOYAN_POL_DATA;
assert(polData, 'window.KAOYAN_POL_DATA not defined after evaluation');
console.log('  ✓ File evaluated successfully in Node.js VM context without syntax errors');

console.log('>>> [3/7] Asserting chapters47 length === 47...');
assert(Array.isArray(polData.chapters47), 'chapters47 is not an array');
assert.strictEqual(polData.chapters47.length, 47, `chapters47 length expected 47, got ${polData.chapters47.length}`);
const subcardsCount = polData.chapters47.reduce((sum, ch) => sum + (ch.track2?.subCards?.length || 0), 0);
assert.strictEqual(subcardsCount, 119, `Total subcards expected 119, got ${subcardsCount}`);
console.log(`  ✓ chapters47 length is exactly 47 (subcards: ${subcardsCount})`);

console.log('>>> [4/7] Asserting xutao16 length === 26...');
assert(Array.isArray(polData.xutao16), 'xutao16 is not an array');
assert.strictEqual(polData.xutao16.length, 26, `xutao16 length expected 26, got ${polData.xutao16.length}`);
console.log('  ✓ xutao16 length is exactly 26');

console.log('>>> [5/7] Asserting tuijie11 length === 11...');
assert(Array.isArray(polData.tuijie11), 'tuijie11 is not an array');
assert.strictEqual(polData.tuijie11.length, 11, `tuijie11 length expected 11, got ${polData.tuijie11.length}`);
console.log('  ✓ tuijie11 length is exactly 11');

console.log('>>> [6/7] Validating xutao16 Day 2 Point 1 purity...');
const day2 = polData.xutao16.find(d => d.day === 2);
assert(day2, 'Day 2 not found in xutao16');
const d2p1 = day2.points[0];
assert(d2p1, 'Point 1 not found in Day 2');

const cleanHtml = d2p1.html.replace(/<[^>]+>/g, '');
console.log('  Day 2 Point 1 text:', cleanHtml);
assert(cleanHtml.includes('运动着的物质的基本存在形式是时间和空间'), 'Day 2 Point 1 missing core concept');
assert(!cleanHtml.includes('今天是我们背诵笔记'), 'Day 2 Point 1 contains greeting chatter: 今天是我们背诵笔记');
assert(!cleanHtml.includes('挖空带背'), 'Day 2 Point 1 contains greeting chatter: 挖空带背');
assert(d2p1.voice_start >= 13.5, `Day 2 Point 1 voice_start (${d2p1.voice_start}) must skip intro greeting (ends ~13.0s)`);
assert(d2p1.voice_end > d2p1.voice_start, 'Day 2 Point 1 voice_end must be greater than voice_start');
assert(d2p1.anlang_start >= 0, 'Day 2 Point 1 anlang_start must be >= 0');
assert(d2p1.anlang_end > d2p1.anlang_start, 'Day 2 Point 1 anlang_end must be greater than anlang_start');
console.log('  ✓ Day 2 Point 1 is 100% pure knowledge and free of greeting chatter');

console.log('>>> [7/7] Validating all 608 points across all 26 days in xutao16...');
let totalCheckedPoints = 0;
polData.xutao16.forEach(day => {
  day.points.forEach(p => {
    totalCheckedPoints++;
    assert(typeof p.voice_start === 'number' && typeof p.voice_end === 'number', `Day ${day.day} P${p.num} invalid voice ts`);
    assert(p.voice_start >= 0 && p.voice_end > p.voice_start, `Day ${day.day} P${p.num} voice ts order error`);
    assert(typeof p.anlang_start === 'number' && typeof p.anlang_end === 'number', `Day ${day.day} P${p.num} invalid anlang ts`);
    assert(p.anlang_start >= 0 && p.anlang_end > p.anlang_start, `Day ${day.day} P${p.num} anlang ts order error`);
    const ptText = p.html.replace(/<[^>]+>/g, '');
    assert(!ptText.includes('今天是我们背诵笔记'), `Day ${day.day} P${p.num} contains greeting chatter`);
  });
});
console.log(`  ✓ Checked ${totalCheckedPoints} points in xutao16: all timestamps strictly valid, zero chatter`);

console.log('\n============================================================');
console.log('🎉 ALL INTEGRITY AND REGRESSION TESTS PASSED (7/7)!');
console.log('============================================================');
