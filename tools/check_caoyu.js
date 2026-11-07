global.window = {};
require('D:/AI_file/706_807专业课背诵手卷/data/kaoyan_data.js');

const all = [...window.KAOYAN_MANIFEST.items_807];
const caoyu = all.find(it => it.title && it.title.includes('曹禺') || (it.stem && it.stem.includes('曹禺')));

console.log("Title:", caoyu.title);
console.log("Audio:", caoyu.track1.audio);
console.log("Sentences file:", caoyu.track1.sentences_file);

const sFile = caoyu.track1.sentences_file.replace(/\\/g, '/');
const sents = window.KAOYAN_SENTENCES[sFile] || [];
console.log("Sentences count:", sents.length);
sents.slice(0, 10).forEach((s, i) => {
  console.log(`JSON [${i}] id=${s.id} [${s.start}s - ${s.end}s]: ${s.text}`);
});
