global.window = {};
require('D:/AI_file/706_807专业课背诵手卷/data/kaoyan_data.js');

const all = [...window.KAOYAN_MANIFEST.items_807];
const bajin = all.find(it => it.title && it.title.includes('巴金'));

const c = bajin.track1.html;
const sentsMatch = c.match(/<span class="recite-sent[^"]*"[^>]*data-sent-id="([^"]+)"[^>]*data-start="([^"]+)"[^>]*data-end="([^"]+)"[^>]*>([\s\S]*?)<\/span>/g) || [];

console.log("Sent 1 raw HTML:");
console.log(sentsMatch[0]);
console.log("\nSent 2 raw HTML:");
console.log(sentsMatch[1]);
