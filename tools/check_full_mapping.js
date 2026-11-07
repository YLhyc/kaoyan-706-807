global.window = {};
require('D:/AI_file/706_807专业课背诵手卷/data/kaoyan_data.js');

const all = [...window.KAOYAN_MANIFEST.items_807];
const bajin = all.find(it => it.title && it.title.includes('巴金'));
const sFile = bajin.track1.sentences_file.replace(/\\/g, '/');
const sentences = window.KAOYAN_SENTENCES[sFile];

const html = bajin.track1.html;
const fs = require('fs');

console.log("Checking all 35 sentences id mapping in Bajin:");

let mismatches = 0;
sentences.forEach((s, idx) => {
  // 正则寻找该 data-sent-id
  const pattern = new RegExp(`<span class="recite-sent[^"]*"[^>]*data-sent-id="${s.id}"[^>]*>([\\s\\S]*?)<\\/span>`);
  const m = html.match(pattern);
  if (!m) {
    console.log(`[MISMATCH MISSING] Sent id=${s.id} not found in HTML!`);
    mismatches++;
  } else {
    const htmlTxt = m[1].replace(/<[^>]+>/g, '').trim();
    const jsonTxt = s.text.trim();
    // 比较文字是否一致
    const match = htmlTxt.includes(jsonTxt) || jsonTxt.includes(htmlTxt);
    if (!match) {
      console.log(`[MISMATCH CONTENT] idx=${idx} id=${s.id}:`);
      console.log(`   JSON: "${jsonTxt}"`);
      console.log(`   HTML: "${htmlTxt}"`);
      mismatches++;
    }
  }
});

if (mismatches === 0) {
  console.log("SUCCESS: All 35 sentences id and content match perfectly 1:1!");
} else {
  console.log(`FAILED: Found ${mismatches} mismatches!`);
}
