global.window = {};
require('D:/AI_file/706_807专业课背诵手卷/data/kaoyan_data.js');
const fs = require('fs');

const all = [...window.KAOYAN_MANIFEST.items_807, ...window.KAOYAN_MANIFEST.items_706, ...window.KAOYAN_MANIFEST.items_en];
const bajin = all.find(it => it.title && it.title.includes('巴金'));

const jsonPath = 'D:/AI_file/706_807专业课背诵手卷/audio_cards/807/19_T0_巴金_01_激流三部曲思想内容与宗法制度解体_20分简答_exam.sentences.json';
const s_json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

console.log('=== sentences.json (first 10) ===');
s_json.slice(0, 10).forEach((s, i) => {
  console.log(`JSON [${i}] id=${s.id} [${s.start.toFixed(2)}s - ${s.end.toFixed(2)}s]: ${s.text}`);
});

console.log('\n=== HTML parsed spans (first 10) ===');
const re = /<span class="recite-sent[^"]*"[^>]*data-sent-id="([^"]+)"[^>]*data-start="([^"]*)"[^>]*data-end="([^"]*)"[^>]*>([\s\S]*?)<\/span>/g;
let m;
let count = 0;
while ((m = re.exec(bajin.track1.html)) !== null && count < 10) {
  const clean = m[4].replace(/<[^>]+>/g, '').trim();
  console.log(`HTML [${count}] data-sent-id=${m[1]} [${m[2]}s - ${m[3]}s]: ${clean}`);
  count++;
}
