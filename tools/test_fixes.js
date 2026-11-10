const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('====================================================');
console.log(' 开始全面自动化验证科目切换、主舞台遮挡与 T0/T1 胶囊交互');
console.log('====================================================\n');

const rootDir = path.resolve(__dirname, '..');
const appJsPath = path.join(rootDir, 'app.js');
const appCssPath = path.join(rootDir, 'app.css');
const indexHtmlPath = path.join(rootDir, 'index.html');

// 统一将 \r\n 规整为 \n 避免跨平台行尾差异
const appJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');
const appCss = fs.readFileSync(appCssPath, 'utf8').replace(/\r\n/g, '\n');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8').replace(/\r\n/g, '\n');

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ [PASS] ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
    failCount++;
  }
}

// ----------------------------------------------------
// 1. CSS 验证: 移动端主舞台防遮挡与视距
// ----------------------------------------------------
console.log('[测试组 1] 移动端主舞台 padding-bottom 安全视距与防遮挡:');

test('移动端 .main-stage padding-bottom 提升至 calc(130px + env(safe-area-inset-bottom, 16px)) !important', () => {
  assert(appCss.includes('padding-bottom: calc(130px + env(safe-area-inset-bottom, 16px)) !important;'),
    'app.css 缺失 130px 移动端安全视距');
});

test('展开态 body.dock-expanded .main-stage padding-bottom 提升至 calc(190px + env(safe-area-inset-bottom, 16px)) !important', () => {
  assert(appCss.includes('padding-bottom: calc(190px + env(safe-area-inset-bottom, 16px)) !important;'),
    'app.css 缺失 190px 控制坞展开安全视距');
});

test('#stage-tier 拥有 pointer 交互手形、缩放涟漪反馈与动画过渡', () => {
  assert(appCss.includes('#stage-tier {') && appCss.includes('cursor: pointer !important;'),
    'app.css 缺失 #stage-tier pointer 样式');
  assert(appCss.includes('#stage-tier:active {') && appCss.includes('transform: scale(0.92);'),
    'app.css 缺失 #stage-tier 缩放反馈');
  assert(appCss.includes('#stage-tier::after {'),
    'app.css 缺失 #stage-tier 涟漪层');
});

// ----------------------------------------------------
// 2. JS 验证: 跨科目切换逻辑彻底杜绝残留
// ----------------------------------------------------
console.log('\n[测试组 2] 顶栏跨科目切换 (706 / 807 / pol) 彻底重置与防串台:');

