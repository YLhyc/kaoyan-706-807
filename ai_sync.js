/**
 * 2027 考研全科双轨背诵手卷 · DeepSeek AI 伴学抽背与多端云同步引擎 (v3.4.0)
 * 模块化独立挂载于 window.__kaoyanBridge，不侵入主播放与排版主路径
 */
(function () {
  'use strict';

  const STORAGE_KEYS = {
    syncUrl: 'kaoyan_sync_url',
    syncPin: 'kaoyan_sync_pin',
    deepseekKey: 'kaoyan_deepseek_key',
    aiModel: 'kaoyan_ai_model',
    masteryMeta: 'kaoyan_mastery_meta',
    studyLogsMeta: 'kaoyan_study_logs_meta',
    aiMemories: 'kaoyan_ai_memories',
    reciteLogs: 'kaoyan_recite_logs',
    syncDirty: 'kaoyan_sync_dirty',
    syncLastAt: 'kaoyan_sync_last_at',
    blindMask: 'kaoyan_ai_blind_mask'
  };

  const DEFAULT_SYNC_URL = 'https://sync.2026706.xyz';
  const LEGACY_SYNC_URLS = ['https://sync.2026706.xyz:8443', 'https://sync.2026706.xyz:8443/'];
  const DEFAULT_AI_MODEL = 'deepseek-flash';
  const ALLOWED_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
  const LEGACY_MODEL_MAP = {
    'deepseek-chat': 'deepseek-flash',
    'deepseek-reasoner': 'deepseek-v4-pro',
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4.1-flash': 'deepseek-flash',
    'deepseek-v4.1-flash-1017': 'deepseek-flash',
    'deepseek-v4.1 flash-1017': 'deepseek-flash'
  };
  function normalizeAiModel(raw) {
    const val = String(raw || '').trim();
    if (ALLOWED_MODELS.includes(val)) return val;
    if (Object.prototype.hasOwnProperty.call(LEGACY_MODEL_MAP, val)) return LEGACY_MODEL_MAP[val];
    return DEFAULT_AI_MODEL;
  }
  const CARD_SELECTORS = [
    '.logic-block-card',
    '.exam-section-card',
    '.xt-part-box',
    '.stream-card',
    '.xt-day-point-card',
    '.tj-handbook-card',
    '.en-essay-para',
    '.sub-card'
  ].join(', ');

  const aiState = {
    isOpen: false,
    activeTab: 'ask', // 'ask' | 'recite'
    scopedCardEl: null,
    scopedCardLabel: '',
    scopedCardText: '',
    scopedSentences: [],
    quotedText: '',
    chatThreads: new Map(), // scopeKey -> Array<{ role, content, reasoning? }>
    isStreaming: false,
    abortController: null,
    pendingSelection: null, // { text, cardEl }
    selectionTimer: null,
    syncTimer: null,
    isSyncing: false,
    lastVisibleSyncAt: 0,
    reciteSnapshots: [],
    lastReciteEditTs: 0,
    lastReciteLen: 0
  };

  const dom = {};

  function getBridge() {
    return window.__kaoyanBridge || null;
  }

  function showToast(msg, duration = 2200) {
    const b = getBridge();
    if (b && typeof b.showToast === 'function') {
      b.showToast(msg, duration);
    } else {
      console.log('[AI Toast]', msg);
    }
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      console.warn('localStorage write failed:', key, e);
    }
  }

  function migrateLegacySyncUrl() {
    try {
      const stored = (localStorage.getItem(STORAGE_KEYS.syncUrl) || '').trim();
      if (LEGACY_SYNC_URLS.includes(stored)) {
        localStorage.setItem(STORAGE_KEYS.syncUrl, DEFAULT_SYNC_URL);
        return DEFAULT_SYNC_URL;
      }
    } catch (e) {}
    return null;
  }

  function getSyncConfig() {
    migrateLegacySyncUrl();
    let url = (localStorage.getItem(STORAGE_KEYS.syncUrl) || DEFAULT_SYNC_URL).trim();
    url = url.replace(/\/+$/, '');
    if (LEGACY_SYNC_URLS.includes(url)) url = DEFAULT_SYNC_URL;
    const pin = (localStorage.getItem(STORAGE_KEYS.syncPin) || '').trim();
    const deepseekKey = (localStorage.getItem(STORAGE_KEYS.deepseekKey) || '').trim();
    const rawModel = (localStorage.getItem(STORAGE_KEYS.aiModel) || DEFAULT_AI_MODEL).trim();
    const model = normalizeAiModel(rawModel);
    if (rawModel && rawModel !== model) {
      try { localStorage.setItem(STORAGE_KEYS.aiModel, model); } catch (e) {}
    }
    return { url, pin, deepseekKey, model };
  }

  function isSyncConfigured(cfg = getSyncConfig()) {
    return Boolean(cfg.url && cfg.pin);
  }

  function getDeviceLabel() {
    const ua = navigator.userAgent || '';
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Mac/i.test(ua)) return 'Mac';
    if (/Android/i.test(ua)) return 'Android';
    return 'Web';
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeForMatch(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[，。！？；：、“”""''（）()《》【】\[\]·—\-…,.;:!?'"\s]/g, '');
  }

  // ==========================================
  // 1. 数据规范化与多端无损合并 (LWW & Union)
  // ==========================================
  function getMasteryMeta() {
    return readJson(STORAGE_KEYS.masteryMeta, {});
  }

  function setMasteryMeta(meta) {
    writeJson(STORAGE_KEYS.masteryMeta, meta || {});
  }

  function getStudyLogsMeta() {
    return readJson(STORAGE_KEYS.studyLogsMeta, { updatedAt: 0 });
  }

  function setStudyLogsMeta(meta) {
    writeJson(STORAGE_KEYS.studyLogsMeta, meta || { updatedAt: Date.now() });
  }

  function getAiMemories() {
    return readJson(STORAGE_KEYS.aiMemories, {});
  }

  function setAiMemories(map) {
    writeJson(STORAGE_KEYS.aiMemories, map || {});
  }

  function getReciteLogs() {
    const arr = readJson(STORAGE_KEYS.reciteLogs, []);
    return Array.isArray(arr) ? arr : [];
  }

  function setReciteLogs(arr) {
    const cleaned = Array.isArray(arr) ? arr.slice(0, 500) : [];
    writeJson(STORAGE_KEYS.reciteLogs, cleaned);
  }

  function normalizeMemoryEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const summary = String(entry.summary || '').trim();
    const reciteCount = Math.max(0, Number(entry.reciteCount ?? entry.recite_count ?? 0) || 0);
    const rawScore = entry.lastScore ?? entry.last_score ?? null;
    const lastScore = rawScore === null || rawScore === undefined || rawScore === '' ? null : Number(rawScore);
    const updatedAt = Number(entry.updatedAt ?? entry.updated_at ?? 0) || 0;
    return { summary, reciteCount, lastScore: isNaN(lastScore) ? null : lastScore, updatedAt };
  }

  function normalizeReciteLog(log) {
    if (!log || typeof log !== 'object') return null;
    const id = String(log.id || '').trim();
    if (!id) return null;
    const rawScore = log.score ?? null;
    const score = rawScore === null || rawScore === undefined || rawScore === '' ? null : Number(rawScore);
    return {
      id,
      itemId: String(log.itemId ?? log.item_id ?? ''),
      blockId: String(log.blockId ?? log.block_id ?? ''),
      mode: String(log.mode || 'recite'),
      userText: String(log.userText ?? log.user_text ?? ''),
      aiReply: String(log.aiReply ?? log.ai_reply ?? ''),
      cardSummary: String(log.cardSummary ?? log.card_summary ?? ''),
      score: isNaN(score) ? null : score,
      createdAt: Number(log.createdAt ?? log.created_at ?? 0) || Date.now(),
      updatedAt: Number(log.updatedAt ?? log.updated_at ?? 0) || Date.now(),
      device: String(log.device || 'Web')
    };
  }

  function buildLocalMasteryPayload() {
    const b = getBridge();
    const statusMap = b ? b.getMasteryState() : readJson('kaoyan_mastery_state', {});
    const metaMap = getMasteryMeta();
    const out = {};
    Object.entries(statusMap || {}).forEach(([itemId, status]) => {
      if (status === 'unlearned' || status === 'familiar' || status === 'mastered') {
        const meta = metaMap[itemId];
        out[itemId] = {
          status,
          updatedAt: Number(meta && meta.updatedAt) || 0
        };
      }
    });
    return out;
  }

  function buildLocalStudyLogsPayload() {
    const b = getBridge();
    const logs = b ? b.getStudyLogs() : readJson('kaoyan_study_logs', {});
    const meta = getStudyLogsMeta();
    const daily = (logs && logs.dailyListenSec && typeof logs.dailyListenSec === 'object') ? logs.dailyListenSec : {};
    return {
      dates: Array.isArray(logs.dates) ? logs.dates : [],
      completedIds: Array.isArray(logs.completedIds) ? logs.completedIds : [],
      dailyListenSec: daily,
      totalListenSec: Math.max(0, Number(logs.totalListenSec) || 0),
      updatedAt: Number(meta && meta.updatedAt) || 0
    };
  }

  function mergeMasteryWithRemote(remoteMastery) {
    const localPayload = buildLocalMasteryPayload();
    const mergedMeta = {};
    const mergedStatus = {};
    let localHasNewer = false;

    const allIds = new Set([
      ...Object.keys(localPayload),
      ...Object.keys(remoteMastery && typeof remoteMastery === 'object' ? remoteMastery : {})
    ]);

    allIds.forEach((itemId) => {
      const loc = localPayload[itemId];
      const rawRem = remoteMastery ? remoteMastery[itemId] : null;
      let rem = null;
      if (typeof rawRem === 'string') {
        rem = { status: rawRem, updatedAt: 0 };
      } else if (rawRem && typeof rawRem === 'object') {
        rem = {
          status: rawRem.status,
          updatedAt: Number(rawRem.updatedAt ?? rawRem.updated_at ?? 0) || 0
        };
      }

      const locValid = loc && (loc.status === 'unlearned' || loc.status === 'familiar' || loc.status === 'mastered');
      const remValid = rem && (rem.status === 'unlearned' || rem.status === 'familiar' || rem.status === 'mastered');

      if (locValid && remValid) {
        if (loc.updatedAt > rem.updatedAt) {
          mergedStatus[itemId] = loc.status;
          mergedMeta[itemId] = { updatedAt: loc.updatedAt };
          localHasNewer = true;
        } else {
          mergedStatus[itemId] = rem.status;
          mergedMeta[itemId] = { updatedAt: rem.updatedAt };
        }
      } else if (locValid) {
        mergedStatus[itemId] = loc.status;
        mergedMeta[itemId] = { updatedAt: loc.updatedAt };
        localHasNewer = true;
      } else if (remValid) {
        mergedStatus[itemId] = rem.status;
        mergedMeta[itemId] = { updatedAt: rem.updatedAt };
      }
    });

    setMasteryMeta(mergedMeta);
    const b = getBridge();
    if (b && typeof b.applyMergedMastery === 'function') {
      b.applyMergedMastery(mergedStatus);
    } else {
      writeJson('kaoyan_mastery_state', mergedStatus);
    }
    return { localHasNewer };
  }

  function mergeStudyLogsWithRemote(remoteLogs) {
    const loc = buildLocalStudyLogsPayload();
    if (!remoteLogs || typeof remoteLogs !== 'object') return { localHasNewer: false };

    const remDates = Array.isArray(remoteLogs.dates) ? remoteLogs.dates : [];
    const remCompleted = Array.isArray(remoteLogs.completedIds ?? remoteLogs.completed_ids)
      ? (remoteLogs.completedIds ?? remoteLogs.completed_ids)
      : [];
    const remDaily = (remoteLogs.dailyListenSec ?? remoteLogs.daily_listen_sec) || {};
    const remTotal = Math.max(0, Number(remoteLogs.totalListenSec ?? remoteLogs.total_listen_sec ?? 0) || 0);
    const remUpdated = Number(remoteLogs.updatedAt ?? remoteLogs.updated_at ?? 0) || 0;

    const mergedDates = Array.from(new Set([...(loc.dates || []), ...remDates]))
      .filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    const mergedCompleted = Array.from(new Set([...(loc.completedIds || []), ...remCompleted]))
      .filter(id => typeof id === 'string' && id.length > 0);

    const mergedDaily = {};
    const allDays = new Set([...Object.keys(loc.dailyListenSec || {}), ...Object.keys(remDaily || {})]);
    let dailySum = 0;
    allDays.forEach((d) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      const v = Math.max(Number(loc.dailyListenSec[d]) || 0, Number(remDaily[d]) || 0);
      if (v > 0) {
        mergedDaily[d] = v;
        dailySum += v;
      }
    });

    const mergedTotal = Math.max(dailySum, loc.totalListenSec || 0, remTotal);
    const mergedUpdated = Math.max(loc.updatedAt || 0, remUpdated);
    const localHasNewer = (
      mergedDates.length > remDates.length ||
      mergedCompleted.length > remCompleted.length ||
      mergedTotal > remTotal + 0.5 ||
      (loc.updatedAt || 0) > remUpdated
    );

    const b = getBridge();
    const masteryCount = Object.values(b ? b.getMasteryState() : {}).filter(v => v === 'mastered').length;
    const mergedLogs = {
      dates: mergedDates,
      completedIds: mergedCompleted,
      totalCardsCompleted: Math.max(mergedCompleted.length, masteryCount),
      dailyListenSec: mergedDaily,
      totalListenSec: mergedTotal
    };

    setStudyLogsMeta({ updatedAt: mergedUpdated });
    if (b && typeof b.applyMergedStudyLogs === 'function') {
      b.applyMergedStudyLogs(mergedLogs);
    } else {
      writeJson('kaoyan_study_logs', mergedLogs);
    }
    return { localHasNewer };
  }

  function mergeAiMemoriesWithRemote(remoteMemories) {
    const localMap = getAiMemories();
    const remoteMap = (remoteMemories && typeof remoteMemories === 'object') ? remoteMemories : {};
    const merged = {};
    let localHasNewer = false;

    const allIds = new Set([...Object.keys(localMap), ...Object.keys(remoteMap)]);
    allIds.forEach((itemId) => {
      const loc = normalizeMemoryEntry(localMap[itemId]);
      const rem = normalizeMemoryEntry(remoteMap[itemId]);
      if (loc && rem) {
        if (loc.updatedAt > rem.updatedAt) {
          merged[itemId] = loc;
          localHasNewer = true;
        } else {
          merged[itemId] = rem;
        }
      } else if (loc) {
        merged[itemId] = loc;
        localHasNewer = true;
      } else if (rem) {
        merged[itemId] = rem;
      }
    });

    setAiMemories(merged);
    return { localHasNewer };
  }

  function mergeReciteLogsWithRemote(remoteLogs) {
    const localArr = getReciteLogs().map(normalizeReciteLog).filter(Boolean);
    const remoteArr = (Array.isArray(remoteLogs) ? remoteLogs : []).map(normalizeReciteLog).filter(Boolean);
    const byId = new Map();
    const remoteMap = new Map();

    remoteArr.forEach(item => {
      remoteMap.set(item.id, item);
      byId.set(item.id, item);
    });

    let localHasNewer = false;
    localArr.forEach(loc => {
      const rem = byId.get(loc.id);
      if (!rem) {
        byId.set(loc.id, loc);
        localHasNewer = true;
      } else if (loc.updatedAt > rem.updatedAt) {
        byId.set(loc.id, loc);
        localHasNewer = true;
      }
    });

    const merged = Array.from(byId.values())
      .sort((a, b) => (b.createdAt || b.updatedAt) - (a.createdAt || a.updatedAt))
      .slice(0, 500);
    setReciteLogs(merged);
    return { localHasNewer };
  }

  function markSyncDirty() {
    try {
      localStorage.setItem(STORAGE_KEYS.syncDirty, '1');
    } catch (e) {}
  }

  function clearSyncDirty() {
    try {
      localStorage.setItem(STORAGE_KEYS.syncDirty, '0');
      localStorage.setItem(STORAGE_KEYS.syncLastAt, String(Date.now()));
    } catch (e) {}
  }

  function isSyncDirty() {
    return localStorage.getItem(STORAGE_KEYS.syncDirty) === '1';
  }

  function updateSyncStatusUI(text, tone = 'neutral', metaText = '') {
    if (dom.syncStatusBadge) {
      dom.syncStatusBadge.textContent = text;
      dom.syncStatusBadge.className = `settings-sec-desc sync-tone-${tone}`;
    }
    if (dom.syncStatusMeta && metaText) {
      dom.syncStatusMeta.textContent = metaText;
    }
  }

  function refreshSyncStatusFromStorage() {
    const cfg = getSyncConfig();
    if (!isSyncConfigured(cfg)) {
      updateSyncStatusUI('未配置同步口令', 'muted', '填入 Sync PIN 后自动启用 iPhone / iPad / Windows 多端云同步');
      return;
    }
    const lastAt = Number(localStorage.getItem(STORAGE_KEYS.syncLastAt) || 0);
    const dirty = isSyncDirty();
    if (dirty) {
      updateSyncStatusUI('待推送更改', 'warn', lastAt ? `上次同步：${new Date(lastAt).toLocaleString()}` : '本地有待上传改动，联网后自动推送');
    } else if (lastAt) {
      updateSyncStatusUI('已连接云端', 'ok', `最近同步：${new Date(lastAt).toLocaleString()}`);
    } else {
      updateSyncStatusUI('已就绪', 'ok', '已配置同步口令，点击下方按钮可立即双向同步');
    }
  }

  async function syncPullOnly(cfg) {
    const res = await fetch(`${cfg.url}/api/sync/pull`, {
      method: 'GET',
      headers: {
        'X-Sync-Pin': cfg.pin
      }
    });
    if (res.status === 401) throw new Error('SYNC_PIN_INVALID');
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return res.json();
  }

  async function syncPushOnly(cfg) {
    const payload = {
      mastery: buildLocalMasteryPayload(),
      studyLogs: buildLocalStudyLogsPayload(),
      aiMemories: getAiMemories(),
      reciteLogs: getReciteLogs()
    };
    const res = await fetch(`${cfg.url}/api/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Pin': cfg.pin
      },
      body: JSON.stringify(payload)
    });
    if (res.status === 401) throw new Error('SYNC_PIN_INVALID');
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return res.json();
  }

  async function syncBidirectional({ quiet = true, pushFirst = false } = {}) {
    const cfg = getSyncConfig();
    if (!isSyncConfigured(cfg)) {
      refreshSyncStatusFromStorage();
      if (!quiet) showToast('请先填写同步服务地址与 Sync PIN', 2400);
      return false;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      markSyncDirty();
      updateSyncStatusUI('离线队列待同步', 'warn', '当前处于离线状态，本地记录已安全暂存，恢复网络后自动上传');
      if (!quiet) showToast('当前离线，已进入待同步队列', 2200);
      return false;
    }
    if (aiState.isSyncing) return false;

    aiState.isSyncing = true;
    updateSyncStatusUI('正在同步...', 'busy');
    try {
      let needPush = pushFirst || isSyncDirty();

      if (!pushFirst) {
        const pullData = await syncPullOnly(cfg);
        const r1 = mergeMasteryWithRemote(pullData.mastery);
        const r2 = mergeStudyLogsWithRemote(pullData.studyLogs);
        const r3 = mergeAiMemoriesWithRemote(pullData.aiMemories);
        const r4 = mergeReciteLogsWithRemote(pullData.reciteLogs);
        if (r1.localHasNewer || r2.localHasNewer || r3.localHasNewer || r4.localHasNewer) {
          needPush = true;
        }
      }

      if (needPush) {
        const pushRes = await syncPushOnly(cfg);
        const merged = pushRes && pushRes.merged ? pushRes.merged : null;
        if (merged) {
          mergeMasteryWithRemote(merged.mastery);
          mergeStudyLogsWithRemote(merged.studyLogs);
          mergeAiMemoriesWithRemote(merged.aiMemories);
          mergeReciteLogsWithRemote(merged.reciteLogs);
        }
      }

      clearSyncDirty();
      refreshMemoryBoxUI();
      if (aiState.isOpen && aiState.activeTab === 'recite') {
        renderReciteHistoryIfIdle();
      }
      refreshSyncStatusFromStorage();
      if (!quiet) showToast('云端双向同步完成，全端进度已对齐！', 2200);
      return true;
    } catch (err) {
      console.warn('Cloud sync failed:', err);
      if (err && err.message === 'SYNC_PIN_INVALID') {
        updateSyncStatusUI('口令校验失败 (401)', 'error', 'Sync PIN 不正确，请核对后重试');
        if (!quiet) showToast('Sync PIN 校验失败 (401)，请检查口令', 2600);
      } else {
        updateSyncStatusUI('同步暂不可达', 'warn', '保留本地待同步队列，稍后自动重试');
        if (!quiet) showToast('同步请求失败，本地修改已保存在待同步队列中', 2600);
      }
      return false;
    } finally {
      aiState.isSyncing = false;
    }
  }

  function scheduleDebouncedPush() {
    markSyncDirty();
    refreshSyncStatusFromStorage();
    if (!isSyncConfigured()) return;
    if (aiState.syncTimer) clearTimeout(aiState.syncTimer);
    aiState.syncTimer = setTimeout(() => {
      aiState.syncTimer = null;
      syncBidirectional({ quiet: true, pushFirst: true });
    }, 2000);
  }

  async function testCloudConnection() {
    const cfg = getSyncConfig();
    if (!cfg.url) {
      showToast('请先输入同步服务地址', 2000);
      return;
    }
    updateSyncStatusUI('正在测试连接...', 'busy');
    try {
      const headers = {};
      if (cfg.pin) headers['X-Sync-Pin'] = cfg.pin;
      const res = await fetch(`${cfg.url}/api/health`, { method: 'GET', headers });
      if (!res.ok) throw new Error(`HTTP_${res.status}`);
      const data = await res.json();
      const pinNote = cfg.pin ? (data.pinValid ? 'PIN 校验通过' : 'PIN 未通过校验') : '未填写 PIN';
      const dsNote = data.deepseekConfigured ? '服务端 DeepSeek Key 已就绪' : '服务端未配 DeepSeek Key (可用个人 Key)';
      const summary = `连通成功 (v${data.version || '1.0'}) · ${pinNote} · ${dsNote}`;
      updateSyncStatusUI(data.pinValid === false ? 'PIN 错误' : '服务在线', data.pinValid === false ? 'error' : 'ok', summary);
      showToast(summary, 3000);
    } catch (err) {
      console.warn('Health check failed:', err);
      updateSyncStatusUI('连接失败', 'error', '无法连接至同步服务，请检查网络、域名解析或服务状态');
      showToast('连接同步服务失败，请检查地址与网络', 2600);
    }
  }

  // ==========================================
  // 2. 卡片文本提取与原句匹配引擎
  // ==========================================
  function extractCleanTextFromElement(rootEl) {
    if (!rootEl) return '';
    const clone = rootEl.cloneNode(true);
    clone.querySelectorAll('.card-ai-btn, .seal-btn, .en-audio-jump-pill, .tj-point-jump-pill, .xt-point-jump-hint, .live-repeat-badge, svg').forEach(n => n.remove());
    return (clone.innerText || clone.textContent || '')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function extractCardLabel(cardEl) {
    if (!cardEl) return '整篇考点';
    const headerSelectors = [
      '.section-card-header .sec-title',
      '.section-card-header .sec-badge',
      '.logic-block-title h3',
      '.logic-block-title',
      '.xt-part-badge',
      '.stream-card-label',
      '.xt-point-num-tag',
      '.tj-card-title',
      '.tj-card-tag',
      '.sub-card-title'
    ];
    for (const sel of headerSelectors) {
      const node = cardEl.querySelector(sel);
      if (node) {
        const clone = node.cloneNode(true);
        clone.querySelectorAll('.card-ai-btn, svg').forEach(n => n.remove());
        const txt = (clone.textContent || '').trim();
        if (txt) return txt.slice(0, 36);
      }
    }
    const raw = extractCleanTextFromElement(cardEl);
    return raw ? raw.slice(0, 28) + (raw.length > 28 ? '...' : '') : '当前卡片';
  }

  function collectScopedSentences(cardEl) {
    const b = getBridge();
    const allSents = (b && b.getActiveSentences()) || [];
    if (!cardEl) {
      return allSents.map((s, i) => ({
        idx: typeof s.idx === 'number' ? s.idx : i,
        start: s.start,
        text: s.text || ''
      }));
    }

    const foundMap = new Map();
    if (cardEl.matches && cardEl.matches('.xt-day-point-card[data-point-idx]')) {
      const pIdx = parseInt(cardEl.dataset.pointIdx, 10);
      if (!isNaN(pIdx) && allSents[pIdx]) {
        foundMap.set(pIdx, {
          idx: pIdx,
          start: allSents[pIdx].start,
          text: extractCleanTextFromElement(cardEl) || allSents[pIdx].text || ''
        });
      }
    }

    const nodes = cardEl.querySelectorAll('[data-sent-idx], [data-linked-sent-idx]');
    nodes.forEach((node) => {
      const rawIdx = node.dataset.sentIdx !== undefined ? node.dataset.sentIdx : node.dataset.linkedSentIdx;
      const idx = parseInt(rawIdx, 10);
      if (!isNaN(idx) && idx >= 0 && allSents[idx]) {
        const s = allSents[idx];
        foundMap.set(idx, {
          idx,
          start: s.start,
          text: s.text || (node.textContent || '').trim()
        });
      }
    });

    if (foundMap.size > 0) {
      return Array.from(foundMap.values()).sort((a, b2) => a.idx - b2.idx);
    }

    return allSents.map((s, i) => ({
      idx: typeof s.idx === 'number' ? s.idx : i,
      start: s.start,
      text: s.text || ''
    }));
  }

  function getScopeContext() {
    const b = getBridge();
    const st = b ? b.getState() : {};
    const item = st.activeItem || {};
    const itemId = st.activeItemId || item.id || 'unknown';
    const subjectLabel = st.currentSubject === '807'
      ? '807 现当代文学'
      : st.currentSubject === '706'
        ? '706 古代文学'
        : st.currentSubject === 'en'
          ? '考研英语写作'
          : '考研政治';

    let refText = aiState.scopedCardText;
    let sentences = aiState.scopedSentences;
    if (!aiState.scopedCardEl) {
      const paperEl = document.getElementById('paper-content');
      refText = extractCleanTextFromElement(paperEl);
      sentences = collectScopedSentences(null);
    }
    const blockId = aiState.scopedCardEl ? aiState.scopedCardLabel : 'FULL_ITEM';
    const scopeKey = `${itemId}::${blockId}`;

    return {
      itemId,
      itemTitle: item.title || '当前考点',
      subject: st.currentSubject || '807',
      subjectLabel,
      track: st.currentTrack || 1,
      blockId,
      scopeKey,
      refText: (refText || '').slice(0, 6000),
      sentences: (sentences || []).slice(0, 120)
    };
  }

  // ==========================================
  // 3. 卡片「AI 伴学 / 抽背」按钮注入 & 划词浮窗
  // ==========================================
  function findCardHeaderHost(cardEl) {
    if (!cardEl) return null;
    if (cardEl.classList.contains('en-essay-para')) return cardEl;
    const selectors = [
      ':scope > .section-card-header',
      ':scope > .logic-block-title',
      ':scope > .xt-part-badge-row',
      ':scope > .stream-card-label',
      ':scope > .xt-day-point-header',
      ':scope > .tj-card-header',
      ':scope > .sub-card-audio-ctrl .sub-card-title-row',
      ':scope > .sub-card-title-row'
    ];
    for (const sel of selectors) {
      const host = cardEl.querySelector(sel);
      if (host) return host;
    }
    return cardEl;
  }

  function injectCardAiButtons() {
    const paperEl = document.getElementById('paper-content');
    if (!paperEl) return;

    const cards = paperEl.querySelectorAll(CARD_SELECTORS);
    cards.forEach((card) => {
      if (card.classList.contains('stream-card-tips')) return;
      if (card.querySelector(':scope > .card-ai-btn, :scope > .section-card-header .card-ai-btn, :scope > .logic-block-title .card-ai-btn, :scope > .xt-part-badge-row .card-ai-btn, :scope > .stream-card-label .card-ai-btn, :scope > .xt-day-point-header .card-ai-btn, :scope > .tj-card-header .card-ai-btn, .sub-card-title-row .card-ai-btn')) {
        return;
      }
      const cleanTxt = extractCleanTextFromElement(card);
      if (!cleanTxt || cleanTxt.length < 8) return;

      const host = findCardHeaderHost(card);
      if (!host) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = card.classList.contains('en-essay-para') ? 'card-ai-btn card-ai-btn-inline' : 'card-ai-btn';
      btn.title = '针对本卡片内容向 DeepSeek 提问';
      btn.innerHTML = `
        <svg class="ai-ds-icon" fill="currentColor" fill-rule="evenodd" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"></path>
        </svg>
        <span>AI 伴学</span>
      `;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        openAiDrawer({
          cardEl: card,
          tab: aiState.activeTab || 'ask'
        });
      });

      host.appendChild(btn);
    });
  }

  function hideSelectionPill() {
    if (dom.selectionPill) {
      dom.selectionPill.style.display = 'none';
    }
    aiState.pendingSelection = null;
  }

  function evaluateSelectionPill() {
    const paperEl = document.getElementById('paper-content');
    if (!paperEl || aiState.isOpen) {
      hideSelectionPill();
      return;
    }
    const sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      hideSelectionPill();
      return;
    }
    const rawText = String(sel).trim();
    const compactLen = rawText.replace(/\s+/g, '').length;
    if (compactLen < 2 || rawText.length > 1500) {
      hideSelectionPill();
      return;
    }
    const range = sel.getRangeAt(0);
    const common = range.commonAncestorContainer;
    const anchorEl = common.nodeType === 1 ? common : common.parentElement;
    if (!anchorEl || !paperEl.contains(anchorEl) || anchorEl.closest('.card-ai-btn')) {
      hideSelectionPill();
      return;
    }

    const cardEl = anchorEl.closest(CARD_SELECTORS);
    aiState.pendingSelection = {
      text: rawText,
      cardEl: (cardEl && !cardEl.classList.contains('stream-card-tips')) ? cardEl : null
    };

    if (dom.selectionPill && dom.selectionPillText) {
      dom.selectionPillText.textContent = `问 DeepSeek（已选 ${compactLen} 字）`;
      dom.selectionPill.style.display = 'flex';
    }
  }

  function scheduleSelectionEval(delayMs = 180) {
    if (aiState.selectionTimer) clearTimeout(aiState.selectionTimer);
    aiState.selectionTimer = setTimeout(() => {
      aiState.selectionTimer = null;
      evaluateSelectionPill();
    }, delayMs);
  }

  // ==========================================
  // 4. 抽屉控制与盲背遮罩
  // ==========================================
  function applyBlindMask(enabled) {
    const paperEl = document.getElementById('paper-content');
    if (!paperEl) return;
    if (enabled && aiState.isOpen && aiState.activeTab === 'recite') {
      paperEl.classList.add('ai-blind-mask');
    } else {
      paperEl.classList.remove('ai-blind-mask');
    }
  }

  function refreshMemoryBoxUI() {
    const ctx = getScopeContext();
    const memories = getAiMemories();
    const mem = normalizeMemoryEntry(memories[ctx.itemId]);
    if (dom.memorySummaryInput) {
      dom.memorySummaryInput.value = mem ? mem.summary : '';
    }
    if (dom.memoryStats) {
      if (mem && (mem.reciteCount > 0 || mem.lastScore !== null)) {
        const scorePart = mem.lastScore !== null ? `${mem.lastScore}分` : '已记录';
        dom.memoryStats.textContent = `${mem.reciteCount}次 · ${scorePart}`;
      } else if (mem && mem.summary) {
        dom.memoryStats.textContent = '已记录';
      } else {
        dom.memoryStats.textContent = '暂无笔记';
      }
    }
    if (dom.memoryToggleBtn) {
      dom.memoryToggleBtn.classList.toggle('has-memory', Boolean(mem && (mem.summary || mem.reciteCount > 0)));
    }
  }

  function setReciteViewMode() {}

  function updateScopeHeaderUI() {
    const ctx = getScopeContext();
    const cfg = getSyncConfig();
    if (dom.drawerModelBadge) {
      dom.drawerModelBadge.textContent = cfg.model;
    }
    if (dom.scopeBadge) {
      dom.scopeBadge.textContent = aiState.scopedCardEl
        ? `当前卡片：${ctx.blockId}`
        : `全篇范围：${ctx.itemTitle}`;
    }
    if (dom.clearScopeBtn) {
      dom.clearScopeBtn.style.display = aiState.scopedCardEl ? 'inline-flex' : 'none';
    }
    if (dom.quoteBox && dom.quoteText) {
      if (aiState.quotedText) {
        dom.quoteText.textContent = aiState.quotedText;
        dom.quoteBox.style.display = 'block';
      } else {
        dom.quoteBox.style.display = 'none';
      }
    }
    refreshMemoryBoxUI();
  }

  function switchAiTab() {
    aiState.activeTab = 'ask';
    if (dom.panelAsk) dom.panelAsk.style.display = 'flex';
    applyBlindMask(false);
    renderChatStream();
  }

  function openAiDrawer({ cardEl = null, quote = '', tab = null } = {}) {
    if (!dom.drawer || !dom.backdrop) return;
    hideSelectionPill();

    if (cardEl) {
      aiState.scopedCardEl = cardEl;
      aiState.scopedCardLabel = extractCardLabel(cardEl);
      aiState.scopedCardText = extractCleanTextFromElement(cardEl);
      aiState.scopedSentences = collectScopedSentences(cardEl);
    } else if (aiState.scopedCardEl && !document.body.contains(aiState.scopedCardEl)) {
      aiState.scopedCardEl = null;
      aiState.scopedCardLabel = '';
      aiState.scopedCardText = '';
      aiState.scopedSentences = [];
    }

    if (quote) {
      aiState.quotedText = quote;
    }

    aiState.isOpen = true;
    dom.backdrop.style.display = 'block';
    requestAnimationFrame(() => {
      dom.backdrop.classList.add('open');
      dom.drawer.classList.add('open');
      dom.drawer.setAttribute('aria-hidden', 'false');
    });

    const b = getBridge();
    if (b && typeof b.lockBodyScroll === 'function') {
      b.lockBodyScroll('aiAssistantDrawer');
    }

    updateScopeHeaderUI();
    switchAiTab(tab || aiState.activeTab || 'ask');
  }

  function closeAiDrawer() {
    if (!dom.drawer || !dom.backdrop) return;
    aiState.isOpen = false;
    dom.drawer.classList.remove('open');
    dom.drawer.setAttribute('aria-hidden', 'true');
    dom.backdrop.classList.remove('open');
    applyBlindMask(false);

    setTimeout(() => {
      if (!aiState.isOpen && dom.backdrop) {
        dom.backdrop.style.display = 'none';
      }
    }, 280);

    const b = getBridge();
    if (b && typeof b.unlockBodyScroll === 'function') {
      b.unlockBodyScroll('aiAssistantDrawer');
    }
  }

  // ==========================================
  // 5. Markdown-Lite + 「▶ 点听漏背原句」渲染器
  // ==========================================
  function findSentenceIndexByQuote(quoteText, sentences) {
    const normQ = normalizeForMatch(quoteText);
    if (normQ.length < 5 || !Array.isArray(sentences) || sentences.length === 0) return -1;

    let bestIdx = -1;
    let bestScore = 0;
    sentences.forEach((s) => {
      const normS = normalizeForMatch(s.text);
      if (!normS) return;
      if (normS.includes(normQ) || normQ.includes(normS)) {
        const lenScore = Math.min(normS.length, normQ.length) / Math.max(normS.length, normQ.length, 1) + 1;
        if (lenScore > bestScore) {
          bestScore = lenScore;
          bestIdx = s.idx;
        }
      }
    });
    return bestIdx;
  }

  function renderAiMarkdown(rawMarkdown) {
    // 1. 剥离 [CARD_SUMMARY]...[/CARD_SUMMARY] 并在底部渲染为归档卡片
    let summaryText = '';
    const cleaned = String(rawMarkdown || '')
      .replace(/\[CARD_SUMMARY\]([\s\S]*?)(?:\[\/CARD_SUMMARY\]|$)/g, (_, inner) => {
        summaryText = (inner || '').trim();
        return '';
      })
      .replace(/\s*\[SENT:\d+\]/g, '')
      .trim();

    const formatInline = (line) => {
      let html = escapeHtml(line);
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      return html;
    };

    const parseTableRow = (rowLine) => {
      return rowLine.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    };
    const isTableSep = (rowLine) => {
      const cells = parseTableRow(rowLine);
      return cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c));
    };

    const lines = cleaned.split(/\r?\n/);
    const out = [];
    let inList = false;

    const closeList = () => {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimEnd();
      if (!line.trim()) {
        closeList();
        continue;
      }

      // Markdown 表格支持：| 列1 | 列2 |
      if (line.trim().startsWith('|') && i + 1 < lines.length && lines[i + 1].trim().startsWith('|') && isTableSep(lines[i + 1])) {
        closeList();
        const headers = parseTableRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          rows.push(parseTableRow(lines[i]));
          i++;
        }
        i--;
        out.push('<div class="ai-md-table-wrap"><table class="ai-md-table"><thead><tr>' +
          headers.map(h => `<th>${formatInline(h)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map(r => '<tr>' + headers.map((_, idx) => `<td>${formatInline(r[idx] || '')}</td>`).join('') + '</tr>').join('') +
          '</tbody></table></div>');
        continue;
      }

      // 引用块支持：> 原文摘录
      const bqMatch = line.match(/^\s*>\s?(.*)$/);
      if (bqMatch) {
        closeList();
        const quoteLines = [formatInline(bqMatch[1])];
        while (i + 1 < lines.length && /^\s*>\s?/.test(lines[i + 1])) {
          i++;
          quoteLines.push(formatInline(lines[i].replace(/^\s*>\s?/, '')));
        }
        out.push(`<blockquote class="ai-md-quote">${quoteLines.join('<br>')}</blockquote>`);
        continue;
      }

      const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
      if (hMatch) {
        closeList();
        const level = Math.min(4, Math.max(2, hMatch[1].length));
        out.push(`<h${level + 1} class="ai-md-h">${formatInline(hMatch[2])}</h${level + 1}>`);
        continue;
      }

      const liMatch = line.match(/^\s*(?:[-*•]|\d+[.)、])\s+(.+)$/);
      if (liMatch) {
        if (!inList) {
          out.push('<ul class="ai-md-list">');
          inList = true;
        }
        out.push(`<li>${formatInline(liMatch[1])}</li>`);
        continue;
      }

      closeList();
      out.push(`<p class="ai-md-p">${formatInline(line)}</p>`);
    }
    closeList();

    if (summaryText) {
      out.push(`
        <div class="ai-summary-archived-card">
          <div class="ai-summary-archived-tag">已自动归档本题卡点记忆</div>
          <div class="ai-summary-archived-text">${escapeHtml(summaryText)}</div>
        </div>
      `);
    }

    return out.join('');
  }

  function bindSentJumpButtons(containerEl) {
    if (!containerEl) return;
    containerEl.querySelectorAll('.ai-sent-jump-btn').forEach((btn) => {
      if (btn.dataset.jumpBound === '1') return;
      btn.dataset.jumpBound = '1';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.sentIdx, 10);
        const b = getBridge();
        if (!b) return;
        const sents = b.getActiveSentences() || [];
        const sent = sents[idx];
        // 临时揭开盲背遮罩以便核对原句
        applyBlindMask(false);
        if (dom.blindMaskToggle && dom.blindMaskToggle.checked) {
          dom.blindMaskToggle.checked = false;
          localStorage.setItem(STORAGE_KEYS.blindMask, '0');
        }
        if (sent && typeof sent.start === 'number') {
          b.seekToSentence(idx, sent.start);
          showToast(`正在点听原句 #${idx + 1}`, 1600);
        } else if (!isNaN(idx)) {
          b.seekToSentence(idx, 0);
        }
      });
    });
  }

  // ==========================================
  // 6. DeepSeek 流式请求封装 (VPS 代理 / BYOK 兜底)
  // ==========================================
  async function streamDeepSeek({ messages, temperature = 0.4, maxTokens = 2048, onDelta }) {
    const cfg = getSyncConfig();
    if (aiState.abortController) {
      try { aiState.abortController.abort(); } catch (e) {}
    }
    const controller = new AbortController();
    aiState.abortController = controller;
    aiState.isStreaming = true;

    let endpoint = '';
    const headers = { 'Content-Type': 'application/json' };

    if (isSyncConfigured(cfg)) {
      endpoint = `${cfg.url}/api/ai/chat`;
      headers['X-Sync-Pin'] = cfg.pin;
      if (cfg.deepseekKey) headers['X-Deepseek-Key'] = cfg.deepseekKey;
    } else if (cfg.deepseekKey) {
      endpoint = 'https://api.deepseek.com/chat/completions';
      headers['Authorization'] = `Bearer ${cfg.deepseekKey}`;
    } else {
      aiState.isStreaming = false;
      throw new Error('NO_AUTH_CONFIGURED');
    }

    const body = {
      model: cfg.model,
      messages,
      stream: true,
      max_tokens: maxTokens
    };
    if (cfg.model !== 'deepseek-reasoner') {
      body.temperature = temperature;
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const contentType = res.headers.get('content-type') || '';
      if (!res.ok) {
        let errMsg = `请求失败 (${res.status})`;
        try {
          const errJson = await res.json();
          if (errJson && errJson.message) errMsg = errJson.message;
          else if (errJson && errJson.error && typeof errJson.error === 'string') errMsg = errJson.error;
          else if (errJson && errJson.error && errJson.error.message) errMsg = errJson.error.message;
        } catch (e) {}
        if (res.status === 401) errMsg = 'Sync PIN 或 API Key 无效 (401)，请在设置中核对';
        throw new Error(errMsg);
      }

      // 非流式 JSON 兼容
      if (contentType.includes('application/json')) {
        const data = await res.json();
        if (data && data.ok === false) {
          throw new Error(data.message || data.error || '服务端返回异常');
        }
        const msgObj = data && data.choices && data.choices[0] && data.choices[0].message;
        const fullContent = (msgObj && msgObj.content) || '';
        const fullReasoning = (msgObj && msgObj.reasoning_content) || '';
        onDelta({ content: fullContent, reasoning: fullReasoning, done: true });
        return { content: fullContent, reasoning: fullReasoning };
      }

      if (!res.body || !res.body.getReader) {
        throw new Error('当前浏览器不支持流式读取响应');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let fullContent = '';
      let fullReasoning = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || !line.startsWith('data:')) continue;
          const payloadStr = line.slice(5).trim();
          if (payloadStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payloadStr);
            const delta = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
            if (delta) {
              if (delta.reasoning_content) fullReasoning += delta.reasoning_content;
              if (delta.content) fullContent += delta.content;
              onDelta({ content: fullContent, reasoning: fullReasoning, done: false });
            }
          } catch (e) {
            // 忽略半包行或心跳注释
          }
        }
      }

      onDelta({ content: fullContent, reasoning: fullReasoning, done: true });
      return { content: fullContent, reasoning: fullReasoning };
    } finally {
      if (aiState.abortController === controller) {
        aiState.abortController = null;
      }
      aiState.isStreaming = false;
    }
  }

  // ==========================================
  // 7. Tab 1: AI 伴学答疑
  // ==========================================
  function buildSentenceIndexPromptBlock(sentences) {
    if (!sentences || sentences.length === 0) return '（本卡片暂无逐句时间戳索引）';
    return sentences
      .slice(0, 80)
      .map(s => `[SENT:${s.idx}] ${(s.text || '').replace(/\s+/g, ' ').trim()}`)
      .join('\n');
  }

  function buildAskSystemPrompt(ctx) {
    const memories = getAiMemories();
    const mem = normalizeMemoryEntry(memories[ctx.itemId]);
    const memoryBlock = mem && mem.summary
      ? `\n【历史薄弱卡点记忆（已抽背 ${mem.reciteCount} 次${mem.lastScore !== null ? `，最近得分 ${mem.lastScore} 分` : ''}）】：\n${mem.summary}\n`
      : '';

    return `你是「2027 考研全科双轨背诵手卷」的专属高分研学助教，精通文学考研（807 现当代文学、706 中国古代文学）、考研政治与考研英语写作。
当前学习上下文：
- 科目：${ctx.subjectLabel}
- 考题：${ctx.itemTitle}（轨道 ${ctx.track}）
- 聚焦范围：${ctx.blockId}
${memoryBlock}
【参考原文】：
${ctx.refText}

回答规范：
1. 紧扣上述参考原文与考研答题采分点作答，语言凝练有条理，避免空泛套话。
2. 遇到多流派、多作家或多概念区分时，优先使用清晰的 Markdown 对比表格呈现；引用核心原句时请使用 \`>\` 引用块或双引号纯文本，不要输出任何音频编号、时间戳或 [SENT] 标记。
3. 适当给出答题骨架、采分关键词或 50 字以内记忆口诀，帮助考场高效成诵。`;
  }

  function renderChatStream() {
    if (!dom.chatStream) return;
    const ctx = getScopeContext();
    const msgs = aiState.chatThreads.get(ctx.scopeKey) || [];

    if (msgs.length === 0) {
      dom.chatStream.innerHTML = `
        <div class="ai-empty-hint">
          已锁定「${escapeHtml(ctx.blockId)}」。你可以直接在下方提问，或点击建议标签生成<strong>答题骨架 / 横向对比表 / 速记口诀</strong>（全纯文字学术排版，无音频跳转干扰）。
        </div>
      `;
      return;
    }

    dom.chatStream.innerHTML = msgs.map((m, idx) => {
      if (m.role === 'user') {
        return `<div class="ai-msg ai-msg-user"><div class="ai-msg-bubble">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div></div>`;
      }
      const reasoningHtml = m.reasoning
        ? `<details class="ai-reasoning-block"><summary>DeepSeek 深度推理过程</summary><div class="ai-reasoning-body">${escapeHtml(m.reasoning).replace(/\n/g, '<br>')}</div></details>`
        : '';
      const bodyHtml = m.content
        ? renderAiMarkdown(m.content, ctx.sentences)
        : '<span class="ai-typing-dots">正在思考并检索原文...</span>';
      const isLastStreaming = aiState.isStreaming && idx === msgs.length - 1;
      const actionsHtml = (m.content && !isLastStreaming)
        ? `<div class="ai-msg-actions">
            <button type="button" class="ai-msg-action-btn js-ai-copy-btn" data-msg-idx="${idx}">复制解析</button>
            <button type="button" class="ai-msg-action-btn js-ai-save-mem-btn" data-msg-idx="${idx}">存入卡点记忆</button>
          </div>`
        : '';
      return `<div class="ai-msg ai-msg-assistant"><div class="ai-msg-bubble">${reasoningHtml}${bodyHtml}${actionsHtml}</div></div>`;
    }).join('');

    dom.chatStream.scrollTop = dom.chatStream.scrollHeight;
  }

  async function sendAskMessage(presetPrompt = null) {
    if (aiState.isStreaming) {
      showToast('DeepSeek 正在回复中，请稍候', 1600);
      return;
    }
    const rawInput = presetPrompt !== null ? presetPrompt : (dom.askInput ? dom.askInput.value.trim() : '');
    if (!rawInput) {
      showToast('请输入你的问题', 1600);
      return;
    }

    const ctx = getScopeContext();
    const thread = aiState.chatThreads.get(ctx.scopeKey) || [];
    const userDisplay = aiState.quotedText
      ? `【引用原文】“${aiState.quotedText}”\n\n${rawInput}`
      : rawInput;

    if (presetPrompt === null && dom.askInput) {
      dom.askInput.value = '';
    }
    aiState.quotedText = '';
    updateScopeHeaderUI();

    thread.push({ role: 'user', content: userDisplay });
    const assistantMsg = { role: 'assistant', content: '', reasoning: '' };
    thread.push(assistantMsg);
    aiState.chatThreads.set(ctx.scopeKey, thread);
    renderChatStream();

    const apiMessages = [
      { role: 'system', content: buildAskSystemPrompt(ctx) },
      ...thread.slice(0, -1).slice(-10).map(m => ({ role: m.role, content: m.content }))
    ];

    if (dom.askSendBtn) dom.askSendBtn.disabled = true;
    try {
      await streamDeepSeek({
        messages: apiMessages,
        temperature: 0.45,
        maxTokens: 2048,
        onDelta: ({ content, reasoning }) => {
          assistantMsg.content = content;
          assistantMsg.reasoning = reasoning;
          renderChatStream();
        }
      });
      renderChatStream();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (err && err.message === 'NO_AUTH_CONFIGURED') {
        assistantMsg.content = '尚未配置云端同步口令或 DeepSeek API Key。请点击右上角齿轮图标进入「设置 → AI 伴学与云端同步」填写 `Sync PIN`（或个人 Key）。';
      } else {
        assistantMsg.content = `请求出错：${err && err.message ? err.message : '未知网络错误'}`;
      }
      renderChatStream();
    } finally {
      if (dom.askSendBtn) dom.askSendBtn.disabled = false;
    }
  }

  // ==========================================
  // 8. Tab 2: 微信语音抽背批改
  // ==========================================
  function updateReciteCharCount() {
    if (!dom.reciteTextarea || !dom.reciteCharCount) return;
    const val = dom.reciteTextarea.value || '';
    const nonWs = val.replace(/\s+/g, '').length;
    dom.reciteCharCount.textContent = `已输入 ${nonWs} 字`;
  }

  function pushReciteSnapshot(textVal) {
    const stack = aiState.reciteSnapshots;
    if (stack.length > 0 && stack[stack.length - 1] === textVal) return;
    stack.push(textVal);
    if (stack.length > 25) stack.shift();
  }

  function handleReciteInputBurst() {
    if (!dom.reciteTextarea) return;
    const now = Date.now();
    const cur = dom.reciteTextarea.value || '';
    const prevLen = aiState.lastReciteLen || 0;
    // 检测微信语音连续插入：停顿超过 1.2s 且一次性增加 >= 4 字时记录前一状态，便于「撤销上一段」
    if (cur.length - prevLen >= 4 && now - aiState.lastReciteEditTs > 1200) {
      pushReciteSnapshot(cur.slice(0, prevLen));
    }
    aiState.lastReciteEditTs = now;
    aiState.lastReciteLen = cur.length;
    updateReciteCharCount();
  }

  function buildGradingSystemPrompt(ctx) {
    const memories = getAiMemories();
    const mem = normalizeMemoryEntry(memories[ctx.itemId]);
    const memoryBlock = mem && mem.summary
      ? `\n【既往卡点记忆档案（本次需重点检验是否克服）】：\n${mem.summary}\n`
      : '';

    return `你是考研专业课（807/706/政治/英语）严格而友善的「微信语音抽背阅卷官」。
考生使用「微信输入法 60 秒语音转文字」进行盲背口述。

【核心语音听写容错规则】：
1. 必须宽容语音识别常见的**同音/近音错别字**与**完全缺失标点**（例如：“诗史”听成“实施/时事”、“繁漪”听成“樊篱/凡依”、“形神兼备”听成“行神兼备”、“唯物辩证法”听成“威武变证法”、“创作”听成“创做”等），只要读音相近且符合语境，一律视为**同义/语音命中过关**，绝不因错别字扣分！
2. 英文单词若有轻度语音连读误识或大小写差异，只要能辨认出对应词根/句式，也宽容判定并通过括号提示拼写即可。
3. 重点核查：**核心论点、采分术语、作家作品/理论要点、逻辑层次**是否漏背或混淆。
${memoryBlock}
【当前考核范围】：${ctx.subjectLabel} · ${ctx.itemTitle} · ${ctx.blockId}
【对照标准原文】：
${ctx.refText}

请严格按以下 4 个结构化模块输出纯文字批改报告（不要输出 [SENT] 标记或任何音频引用）：
### 1. 整体掌握度评分与简评
首行明确给出：\`掌握度评分：XX分\`（0-100 整数），随后 2 句精准点明背诵完整度与主要失分方向。

### 2. ✅ 命中与同义过关要点
分条列出考生已准确背出（含语音同音/同义替换过关）的采分点。

### 3. ❌ 漏背 / 混淆卡点
逐条指出遗漏或张冠李戴的关键点，并用 \`>\` 引用块给出精确标准原文对照以便记忆。

### 4. 逻辑拆解速记法
针对本次漏背卡点，提炼 2-3 条极简逻辑链条或关键词口诀。

[CARD_SUMMARY]用 1~2 句话极简浓缩本次暴露的漏背卡点与易混处（不超过 120 字），供长期记忆档案合并存档。[/CARD_SUMMARY]`;
  }

  function extractGradingMeta(replyText) {
    let cardSummary = '';
    const sumMatch = replyText.match(/\[CARD_SUMMARY\]([\s\S]*?)(?:\[\/CARD_SUMMARY\]|$)/i);
    if (sumMatch && sumMatch[1]) {
      cardSummary = sumMatch[1].trim().slice(0, 320);
    }

    let score = null;
    const scoreMatch = replyText.match(/(?:掌握度评分|整体评分|综合得分|评分|得分)[：:\s\*`]*(\d{1,3})\s*(?:分|\/\s*100)?/i);
    if (scoreMatch) {
      const n = parseInt(scoreMatch[1], 10);
      if (!isNaN(n) && n >= 0 && n <= 100) score = n;
    }
    return { cardSummary, score };
  }

  function saveMemorySummary(itemId, { summary, score = null, incrementRecite = false }) {
    if (!itemId) return;
    const memories = getAiMemories();
    const existing = normalizeMemoryEntry(memories[itemId]) || {
      summary: '',
      reciteCount: 0,
      lastScore: null,
      updatedAt: 0
    };
    const nextCount = incrementRecite ? existing.reciteCount + 1 : existing.reciteCount;
    const nextScore = score !== null ? score : existing.lastScore;
    memories[itemId] = {
      summary: String(summary || existing.summary || '').trim().slice(0, 500),
      reciteCount: nextCount,
      lastScore: nextScore,
      updatedAt: Date.now()
    };
    setAiMemories(memories);
    refreshMemoryBoxUI();
    scheduleDebouncedPush();
  }

  function appendReciteLog({ itemId, blockId, userText, aiReply, cardSummary, score }) {
    const now = Date.now();
    const logs = getReciteLogs();
    logs.unshift({
      id: `rl_${now}_${Math.random().toString(36).slice(2, 8)}`,
      itemId,
      blockId,
      mode: 'recite',
      userText,
      aiReply,
      cardSummary,
      score,
      createdAt: now,
      updatedAt: now,
      device: getDeviceLabel()
    });
    setReciteLogs(logs);
    scheduleDebouncedPush();
  }

  function renderReciteHistoryIfIdle() {
    if (!dom.reciteResult || aiState.isStreaming) return;
    if (dom.reciteResult.dataset.hasLiveResult === '1') return;

    const ctx = getScopeContext();
    const itemLogs = getReciteLogs().filter(l => l.itemId === ctx.itemId).slice(0, 3);
    if (itemLogs.length === 0) {
      dom.reciteResult.innerHTML = `
        <div class="ai-empty-hint">
          口述或键入你的背诵内容后点击「交卷批改」，DeepSeek 将对照当前卡片原文逐点核验命中要点与漏背细节，并给出高分记忆口诀。
        </div>
      `;
      return;
    }

    dom.reciteResult.innerHTML = `
      <div class="ai-recite-history-title">本题最近抽背记录（点击可展开复盘）</div>
      <div class="ai-recite-history-list">
        ${itemLogs.map((log) => `
          <details class="ai-history-item">
            <summary>
              <span class="ai-history-score">${log.score !== null ? `${log.score} 分` : '已批改'}</span>
              <span class="ai-history-block">${escapeHtml(log.blockId || '全篇')}</span>
              <span class="ai-history-time">${new Date(log.createdAt).toLocaleString()}</span>
            </summary>
            <div class="ai-history-body">${renderAiMarkdown(log.aiReply, ctx.sentences)}</div>
          </details>
        `).join('')}
      </div>
    `;
  }

  async function submitReciteGrading() {
    if (aiState.isStreaming) {
      showToast('DeepSeek 正在批改中，请稍候', 1600);
      return;
    }
    const userText = dom.reciteTextarea ? dom.reciteTextarea.value.trim() : '';
    if (!userText || userText.replace(/\s+/g, '').length < 4) {
      showToast('请先用语音输入法口述或输入至少 4 个字再交卷批改', 2200);
      return;
    }

    const ctx = getScopeContext();
    if (dom.reciteSubmitBtn) dom.reciteSubmitBtn.disabled = true;
    setReciteViewMode('graded', userText);
    dom.reciteResult.dataset.hasLiveResult = '1';
    dom.reciteResult.innerHTML = '<div class="ai-grading-card"><div class="ai-typing-dots">正在逐字比对原文并容错核验语音同音字...</div></div>';

    const messages = [
      { role: 'system', content: buildGradingSystemPrompt(ctx) },
      { role: 'user', content: `【我的语音默背口述稿】：\n${userText}` }
    ];

    try {
      const result = await streamDeepSeek({
        messages,
        temperature: 0.3,
        maxTokens: 2500,
        onDelta: ({ content, reasoning }) => {
          const reasoningHtml = reasoning
            ? `<details class="ai-reasoning-block"><summary>DeepSeek 核验思考过程</summary><div class="ai-reasoning-body">${escapeHtml(reasoning).replace(/\n/g, '<br>')}</div></details>`
            : '';
          dom.reciteResult.innerHTML = `<div class="ai-grading-card">${reasoningHtml}${renderAiMarkdown(content, ctx.sentences)}</div>`;
          dom.reciteResult.scrollTop = dom.reciteResult.scrollHeight;
        }
      });

      const finalText = result.content || '';
      if (finalText) {
        const { cardSummary, score } = extractGradingMeta(finalText);
        const existingMem = normalizeMemoryEntry(getAiMemories()[ctx.itemId]);
        const mergedSummary = cardSummary
          ? (existingMem && existingMem.summary && !existingMem.summary.includes(cardSummary)
            ? `${cardSummary}\n[历史] ${existingMem.summary}`.slice(0, 500)
            : cardSummary)
          : (existingMem ? existingMem.summary : '');

        saveMemorySummary(ctx.itemId, {
          summary: mergedSummary,
          score,
          incrementRecite: true
        });
        appendReciteLog({
          itemId: ctx.itemId,
          blockId: ctx.blockId,
          userText,
          aiReply: finalText,
          cardSummary,
          score
        });
        showToast(score !== null ? `批改完成：${score} 分，卡点已自动存档！` : '批改完成，卡点已自动存档！', 2400);
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      const errText = (err && err.message === 'NO_AUTH_CONFIGURED')
        ? '尚未配置同步口令或 DeepSeek API Key，请点击右上角齿轮图标进入设置配置。'
        : `批改请求失败：${err && err.message ? err.message : '网络错误'}`;
      dom.reciteResult.innerHTML = `<div class="ai-grading-card ai-error-box">${escapeHtml(errText)}</div>`;
    } finally {
      if (dom.reciteSubmitBtn) dom.reciteSubmitBtn.disabled = false;
    }
  }

  // ==========================================
  // 9. DOM 绑定与初始化
  // ==========================================
  function bindSettingsSyncControls() {
    dom.syncUrlInput = document.getElementById('syncServerUrlInput');
    dom.syncPinInput = document.getElementById('syncPinInput');
    dom.syncPinToggleBtn = document.getElementById('syncPinToggleBtn');
    dom.deepseekKeyInput = document.getElementById('deepseekKeyInput');
    dom.deepseekKeyToggleBtn = document.getElementById('deepseekKeyToggleBtn');
    dom.aiModelSelect = document.getElementById('aiModelSelect');
    dom.syncStatusBadge = document.getElementById('syncStatusBadge');
    dom.syncStatusMeta = document.getElementById('syncStatusMeta');
    dom.btnCloudSyncNow = document.getElementById('btnCloudSyncNow');
    dom.btnCloudTestConn = document.getElementById('btnCloudTestConn');

    const cfg = getSyncConfig();
    if (dom.syncUrlInput) {
      dom.syncUrlInput.value = cfg.url || DEFAULT_SYNC_URL;
      dom.syncUrlInput.addEventListener('change', () => {
        const val = dom.syncUrlInput.value.trim().replace(/\/+$/, '') || DEFAULT_SYNC_URL;
        dom.syncUrlInput.value = val;
        localStorage.setItem(STORAGE_KEYS.syncUrl, val);
        refreshSyncStatusFromStorage();
      });
    }
    if (dom.syncPinInput) {
      dom.syncPinInput.value = cfg.pin;
      dom.syncPinInput.addEventListener('input', () => {
        localStorage.setItem(STORAGE_KEYS.syncPin, dom.syncPinInput.value.trim());
        refreshSyncStatusFromStorage();
      });
    }
    if (dom.syncPinToggleBtn && dom.syncPinInput) {
      dom.syncPinToggleBtn.addEventListener('click', () => {
        dom.syncPinInput.type = dom.syncPinInput.type === 'password' ? 'text' : 'password';
      });
    }
    if (dom.deepseekKeyInput) {
      dom.deepseekKeyInput.value = cfg.deepseekKey;
      dom.deepseekKeyInput.addEventListener('input', () => {
        localStorage.setItem(STORAGE_KEYS.deepseekKey, dom.deepseekKeyInput.value.trim());
      });
    }
    if (dom.deepseekKeyToggleBtn && dom.deepseekKeyInput) {
      dom.deepseekKeyToggleBtn.addEventListener('click', () => {
        dom.deepseekKeyInput.type = dom.deepseekKeyInput.type === 'password' ? 'text' : 'password';
      });
    }
    if (dom.aiModelSelect) {
      dom.aiModelSelect.value = cfg.model;
      dom.aiModelSelect.addEventListener('change', () => {
        const nextModel = normalizeAiModel(dom.aiModelSelect.value);
        localStorage.setItem(STORAGE_KEYS.aiModel, nextModel);
        if (dom.drawerModelBadge) dom.drawerModelBadge.textContent = nextModel;
        showToast(`已切换模型为 ${nextModel}`, 1800);
      });
    }
    if (dom.btnCloudSyncNow) {
      dom.btnCloudSyncNow.addEventListener('click', () => {
        syncBidirectional({ quiet: false, pushFirst: false });
      });
    }
    if (dom.btnCloudTestConn) {
      dom.btnCloudTestConn.addEventListener('click', () => {
        testCloudConnection();
      });
    }

    refreshSyncStatusFromStorage();
  }

  function bindAiDrawerAndTriggers() {
    dom.headerBtn = document.getElementById('btn-ai-assistant');
    dom.selectionPill = document.getElementById('aiSelectionPill');
    dom.selectionAskBtn = document.getElementById('aiSelectionAskBtn');
    dom.selectionPillText = document.getElementById('aiSelectionPillText');
    dom.selectionDismiss = document.getElementById('aiSelectionDismiss');

    dom.backdrop = document.getElementById('aiDrawerBackdrop');
    dom.drawer = document.getElementById('aiAssistantDrawer');
    dom.drawerClose = document.getElementById('aiDrawerClose');
    dom.openSettingsBtn = document.getElementById('aiOpenSettingsBtn');
    dom.drawerModelBadge = document.getElementById('aiDrawerModelBadge');
    dom.scopeBadge = document.getElementById('aiScopeBadge');
    dom.clearScopeBtn = document.getElementById('aiClearScopeBtn');

    dom.tabAsk = document.getElementById('aiTabAsk');
    dom.tabRecite = document.getElementById('aiTabRecite');
    dom.panelAsk = document.getElementById('aiPanelAsk');
    dom.panelRecite = document.getElementById('aiPanelRecite');

    dom.memoryBox = document.getElementById('aiMemoryBox');
    dom.memoryToggleBtn = document.getElementById('aiMemoryToggleBtn');
    dom.memoryCloseBtn = document.getElementById('aiMemoryCloseBtn');
    dom.memorySummaryInput = document.getElementById('aiMemorySummaryInput');
    dom.memoryStats = document.getElementById('aiMemoryStats');
    dom.saveMemoryBtn = document.getElementById('aiSaveMemoryBtn');

    dom.quoteBox = document.getElementById('aiQuoteBox');
    dom.quoteText = document.getElementById('aiQuoteText');
    dom.quoteClearBtn = document.getElementById('aiQuoteClearBtn');

    dom.chipQuoteCurrent = document.getElementById('aiChipQuoteCurrentSent');
    dom.chipMnemonic = document.getElementById('aiChipMnemonic');
    dom.chipContrast = document.getElementById('aiChipContrast');
    dom.chipFormula = document.getElementById('aiChipFormula');
    dom.chipClearChat = document.getElementById('aiChipClearChat');

    dom.chatStream = document.getElementById('aiChatStream');
    dom.askInput = document.getElementById('aiAskInput');
    dom.askSendBtn = document.getElementById('aiAskSendBtn');

    dom.blindMaskToggle = document.getElementById('aiBlindMaskToggle');
    dom.reciteCharCount = document.getElementById('aiReciteCharCount');
    dom.reciteDraftBar = document.getElementById('aiReciteDraftBar');
    dom.reciteDraftPreview = document.getElementById('aiReciteDraftPreview');
    dom.reciteEditDraftBtn = document.getElementById('aiReciteEditDraftBtn');
    dom.reciteInputCard = document.getElementById('aiReciteInputCard');
    dom.reciteTextarea = document.getElementById('aiReciteTextarea');
    dom.reciteSnapshotBtn = document.getElementById('aiReciteSnapshotBtn');
    dom.reciteUndoDropBtn = document.getElementById('aiReciteUndoDropBtn');
    dom.reciteClearBtn = document.getElementById('aiReciteClearBtn');
    dom.reciteSubmitBtn = document.getElementById('aiReciteSubmitBtn');
    dom.reciteResult = document.getElementById('aiReciteResult');

    if (dom.headerBtn) {
      dom.headerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (aiState.isOpen) {
          closeAiDrawer();
        } else {
          openAiDrawer({ cardEl: null });
        }
      });
    }

    if (dom.drawerClose) dom.drawerClose.addEventListener('click', closeAiDrawer);
    if (dom.backdrop) dom.backdrop.addEventListener('click', closeAiDrawer);

    if (dom.openSettingsBtn) {
      dom.openSettingsBtn.addEventListener('click', () => {
        closeAiDrawer();
        const b = getBridge();
        if (b && typeof b.openSettings === 'function') {
          b.openSettings();
          setTimeout(() => {
            const sec = document.getElementById('settingsAiSyncSection');
            if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 180);
        }
      });
    }

    if (dom.clearScopeBtn) {
      dom.clearScopeBtn.addEventListener('click', () => {
        aiState.scopedCardEl = null;
        aiState.scopedCardLabel = '';
        aiState.scopedCardText = '';
        aiState.scopedSentences = [];
        updateScopeHeaderUI();
        if (aiState.activeTab === 'ask') renderChatStream();
        else renderReciteHistoryIfIdle();
      });
    }

    if (dom.tabAsk) dom.tabAsk.addEventListener('click', () => switchAiTab('ask'));
    if (dom.tabRecite) dom.tabRecite.addEventListener('click', () => switchAiTab('recite'));

    if (dom.memoryToggleBtn && dom.memoryBox) {
      dom.memoryToggleBtn.addEventListener('click', () => {
        const isShown = dom.memoryBox.style.display !== 'none';
        dom.memoryBox.style.display = isShown ? 'none' : 'block';
      });
    }
    if (dom.memoryCloseBtn && dom.memoryBox) {
      dom.memoryCloseBtn.addEventListener('click', () => {
        dom.memoryBox.style.display = 'none';
      });
    }

    if (dom.saveMemoryBtn && dom.memorySummaryInput) {
      dom.saveMemoryBtn.addEventListener('click', () => {
        const ctx = getScopeContext();
        saveMemorySummary(ctx.itemId, {
          summary: dom.memorySummaryInput.value,
          incrementRecite: false
        });
        if (dom.memoryBox) dom.memoryBox.style.display = 'none';
        showToast('本题卡点记忆已保存并加入云端同步队列', 1800);
      });
    }

    if (dom.quoteClearBtn) {
      dom.quoteClearBtn.addEventListener('click', () => {
        aiState.quotedText = '';
        updateScopeHeaderUI();
      });
    }

    if (dom.chipQuoteCurrent) {
      dom.chipQuoteCurrent.addEventListener('click', () => {
        const b = getBridge();
        if (!b) return;
        const st = b.getState();
        const sents = st.activeSentences || [];
        if (sents.length === 0) {
          showToast('当前篇目暂无逐句字幕索引', 1800);
          return;
        }
        const idx = (st.currentSentIndex >= 0 && st.currentSentIndex < sents.length) ? st.currentSentIndex : 0;
        const sent = sents[idx];
        aiState.quotedText = (sent && sent.text) ? sent.text : '';
        updateScopeHeaderUI();
        if (dom.askInput) dom.askInput.focus();
      });
    }

    if (dom.chipMnemonic) {
      dom.chipMnemonic.addEventListener('click', () => {
        sendAskMessage('请基于当前范围原文，提炼结构化的答题逻辑骨架与极简记忆口诀。');
      });
    }

    if (dom.chipContrast) {
      dom.chipContrast.addEventListener('click', () => {
        sendAskMessage('请梳理本考点的核心采分关键词与考研常考易混淆辨析点，优先用 Markdown 对比表格输出。');
      });
    }

    if (dom.chipFormula) {
      dom.chipFormula.addEventListener('click', () => {
        sendAskMessage('请把当前范围原文浓缩成不超过 50 字的考场顺口溜与关键词记忆链。');
      });
    }

    if (dom.chipClearChat) {
      dom.chipClearChat.addEventListener('click', () => {
        const ctx = getScopeContext();
        aiState.chatThreads.delete(ctx.scopeKey);
        renderChatStream();
        showToast('已清空当前范围对话', 1500);
      });
    }

    if (dom.chatStream) {
      dom.chatStream.addEventListener('click', (e) => {
        const copyBtn = e.target.closest('.js-ai-copy-btn');
        const saveBtn = e.target.closest('.js-ai-save-mem-btn');
        if (!copyBtn && !saveBtn) return;
        const idx = parseInt((copyBtn || saveBtn).dataset.msgIdx, 10);
        const ctx = getScopeContext();
        const msgs = aiState.chatThreads.get(ctx.scopeKey) || [];
        const msg = msgs[idx];
        if (!msg || !msg.content) return;

        if (copyBtn) {
          const cleanCopy = msg.content
            .replace(/\[CARD_SUMMARY\][\s\S]*?\[\/CARD_SUMMARY\]/gi, '')
            .replace(/\s*\[SENT:\d+\]/g, '')
            .trim();
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(cleanCopy).then(() => showToast('已复制解析内容', 1500)).catch(() => showToast('复制失败，请手动选中', 1600));
          }
          return;
        }
        if (saveBtn) {
          const snippet = msg.content.replace(/[#>*`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
          const existing = normalizeMemoryEntry(getAiMemories()[ctx.itemId]);
          const merged = existing && existing.summary
            ? `${snippet}\n${existing.summary}`.slice(0, 500)
            : snippet;
          saveMemorySummary(ctx.itemId, { summary: merged, incrementRecite: false });
          showToast('已提炼存入本题卡点记忆档案', 1600);
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && aiState.isOpen) {
        closeAiDrawer();
      }
    });

    if (dom.askSendBtn) {
      dom.askSendBtn.addEventListener('click', () => sendAskMessage(null));
    }
    if (dom.askInput) {
      dom.askInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          const isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
          if (!isTouch) {
            e.preventDefault();
            sendAskMessage(null);
          }
        }
      });
    }

    // 划词浮窗绑定
    if (dom.selectionAskBtn) {
      dom.selectionAskBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const snap = aiState.pendingSelection;
        const selText = (snap && snap.text) || String(window.getSelection ? window.getSelection() : '').trim();
        if (!selText) {
          hideSelectionPill();
          return;
        }
        openAiDrawer({
          cardEl: snap ? snap.cardEl : null,
          quote: selText,
          tab: 'ask'
        });
      });
    }
    if (dom.selectionDismiss) {
      dom.selectionDismiss.addEventListener('click', (e) => {
        e.stopPropagation();
        hideSelectionPill();
      });
    }

    document.addEventListener('selectionchange', () => scheduleSelectionEval(180));
    document.addEventListener('mouseup', () => scheduleSelectionEval(80));
    document.addEventListener('touchend', () => scheduleSelectionEval(140), { passive: true });

    // Tab 2: 微信语音抽背批改
    if (dom.blindMaskToggle) {
      dom.blindMaskToggle.checked = localStorage.getItem(STORAGE_KEYS.blindMask) === '1';
      dom.blindMaskToggle.addEventListener('change', () => {
        const on = Boolean(dom.blindMaskToggle.checked);
        localStorage.setItem(STORAGE_KEYS.blindMask, on ? '1' : '0');
        applyBlindMask(on);
      });
    }

    if (dom.reciteTextarea) {
      // 严禁回车误提交：Enter 永远保持换行追加多段语音
      dom.reciteTextarea.addEventListener('input', handleReciteInputBurst);
      updateReciteCharCount();
    }

    if (dom.reciteSnapshotBtn && dom.reciteTextarea) {
      dom.reciteSnapshotBtn.addEventListener('click', () => {
        const val = dom.reciteTextarea.value || '';
        pushReciteSnapshot(val);
        if (val && !val.endsWith('\n')) {
          dom.reciteTextarea.value = val + '\n';
        }
        aiState.lastReciteLen = dom.reciteTextarea.value.length;
        aiState.lastReciteEditTs = Date.now();
        dom.reciteTextarea.focus();
        updateReciteCharCount();
        showToast('已标记分段，可继续语音追加下一段', 1600);
      });
    }

    if (dom.reciteUndoDropBtn && dom.reciteTextarea) {
      dom.reciteUndoDropBtn.addEventListener('click', () => {
        if (aiState.reciteSnapshots.length === 0) {
          showToast('暂无可撤销的上一段记录', 1600);
          return;
        }
        const prev = aiState.reciteSnapshots.pop();
        dom.reciteTextarea.value = prev;
        aiState.lastReciteLen = prev.length;
        aiState.lastReciteEditTs = Date.now();
        updateReciteCharCount();
        showToast('已撤回至上一段状态', 1500);
      });
    }

    if (dom.reciteClearBtn && dom.reciteTextarea) {
      dom.reciteClearBtn.addEventListener('click', () => {
        if (dom.reciteTextarea.value) {
          pushReciteSnapshot(dom.reciteTextarea.value);
        }
        dom.reciteTextarea.value = '';
        aiState.lastReciteLen = 0;
        aiState.lastReciteEditTs = Date.now();
        updateReciteCharCount();
      });
    }

    if (dom.reciteSubmitBtn) {
      dom.reciteSubmitBtn.addEventListener('click', submitReciteGrading);
    }

    if (dom.reciteEditDraftBtn) {
      dom.reciteEditDraftBtn.addEventListener('click', () => {
        setReciteViewMode('input');
        if (dom.reciteTextarea) dom.reciteTextarea.focus();
      });
    }
  }

  // ==========================================
  // 10. 挂载 app.js 生命周期钩子与云同步调度
  // ==========================================
  window.__kaoyanAiHooks = {
    onPaperRendered: () => {
      hideSelectionPill();
      injectCardAiButtons();
      if (aiState.isOpen) {
        aiState.scopedCardEl = null;
        aiState.scopedCardLabel = '';
        aiState.scopedCardText = '';
        aiState.scopedSentences = [];
        updateScopeHeaderUI();
        if (aiState.activeTab === 'ask') renderChatStream();
        else renderReciteHistoryIfIdle();
      }
    },
    onMasteryMutation: (itemId) => {
      if (!itemId) return;
      const meta = getMasteryMeta();
      meta[itemId] = { updatedAt: Date.now() };
      setMasteryMeta(meta);
      scheduleDebouncedPush();
    },
    onStudyLogsMutation: () => {
      setStudyLogsMeta({ updatedAt: Date.now() });
      scheduleDebouncedPush();
    },
    onBackupImported: () => {
      refreshMemoryBoxUI();
      scheduleDebouncedPush();
    },
    closeDrawer: () => {
      closeAiDrawer();
    }
  };

  function initAiSyncModule() {
    migrateLegacySyncUrl();
    bindSettingsSyncControls();
    bindAiDrawerAndTriggers();
    injectCardAiButtons();

    // 1. 启动非阻塞云端拉取合并
    setTimeout(() => {
      if (isSyncConfigured()) {
        syncBidirectional({ quiet: true, pushFirst: false });
      }
    }, 1200);

    // 2. 切回前台自动同步（至少间隔 15s）
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && isSyncConfigured()) {
        const now = Date.now();
        if (now - aiState.lastVisibleSyncAt >= 15000 || isSyncDirty()) {
          aiState.lastVisibleSyncAt = now;
          syncBidirectional({ quiet: true, pushFirst: false });
        }
      }
    });

    // 3. 断网重连自动 flush 待同步队列
    window.addEventListener('online', () => {
      if (isSyncConfigured() && isSyncDirty()) {
        syncBidirectional({ quiet: true, pushFirst: true });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAiSyncModule);
  } else {
    initAiSyncModule();
  }
})();
