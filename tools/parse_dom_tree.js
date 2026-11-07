global.window = {};
require('D:/AI_file/706_807专业课背诵手卷/data/kaoyan_data.js');

const all = [...window.KAOYAN_MANIFEST.items_807];
const bajin = all.find(it => it.title && it.title.includes('巴金'));

const cheerio = null;
// 手动正则提取 section-card
const cards = bajin.track1.html.match(/<section class="exam-section-card[\s\S]*?<\/section>/g) || [];
console.log("Total section cards in HTML:", cards.length);

cards.forEach((c, idx) => {
  const badgeMatch = c.match(/<span class="sec-badge[^"]*">([^<]+)<\/span>/);
  const badge = badgeMatch ? badgeMatch[1] : `Card ${idx}`;
  
  const sentsMatch = c.match(/<span class="recite-sent[^"]*"[^>]*data-sent-id="([^"]+)"[^>]*data-start="([^"]+)"[^>]*data-end="([^"]+)"[^>]*>([\s\S]*?)<\/span>/g) || [];
  console.log(`\nCard ${idx + 1}: ${badge} (contains ${sentsMatch.length} sentences)`);
  sentsMatch.slice(0, 3).forEach((s, sidx) => {
    const idM = s.match(/data-sent-id="([^"]+)"/);
    const startM = s.match(/data-start="([^"]+)"/);
    const cleanTxt = s.replace(/<[^>]+>/g, '').trim();
    console.log(`   Sent ${sidx+1} [id=${idM[1]}, start=${startM[1]}s]: ${cleanTxt}`);
  });
});
