global.window = {};
require('D:/AI_file/706_807专业课背诵手卷/data/kaoyan_data.js');

const all = [...window.KAOYAN_MANIFEST.items_807];
const caoyu = all.find(it => it.title && it.title.includes('曹禺') || (it.stem && it.stem.includes('曹禺')));
const sFile = caoyu.track1.sentences_file.replace(/\\/g, '/');
const sentences = window.KAOYAN_SENTENCES[sFile];
const html = caoyu.track1.html;

let mismatches = 0;
sentences.forEach((s, idx) => {
  const pattern = new RegExp(`<span class="recite-sent[^"]*"[^>]*data-sent-id="${s.id}"[^>]*>([\\s\\S]*?)<\\/span>`);
  const m = html.match(pattern);
  if (!m) {
    console.log(`[MISMATCH MISSING] Sent id=${s.id} not found in HTML!`);
    mismatches++;
  } else {
    const htmlTxt = m[1].replace(/<[^>]+>/g, '').trim();
    const jsonTxt = s.text.trim();
    const match = htmlTxt.includes(jsonTxt) || jsonTxt.includes(htmlTxt);
    if (!match) {
      console.log(`[MISMATCH CONTENT] idx=${idx} id=${s.id}:`);
      console.log(`   JSON: "${jsonTxt}"`);
      console.log(`   HTML: "${htmlTxt}"`);
      mismatches++;
    }
  }
});

console.log(`Caoyu mismatches: ${mismatches} / ${sentences.length}`);
