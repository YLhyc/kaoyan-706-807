global.window = {};
require('D:/AI_file/706_807专业课背诵手卷/data/kaoyan_data.js');

const all = [...window.KAOYAN_MANIFEST.items_807];
const caoyu = all.find(it => it.title && it.title.includes('曹禺') || (it.stem && it.stem.includes('曹禺')));
const html = caoyu.track1.html;

const idx = html.indexOf('data-sent-id="10"');
console.log("Around id=10:");
console.log(html.slice(idx - 100, idx + 400));
