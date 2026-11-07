global.window = {};
require('D:/AI_file/706_807专业课背诵手卷/data/kaoyan_data.js');

const all = [...window.KAOYAN_MANIFEST.items_807];
const caoyu = all.find(it => it.title && it.title.includes('曹禺') || (it.stem && it.stem.includes('曹禺')));

// 提取 HTML 中的 recite-sent
const html = caoyu.track1.html;
const fs = require('fs');
fs.writeFileSync('D:/caoyu_html.txt', html, 'utf8');

const sents = [];
const re = /<span class="recite-sent[^"]*"[^>]*data-sent-id="([^"]+)"[^>]*data-start="([^"]*)"[^>]*data-end="([^"]*)"[^>]*>([\s\S]*?)<\/span>/g;
let m;
let c = 0;
while ((m = re.exec(html)) !== null && c < 10) {
  const clean = m[4].replace(/<[^>]+>/g, '').trim();
  console.log(`HTML [${c}] id=${m[1]} [${m[2]}s - ${m[3]}s]: ${clean}`);
  c++;
}