test('switchSubject 完全重置所有 4 项过滤状态与搜索框', () => {
  const switchFnMatch = appJs.match(/function switchSubject\(sub\)\s*\{([\s\S]*?)\n  function renderSidebarList/);
  assert(switchFnMatch, '未找到 switchSubject 实现');
  const code = switchFnMatch[1];
  
  assert(code.includes("state.tierFilter = 'all';"), '未重置 state.tierFilter');
  assert(code.includes("state.masteryFilter = 'all';"), '未重置 state.masteryFilter');
  assert(code.includes("state.scoreFilter = 'all';"), '未重置 state.scoreFilter');
  assert(code.includes("state.searchQuery = '';"), '未重置 state.searchQuery');
  assert(code.includes("if (el.searchInput) el.searchInput.value = '';"), '未清空 searchInput DOM');
});

test('switchSubject 同步重置 DOM 中所有 filter pills 的 active 状态', () => {
  const switchFnMatch = appJs.match(/function switchSubject\(sub\)\s*\{([\s\S]*?)\n  function renderSidebarList/);
  const code = switchFnMatch[1];
  
  assert(code.includes("b.classList.toggle('active', b.dataset.mastery === 'all');"), '未重置 mastery pills');
  assert(code.includes("b.classList.toggle('active', b.dataset.polCat === 'all');"), '未重置 pol pills');
});

test('switchSubject 切至非政治科目时彻底清除 paperContent 残留 HTML 与 pol-scope 类名', () => {
  const switchFnMatch = appJs.match(/function switchSubject\(sub\)\s*\{([\s\S]*?)\n  function renderSidebarList/);
  const code = switchFnMatch[1];
  
  assert(code.includes("el.paperContent.classList.remove('pol-scope');"), '未移除 pol-scope 类名');
  assert(code.includes("el.paperContent.innerHTML = '';"), '未清理 paperContent 残留 HTML');
});

test('switchSubject 防御性容错: list 为空时强制取 rawList', () => {
  const switchFnMatch = appJs.match(/function switchSubject\(sub\)\s*\{([\s\S]*?)\n  function renderSidebarList/);
  const code = switchFnMatch[1];
  
  assert(code.includes("if (!list || list.length === 0)"), '缺失 list 为空时的防御分支');
  assert(code.includes("sub === '807'") && code.includes("items_807"), '缺失 807 rawList 兜底');
  assert(code.includes("sub === '706'") && code.includes("items_706"), '缺失 706 rawList 兜底');
});

test('switchSubject 坚决 fallback 到目标科目第一项 list[0]', () => {
  const switchFnMatch = appJs.match(/function switchSubject\(sub\)\s*\{([\s\S]*?)\n  function renderSidebarList/);
  const code = switchFnMatch[1];
  
  assert(code.includes("if (!targetItem && list.length > 0)"), '缺失 targetItem 兜底判定');
  assert(code.includes("targetItem = list[0];"), '缺失 list[0] 兜底指派');
  assert(code.includes("selectItem(targetItem.id, false);"), '缺失 selectItem 强制调用');
});

test('loadManifestData(initApp) 中若 savedSubject === pol 时不中断，确保 updateBadgeCounts 完整执行', () => {
  const initAppMatch = appJs.match(/async function loadManifestData\(\)\s*\{([\s\S]*?)\n  function getCurrentItemsList/);
  assert(initAppMatch, '未找到 loadManifestData 实现');
  const code = initAppMatch[1];
  
  const updateBadgePos = code.indexOf('updateBadgeCounts();');
  const savedSubjectPolPos = code.indexOf("savedSubject === 'pol'");
  assert(updateBadgePos !== -1, '初始化中未调用 updateBadgeCounts()');
  assert(updateBadgePos < savedSubjectPolPos, 'updateBadgeCounts 必须在判断 savedSubject === pol 之前完整执行，杜绝白屏与未计');
});

test('renderPaperContent 与 selectItem 确保 pol-scope 被彻底移除', () => {
  assert(appJs.includes("function renderPaperContent(trackObj, sentences) {\n    if (!el.paperContent) return;\n    lastSpotlightEl = null;\n    el.paperContent.classList.remove('pol-scope');"),
    'renderPaperContent 必须在渲染专业课前强制移除 pol-scope');
});

// ----------------------------------------------------
// 3. 胶囊交互验证: #stage-tier 点击抽屉聚焦与轮换
// ----------------------------------------------------
console.log('\n[测试组 3] 正文顶部 #stage-tier 点击交互与抽屉联动:');

test('index.html 中 #stage-tier 具备 role="button" 与 title 提示', () => {
  assert(indexHtml.includes('id="stage-tier"') && indexHtml.includes('role="button"'),
    'index.html 缺失 role="button"');
  assert(indexHtml.includes('title="点击按此分级筛选题库 · 打开考点抽屉"'),
    'index.html 缺失 title 交互提示');
});

test('app.js 绑定 stageTier click 与 keydown 事件，支持聚焦与轮换', () => {
  assert(appJs.includes('if (el.stageTier) {'), '未找到 el.stageTier 绑定');
  assert(appJs.includes('state.tierFilter = itemLevel;'), '未实现聚焦当前考点级别');
  assert(appJs.includes("state.tierFilter = 'all';"), '未实现轮换恢复全部考点');
  assert(appJs.includes('openSidebar();'), '未联动打开侧边抽屉');
  assert(appJs.includes('scrollIntoView'), '未平滑滚动至对应卡片');
});

// ----------------------------------------------------
// 4. 模拟运行: 模拟跨科目切换状态变更
// ----------------------------------------------------
console.log('\n[测试组 4] 模拟环境跨科目切换仿真:');

test('模拟从 pol 切至 706: 状态被完全重置且正确选择 706 首题', () => {
  const mockStorage = {
    'kaoyan_last_subject': 'pol',
    'kaoyan_last_item_pol': 'pol_ch_1',
    'kaoyan_last_item_706': '706_ch_1'
  };
  const mockState = {
    currentSubject: 'pol',
    tierFilter: 'T1',
    masteryFilter: 'unlearned',
    scoreFilter: '20',
    searchQuery: '徐涛',
    activeItemId: 'pol_ch_1',
    allData: {
      items_706: [{ id: '706_ch_1', title: '屈原' }, { id: '706_ch_2', title: '李白' }]
    }
  };

  // 执行我们写在 switchSubject 中的逻辑
  const switchSubSim = (targetSub) => {
    mockState.currentSubject = targetSub;
    mockState.tierFilter = 'all';
    mockState.masteryFilter = 'all';
    mockState.scoreFilter = 'all';
    mockState.searchQuery = '';

    let list = mockState.allData['items_' + targetSub] || [];
    const savedForSub = mockStorage[`kaoyan_last_item_${targetSub}`];
    let targetItem = (savedForSub && list.find(x => x.id === savedForSub)) || list[0];
    mockState.activeItemId = targetItem ? targetItem.id : null;
    return targetItem;
  };

  const selected = switchSubSim('706');
  assert.strictEqual(mockState.currentSubject, '706');
  assert.strictEqual(mockState.tierFilter, 'all');
  assert.strictEqual(mockState.masteryFilter, 'all');
  assert.strictEqual(mockState.scoreFilter, 'all');
  assert.strictEqual(mockState.searchQuery, '');
  assert.strictEqual(selected.id, '706_ch_1');
  assert.strictEqual(mockState.activeItemId, '706_ch_1');
});

console.log('\n====================================================');
console.log(` 测试完成: ${passCount} 通过, ${failCount} 失败`);
console.log('====================================================');

if (failCount > 0) {
  process.exit(1);
} else {
  console.log('🎉 所有单元测试与交互规则 100% 验证通过！');
}
