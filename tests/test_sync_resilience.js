// Execute the real ai_sync.js closure in a VM; all storage/network is in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createEngine() {
  const storage = new Map();
  const sandbox = {
    console: { log() {}, warn() {} },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 100)), clearTimeout,
    AbortController,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value))
    },
    document: { readyState: 'loading', addEventListener() {}, getElementById() { return null; } },
    fetch: () => { throw new Error('Network must be mocked'); },
    window: {}
  };
  let source = fs.readFileSync(path.join(__dirname, '../ai_sync.js'), 'utf8');
  const end = source.lastIndexOf('})();');
  source = source.slice(0, end) + `
    window.audit = { fetchWithTimeout, readSyncJsonResponse, syncBidirectional,
      mergeStudyLogsWithRemote, mergeSyncBucketPair, markSyncDirty, aiState,
      generateAiClozeForCurrentItem, stubClozeModel() {
        streamDeepSeek = async () => ({ content: JSON.stringify({ skeleton: ['测试骨架词'], scoring: ['测试采分眼'] }) });
        getScopeContext = () => ({ itemId: 'audit-cloze', itemTitle: 'audit', subjectLabel: '706',
          fullRefText: '测试骨架词与测试采分眼都来自本地合成正文，用于测试错误响应。' });
      } };
  ` + source.slice(end);
  vm.runInNewContext(source, sandbox, { filename: 'ai_sync.js' });
  storage.set('kaoyan_sync_url', 'https://audit.invalid');
  storage.set('kaoyan_sync_pin', 'synthetic-test-pin');
  return { sandbox, storage, api: sandbox.window.audit };
}

async function main() {
  const { sandbox, storage, api } = createEngine();
  let signal;
  sandbox.fetch = async (_, options) => {
    signal = options.signal;
    return { ok: true, status: 200, json: () => new Promise(() => {}) };
  };
  await assert.rejects(
    api.fetchWithTimeout('https://audit.invalid', {}, 20, api.readSyncJsonResponse),
    { name: 'AbortError', message: 'REQUEST_TIMEOUT' }
  );
  assert.equal(signal.aborted, true);
  console.log('[PASS] Response headers do not cancel the body-read deadline');

  api.markSyncDirty();
  assert.equal(await api.syncBidirectional(), false);
  assert.equal(api.aiState.isSyncing, false);
  assert.equal(storage.get('kaoyan_sync_dirty'), '1');
  console.log('[PASS] Stalled sync body unlocks syncing and preserves dirty data');
  assert.equal(await api.syncBidirectional({ pushFirst: true }), false);
  assert.equal(api.aiState.isSyncing, false);
  assert.equal(storage.get('kaoyan_sync_dirty'), '1');
  console.log('[PASS] Stalled push response body also unlocks syncing');

  for (const status of [401, 402, 500]) {
    sandbox.fetch = async () => ({ ok: false, status });
    assert.equal(await api.syncBidirectional(), false);
    assert.equal(api.aiState.isSyncing, false);
    assert.equal(storage.get('kaoyan_sync_dirty'), '1');
  }
  sandbox.fetch = async () => { throw new TypeError('offline'); };
  assert.equal(await api.syncBidirectional(), false);
  assert.equal(api.aiState.isSyncing, false);
  assert.equal(storage.get('kaoyan_sync_dirty'), '1');
  console.log('[PASS] 401/402/500/offline preserve dirty data and unlock syncing');

  const parent = new AbortController();
  sandbox.fetch = async () => new Promise(() => {});
  const pending = api.fetchWithTimeout('https://audit.invalid', { signal: parent.signal }, 90);
  parent.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  sandbox.AbortController = undefined;
  await assert.rejects(api.fetchWithTimeout('https://audit.invalid', {}, 20), { name: 'AbortError' });
  console.log('[PASS] Parent cancellation and missing AbortController still settle requests');

  api.stubClozeModel();
  for (const status of [401, 402, 500]) {
    storage.set('kaoyan_sync_dirty', '0');
    let clozePosts = 0;
    sandbox.fetch = async url => {
      assert.ok(String(url).endsWith('/api/ai/cloze'));
      clozePosts++;
      return { ok: false, status };
    };
    await api.generateAiClozeForCurrentItem();
    assert.equal(clozePosts, 1);
    assert.equal(api.aiState.isGeneratingCloze, false);
    assert.equal(storage.get('kaoyan_sync_dirty'), '1');
    assert.ok(JSON.parse(storage.get('kaoyan_ai_cloze_cache_v1'))['audit-cloze']);
  }
  console.log('[PASS] Cloze POST 401/402/500 keeps generated local cache and queues sync (no AI request)');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
