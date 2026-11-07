global.window = {};
require('D:/AI_file/706_807专业课背诵手卷/data/kaoyan_data.js');

const all = [...window.KAOYAN_MANIFEST.items_807];
const bajin = all.find(it => it.title && it.title.includes('巴金'));
const sFile = bajin.track1.sentences_file.replace(/\\/g, '/');
const sentences = window.KAOYAN_SENTENCES[sFile];

console.log("Total sentences:", sentences.length);

// 提取当前 app.js 里的查找逻辑
function findActiveSentenceIndex(currentTime, offset = 0.08) {
  const t = currentTime + offset;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i];
    if (t >= s.start - 0.03) {
      if (s.end && t > s.end + 1.8) return -1;
      return i;
    }
  }
  return -1;
}

// 模拟从 0 秒到 35 秒，每 0.5 秒采样一次
for (let t = 0.0; t <= 35.0; t += 0.5) {
  const idx = findActiveSentenceIndex(t);
  const sent = idx >= 0 ? sentences[idx] : null;
  const sentText = sent ? sent.text.slice(0, 20) : "--- 空白 ---";
  const sentRange = sent ? `[${sent.start}s - ${sent.end}s]` : "";
  console.log(`Time ${t.toFixed(1)}s -> Match [${idx}] ${sentRange}: ${sentText}`);
}
