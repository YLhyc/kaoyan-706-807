/**
 * 2027 考研全科双轨背诵手卷 · DeepSeek AI 伴学抽背与多端云同步引擎 (v3.4.4)
 * 模块化独立挂载于 window.__kaoyanBridge，不侵入主播放与排版主路径
 */
(function () {
  'use strict';

  const STORAGE_KEYS = {
    syncUrl: 'kaoyan_sync_url',
    syncPin: 'kaoyan_sync_pin',
    deepseekKey: 'kaoyan_deepseek_key',
    aiModel: 'kaoyan_ai_model',
    reasoningEffort: 'kaoyan_ai_reasoning_effort',
    learningProfile: 'kaoyan_learning_profile',
    masteryMeta: 'kaoyan_mastery_meta',
    studyLogsMeta: 'kaoyan_study_logs_meta',
    aiMemories: 'kaoyan_ai_memories',
    reciteLogs: 'kaoyan_recite_logs',
    chatThreads: 'kaoyan_ai_chat_threads_v1',
    aiClozeCache: 'kaoyan_ai_cloze_cache_v1',
    syncDirty: 'kaoyan_sync_dirty',
    syncLastAt: 'kaoyan_sync_last_at',
    blindMask: 'kaoyan_ai_blind_mask'
  };

  const DEFAULT_SYNC_URL = 'https://sync.2026706.xyz';
  const LEGACY_SYNC_URLS = ['https://sync.2026706.xyz:8443', 'https://sync.2026706.xyz:8443/'];
  const DEFAULT_AI_MODEL = 'deepseek-flash';
  const ALLOWED_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
  const DEFAULT_REASONING_EFFORT = 'high';
  const ALLOWED_EFFORTS = ['low', 'high', 'max'];
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
  function normalizeReasoningEffort(raw) {
    const val = String(raw || '').trim().toLowerCase();
    return ALLOWED_EFFORTS.includes(val) ? val : DEFAULT_REASONING_EFFORT;
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
    chatThreads: new Map(), // scopeKey -> Array<{ role, content, reasoning?, toolStatus? }>
    chatThreadMeta: new Map(), // scopeKey -> { updatedAt: number, deleted?: boolean }
    chatThreadEpoch: new Map(), // scopeKey -> monotonic delete/clear generation counter
    isStreaming: false,
    abortController: null,
    _activeAssistantMsg: null,
    _activeScopeKey: '',
    pendingSelection: null, // { text, cardEl }
    selectionTimer: null,
    syncTimer: null,
    isSyncing: false,
    lastVisibleSyncAt: 0,
    reciteSnapshots: [],
    lastReciteEditTs: 0,
    lastReciteLen: 0,
    memoryTab: 'item',
    lastCacheUsage: null,
    isDistilling: false,
    lastAutoDistillAt: 0,
    isGeneratingCloze: false
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
    const effort = normalizeReasoningEffort(localStorage.getItem(STORAGE_KEYS.reasoningEffort) || DEFAULT_REASONING_EFFORT);
    return { url, pin, deepseekKey, model, effort };
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
      .replace(/[，。！？；：、“”""''「」『』（）()《》【】\[\]·—\-…,.;:!?'"\s]/g, '');
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

  function normalizeLearningProfile(raw) {
    const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const wpRaw = Array.isArray(obj.weakPatterns) ? obj.weakPatterns : (Array.isArray(obj.weak_patterns) ? obj.weak_patterns : []);
    return {
      summary: String(obj.summary || '').trim().slice(0, 1200),
      weakPatterns: wpRaw.map(x => String(x || '').trim()).filter(Boolean).slice(0, 20),
      preferences: (obj.preferences && typeof obj.preferences === 'object' && !Array.isArray(obj.preferences)) ? obj.preferences : {},
      updatedAt: Math.max(0, Number(obj.updatedAt || obj.updated_at) || 0)
    };
  }

  function getLearningProfile() {
    return normalizeLearningProfile(readJson(STORAGE_KEYS.learningProfile, {}));
  }

  function setLearningProfile(profile) {
    writeJson(STORAGE_KEYS.learningProfile, normalizeLearningProfile(profile));
  }

  function getReciteLogs() {
    const arr = readJson(STORAGE_KEYS.reciteLogs, []);
    return Array.isArray(arr) ? arr : [];
  }

  function setReciteLogs(arr) {
    const cleaned = Array.isArray(arr) ? arr.slice(0, 500) : [];
    writeJson(STORAGE_KEYS.reciteLogs, cleaned);
  }

  // ==========================================
  // 1B. 对话线程 LRU 持久化 (最多 30 个范围, 每范围 40 条)
  // ==========================================
  const CHAT_THREADS_MAX_SCOPES = 30;
  const CHAT_THREADS_MAX_MSGS = 40;

  function sanitizeThreadMessages(msgs) {
    if (!Array.isArray(msgs)) return [];
    const out = [];
    msgs.forEach((m) => {
      if (!m || typeof m !== 'object') return;
      const role = m.role === 'user' || m.role === 'assistant' ? m.role : '';
      if (!role) return;
      const content = typeof m.content === 'string' ? m.content : '';
      const reasoning = typeof m.reasoning === 'string' ? m.reasoning : '';
      if (role === 'assistant' && !content && !reasoning) return;
      const cleanMsg = { role, content };
      if (reasoning) cleanMsg.reasoning = reasoning;
      out.push(cleanMsg);
    });
    return out.slice(-CHAT_THREADS_MAX_MSGS);
  }

  function loadChatThreadsFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.chatThreads);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const nextMap = new Map();
      const nextMeta = new Map();
      const rawMeta = (parsed && parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta)) ? parsed.meta : {};
      Object.entries(rawMeta).forEach(([k, m]) => {
        if (!k || !m || typeof m !== 'object') return;
        nextMeta.set(String(k), {
          updatedAt: Math.max(0, Number(m.updatedAt) || 0),
          deleted: Boolean(m.deleted)
        });
      });
      const entries = (parsed && Array.isArray(parsed.entries))
        ? parsed.entries
        : (Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? Object.entries(parsed) : []));
      entries.forEach((pair) => {
        if (!Array.isArray(pair) || pair.length < 2) return;
        const scopeKey = String(pair[0] || '').trim();
        if (!scopeKey) return;
        const msgs = sanitizeThreadMessages(pair[1]);
        if (msgs.length > 0) {
          nextMap.delete(scopeKey);
          nextMap.set(scopeKey, msgs);
          if (!nextMeta.has(scopeKey)) {
            nextMeta.set(scopeKey, { updatedAt: 1, deleted: false });
          }
        }
      });
      while (nextMap.size > CHAT_THREADS_MAX_SCOPES) {
        const oldestKey = nextMap.keys().next().value;
        nextMap.delete(oldestKey);
      }
      aiState.chatThreads = nextMap;
      aiState.chatThreadMeta = nextMeta;
    } catch (e) {
      console.warn('loadChatThreadsFromStorage failed:', e);
    }
  }

  function persistChatThreadsToStorage(options = {}) {
    try {
      const entries = [];
      for (const [scopeKey, msgs] of aiState.chatThreads.entries()) {
        if (!scopeKey) continue;
        const cleanMsgs = sanitizeThreadMessages(msgs);
        if (cleanMsgs.length > 0) {
          entries.push([scopeKey, cleanMsgs]);
        }
      }
      const trimmed = entries.slice(-CHAT_THREADS_MAX_SCOPES);
      const keepKeys = new Set(trimmed.map(e => e[0]));
      const metaObj = {};
      for (const [k, m] of aiState.chatThreadMeta.entries()) {
        if (keepKeys.has(k) || m.deleted) {
          metaObj[k] = { updatedAt: Math.max(0, Number(m.updatedAt) || 0), deleted: Boolean(m.deleted) };
        }
      }
      localStorage.setItem(STORAGE_KEYS.chatThreads, JSON.stringify({
        version: 1,
        entries: trimmed,
        meta: metaObj
      }));
      if (options && options.sync) {
        scheduleDebouncedPush();
      }
    } catch (e) {
      console.warn('persistChatThreadsToStorage failed:', e);
    }
  }

  function touchChatThread(scopeKey, msgs) {
    if (!scopeKey) return [];
    const list = Array.isArray(msgs) ? msgs.slice(-CHAT_THREADS_MAX_MSGS) : [];
    aiState.chatThreads.delete(scopeKey);
    aiState.chatThreads.set(scopeKey, list);
    aiState.chatThreadMeta.set(scopeKey, { updatedAt: Date.now(), deleted: false });
    while (aiState.chatThreads.size > CHAT_THREADS_MAX_SCOPES) {
      const oldestKey = aiState.chatThreads.keys().next().value;
      aiState.chatThreads.delete(oldestKey);
    }
    return list;
  }

  function buildChatThreadsSyncPayload() {
    const out = {};
    const pairs = Array.from(aiState.chatThreads.entries()).slice(-20);
    pairs.forEach(([scopeKey, msgs]) => {
      const clean = sanitizeThreadMessages(msgs).slice(-12).map(m => ({
        role: m.role,
        content: m.content,
        reasoning: m.reasoning || ''
      }));
      if (clean.length > 0) {
        const meta = aiState.chatThreadMeta.get(scopeKey);
        out[scopeKey] = {
          msgs: clean,
          updatedAt: Math.max(1, Number(meta && meta.updatedAt) || 1)
        };
      }
    });
    for (const [scopeKey, meta] of aiState.chatThreadMeta.entries()) {
      if (meta && meta.deleted && !out[scopeKey]) {
        out[scopeKey] = {
          msgs: [],
          deleted: true,
          updatedAt: Math.max(1, Number(meta.updatedAt) || Date.now())
        };
      }
    }
    return out;
  }

  function extractChatThreadsFromMemories(remoteMemories) {
    if (!remoteMemories || typeof remoteMemories !== 'object') return null;
    const rawEntry = remoteMemories.__sys_chat_threads__;
    if (!rawEntry || typeof rawEntry !== 'object' || typeof rawEntry.text !== 'string') return null;
    try {
      const parsed = JSON.parse(rawEntry.text);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function mergeChatThreadsWithRemote(remoteThreads) {
    if (!remoteThreads || typeof remoteThreads !== 'object' || Array.isArray(remoteThreads)) {
      return { localHasNewer: aiState.chatThreads.size > 0, activeUpdated: false };
    }
    let localHasNewer = false;
    let activeUpdated = false;
    const activeScopeKey = aiState._activeScopeKey || (aiState.isOpen ? getScopeContext().scopeKey : '');
    const allScopes = new Set([
      ...Array.from(aiState.chatThreads.keys()),
      ...Array.from(aiState.chatThreadMeta.keys()),
      ...Object.keys(remoteThreads)
    ]);

    allScopes.forEach((scopeKey) => {
      if (!scopeKey) return;
      const locMsgs = aiState.chatThreads.get(scopeKey) || null;
      const locMeta = aiState.chatThreadMeta.get(scopeKey) || null;
      const locTs = Math.max(0, Number(locMeta && locMeta.updatedAt) || (locMsgs ? 1 : 0));
      const locDeleted = Boolean(locMeta && locMeta.deleted && !locMsgs);

      const rawRem = remoteThreads[scopeKey];
      const remObj = Array.isArray(rawRem)
        ? { msgs: rawRem, updatedAt: 1, deleted: false }
        : (rawRem && typeof rawRem === 'object' ? rawRem : null);
      const remMsgs = remObj && !remObj.deleted ? sanitizeThreadMessages(remObj.msgs || []) : [];
      const remTs = remObj ? Math.max(0, Number(remObj.updatedAt) || (remMsgs.length ? 1 : 0)) : 0;
      const remDeleted = Boolean(remObj && remObj.deleted);

      if ((locMsgs || locDeleted) && !remObj) {
        localHasNewer = true;
        return;
      }
      if (remObj && !(locMsgs || locDeleted)) {
        if (remDeleted) {
          aiState.chatThreads.delete(scopeKey);
          aiState.chatThreadMeta.set(scopeKey, { updatedAt: remTs, deleted: true });
        } else if (remMsgs.length > 0) {
          aiState.chatThreads.set(scopeKey, remMsgs);
          aiState.chatThreadMeta.set(scopeKey, { updatedAt: remTs, deleted: false });
          if (scopeKey === activeScopeKey) activeUpdated = true;
        }
        return;
      }
      if (remObj && (locMsgs || locDeleted)) {
        if (locTs > remTs || (locTs === remTs && (locMsgs ? locMsgs.length : 0) > remMsgs.length)) {
          localHasNewer = true;
        } else if (remTs > locTs || (remTs === locTs && remMsgs.length > (locMsgs ? locMsgs.length : 0))) {
          if (remDeleted) {
            aiState.chatThreads.delete(scopeKey);
            aiState.chatThreadMeta.set(scopeKey, { updatedAt: remTs, deleted: true });
          } else {
            aiState.chatThreads.set(scopeKey, remMsgs);
            aiState.chatThreadMeta.set(scopeKey, { updatedAt: remTs, deleted: false });
          }
          if (scopeKey === activeScopeKey) activeUpdated = true;
        }
      }
    });

    while (aiState.chatThreads.size > CHAT_THREADS_MAX_SCOPES) {
      const oldestKey = aiState.chatThreads.keys().next().value;
      aiState.chatThreads.delete(oldestKey);
    }
    persistChatThreadsToStorage({ sync: false });
    if (activeUpdated && aiState.isOpen && aiState.activeTab === 'ask' && !aiState.isStreaming) {
      renderChatStream();
    }
    return { localHasNewer, activeUpdated };
  }

  // ==========================================
  // 1C. AI 采分眼挖空缓存规范化与 LWW 合并
  // ==========================================
  function parseTimestampMs(val) {
    if (typeof val === 'number' && !isNaN(val)) return Math.max(0, val);
    const s = String(val || '').trim();
    if (!s) return 0;
    if (/^\d+$/.test(s)) return Math.max(0, Number(s) || 0);
    const ms = Date.parse(s);
    return isNaN(ms) ? 0 : Math.max(0, ms);
  }

  function cleanClozePhraseList(arr) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    arr.forEach((raw) => {
      if (typeof raw !== 'string') return;
      const txt = raw.trim();
      if (txt.length >= 2 && txt.length <= 48 && !seen.has(txt)) {
        seen.add(txt);
        out.push(txt);
      }
    });
    return out.slice(0, 32);
  }

  function normalizeClozeEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const skeleton = cleanClozePhraseList(entry.skeleton);
    const scoring = cleanClozePhraseList(entry.scoring);
    if (skeleton.length === 0 && scoring.length === 0) return null;
    const rawUpdated = entry.updated_at ?? entry.updatedAt ?? '';
    const updatedMs = parseTimestampMs(rawUpdated);
    const updatedAtIso = (typeof rawUpdated === 'string' && rawUpdated.trim() && isNaN(Number(rawUpdated)))
      ? rawUpdated.trim()
      : (updatedMs > 0 ? new Date(updatedMs).toISOString() : '');
    return {
      skeleton,
      scoring,
      model: String(entry.model || DEFAULT_AI_MODEL).trim() || DEFAULT_AI_MODEL,
      updated_at: updatedAtIso,
      updatedAt: updatedMs
    };
  }

  function getAiClozeCacheMap() {
    const raw = readJson(STORAGE_KEYS.aiClozeCache, {});
    const out = {};
    Object.entries(raw || {}).forEach(([itemId, val]) => {
      const norm = normalizeClozeEntry(val);
      if (itemId && norm) out[String(itemId)] = norm;
    });
    return out;
  }

  function setAiClozeCacheMap(map) {
    const clean = {};
    Object.entries(map || {}).forEach(([itemId, val]) => {
      const norm = normalizeClozeEntry(val);
      if (itemId && norm) {
        clean[String(itemId)] = {
          skeleton: norm.skeleton,
          scoring: norm.scoring,
          model: norm.model,
          updated_at: norm.updated_at || new Date(norm.updatedAt || Date.now()).toISOString()
        };
      }
    });
    writeJson(STORAGE_KEYS.aiClozeCache, clean);
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
    const rawCounts = (logs && logs.itemListenCounts && typeof logs.itemListenCounts === 'object') ? logs.itemListenCounts : {};
    const cleanCounts = {};
    Object.entries(rawCounts).forEach(([id, c]) => {
      const val = Math.floor(Number(c) || 0);
      if (id && val > 0) cleanCounts[String(id)] = val;
    });
    const out = {
      dates: Array.isArray(logs.dates) ? logs.dates : [],
      completedIds: Array.isArray(logs.completedIds) ? logs.completedIds : [],
      dailyListenSec: daily,
      totalListenSec: Math.max(0, Number(logs.totalListenSec) || 0),
      itemListenCounts: cleanCounts,
      listenProgress: window.KaoyanListen ? window.KaoyanListen.normalize(logs.listenProgress) : {},
      updatedAt: Number(meta && meta.updatedAt) || 0
    };
    if (logs && logs.deviceBuckets && typeof logs.deviceBuckets === 'object' && !Array.isArray(logs.deviceBuckets)) {
      out.legacyListen = (logs.legacyListen && typeof logs.legacyListen === 'object') ? logs.legacyListen : {
        dailyListenSec: {},
        totalListenSec: 0,
        itemListenCounts: {}
      };
      out.deviceBuckets = logs.deviceBuckets;
      out.listenSchemaVersion = logs.listenSchemaVersion;
    }
    return out;
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

  function normalizeSyncListenBucket(raw) {
    const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const daily = {};
    if (src.dailyListenSec && typeof src.dailyListenSec === 'object' && !Array.isArray(src.dailyListenSec)) {
      Object.entries(src.dailyListenSec).forEach(([d, sec]) => {
        const v = Number(sec);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && v > 0) daily[d] = v;
      });
    }
    const counts = {};
    if (src.itemListenCounts && typeof src.itemListenCounts === 'object' && !Array.isArray(src.itemListenCounts)) {
      Object.entries(src.itemListenCounts).forEach(([id, c]) => {
        const v = Math.floor(Number(c) || 0);
        if (id && v > 0) counts[String(id)] = v;
      });
    }
    const dailySum = Object.values(daily).reduce((a, b) => a + b, 0);
    return {
      dailyListenSec: daily,
      totalListenSec: Math.max(dailySum, Number(src.totalListenSec) || 0),
      itemListenCounts: counts,
      itemListenDecrements: Object.fromEntries(Object.entries(src.itemListenDecrements || {}).filter(
        ([id, c]) => id && Number.isFinite(Number(c)) && Math.floor(Number(c)) > 0
      ).map(([id, c]) => [id, Math.floor(Number(c))])),
      updatedAt: Math.max(0, Number(src.updatedAt) || 0)
    };
  }

  function mergeSyncBucketPair(locB, remB) {
    const a = normalizeSyncListenBucket(locB);
    const b = normalizeSyncListenBucket(remB);
    const daily = {};
    let localNewer = false;
    new Set([...Object.keys(a.dailyListenSec), ...Object.keys(b.dailyListenSec)]).forEach((d) => {
      const av = a.dailyListenSec[d] || 0;
      const bv = b.dailyListenSec[d] || 0;
      if (av > bv + 0.5) localNewer = true;
      const mv = Math.max(av, bv);
      if (mv > 0) daily[d] = mv;
    });
    const counts = {};
    new Set([...Object.keys(a.itemListenCounts), ...Object.keys(b.itemListenCounts)]).forEach((id) => {
      const ac = a.itemListenCounts[id] || 0;
      const bc = b.itemListenCounts[id] || 0;
      if (ac > bc) localNewer = true;
      const mc = Math.max(ac, bc);
      if (mc > 0) counts[id] = mc;
    });
    const dailySum = Object.values(daily).reduce((acc, v) => acc + v, 0);
    if (a.totalListenSec > b.totalListenSec + 0.5) localNewer = true;
    const decrements = {};
    new Set([...Object.keys(a.itemListenDecrements), ...Object.keys(b.itemListenDecrements)]).forEach(id => {
      const ac = a.itemListenDecrements[id] || 0;
      const bc = b.itemListenDecrements[id] || 0;
      if (ac > bc) localNewer = true;
      const value = Math.max(ac, bc);
      if (value > 0) decrements[id] = value;
    });
    return {
      bucket: {
        dailyListenSec: daily,
        totalListenSec: Math.max(dailySum, a.totalListenSec, b.totalListenSec),
        itemListenCounts: counts,
        itemListenDecrements: decrements,
        updatedAt: Math.max(a.updatedAt, b.updatedAt)
      },
      localNewer
    };
  }

  function mergeStudyLogsWithRemote(remoteLogs) {
    const loc = buildLocalStudyLogsPayload();
    if (!remoteLogs || typeof remoteLogs !== 'object') return { localHasNewer: false };
    const bridge = getBridge();
    if (remoteLogs.deviceBuckets && typeof remoteLogs.deviceBuckets === 'object' && !Array.isArray(remoteLogs.deviceBuckets)
      && remoteLogs.listenSchemaVersion !== 2 && bridge && typeof bridge.normalizeStudyLogsForSync === 'function') {
      // Upgrade a v3.4.10 peer's saved compatibility floor before merging buckets.
      remoteLogs = bridge.normalizeStudyLogsForSync(remoteLogs);
    }

    const remDates = Array.isArray(remoteLogs.dates) ? remoteLogs.dates : [];
    const remCompleted = Array.isArray(remoteLogs.completedIds ?? remoteLogs.completed_ids)
      ? (remoteLogs.completedIds ?? remoteLogs.completed_ids)
      : [];
    const remDaily = (remoteLogs.dailyListenSec ?? remoteLogs.daily_listen_sec) || {};
    const remTotal = Math.max(0, Number(remoteLogs.totalListenSec ?? remoteLogs.total_listen_sec ?? 0) || 0);
    const remCounts = (remoteLogs.itemListenCounts ?? remoteLogs.item_listen_counts) || {};
    const remUpdated = Number(remoteLogs.updatedAt ?? remoteLogs.updated_at ?? 0) || 0;
    const remBuckets = (remoteLogs.deviceBuckets && typeof remoteLogs.deviceBuckets === 'object' && !Array.isArray(remoteLogs.deviceBuckets))
      ? remoteLogs.deviceBuckets
      : null;
    const remLegacyRaw = (remoteLogs.legacyListen && typeof remoteLogs.legacyListen === 'object') ? remoteLogs.legacyListen : null;

    const mergedDates = Array.from(new Set([...(loc.dates || []), ...remDates]))
      .filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    const mergedCompleted = Array.from(new Set([...(loc.completedIds || []), ...remCompleted]))
      .filter(id => typeof id === 'string' && id.length > 0);

    const locBuckets = (loc.deviceBuckets && typeof loc.deviceBuckets === 'object') ? loc.deviceBuckets : {};
    const listenProgress = window.KaoyanListen ? window.KaoyanListen.merge(loc.listenProgress, remoteLogs.listenProgress) : {};
    const autoCounts = window.KaoyanListen ? window.KaoyanListen.totals(listenProgress) : {};
    const progressLocalNewer = window.KaoyanListen && JSON.stringify(listenProgress) !== JSON.stringify(window.KaoyanListen.normalize(remoteLogs.listenProgress));
    const mergedBuckets = {};
    let bucketsLocalNewer = false;
    new Set([...Object.keys(locBuckets), ...Object.keys(remBuckets || {})]).forEach((devId) => {
      if (!devId) return;
      const res = mergeSyncBucketPair(locBuckets[devId], remBuckets ? remBuckets[devId] : null);
      if (
        Object.keys(res.bucket.dailyListenSec).length > 0 ||
        res.bucket.totalListenSec > 0 ||
        Object.keys(res.bucket.itemListenCounts).length > 0 ||
        Object.keys(res.bucket.itemListenDecrements).length > 0
      ) {
        mergedBuckets[devId] = res.bucket;
      }
      if (res.localNewer || (locBuckets[devId] && !(remBuckets && remBuckets[devId]))) {
        bucketsLocalNewer = true;
      }
    });

    const legacyRes = mergeSyncBucketPair(
      loc.legacyListen || (loc.deviceBuckets ? {} : loc),
      remLegacyRaw || {}
    );
    const mergedLegacy = legacyRes.bucket;

    // Flat fields from bucket-aware peers are derived snapshots, not extra events.
    const sumDaily = {};
    const sumCounts = {};
    const sumDecrements = { ...mergedLegacy.itemListenDecrements };
    let sumTotal = Math.max(0, Number(mergedLegacy.totalListenSec) || 0);
    Object.entries(mergedLegacy.dailyListenSec || {}).forEach(([d, v]) => {
      sumDaily[d] = (sumDaily[d] || 0) + v;
    });
    Object.entries(mergedLegacy.itemListenCounts || {}).forEach(([id, c]) => {
      sumCounts[id] = (sumCounts[id] || 0) + c;
    });
    Object.values(mergedBuckets).forEach((bk) => {
      Object.entries(bk.dailyListenSec || {}).forEach(([d, v]) => {
        sumDaily[d] = (sumDaily[d] || 0) + v;
      });
      Object.entries(bk.itemListenCounts || {}).forEach(([id, c]) => {
        sumCounts[id] = (sumCounts[id] || 0) + c;
      });
      Object.entries(bk.itemListenDecrements || {}).forEach(([id, c]) => {
        sumDecrements[id] = (sumDecrements[id] || 0) + c;
      });
      sumTotal += Math.max(0, Number(bk.totalListenSec) || 0);
    });
    Object.entries(autoCounts).forEach(([id, count]) => { sumCounts[id] = (sumCounts[id] || 0) + count; });

    if (!remBuckets) {
      // Persist only an old peer's uncovered floor into the shared legacy base.
      // Compare counts before decrements, so old flat snapshots cannot undo an undo.
      Object.entries(remDaily).forEach(([d, sec]) => {
        const value = Number(sec);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(value)) return;
        const deficit = Math.max(0, value - (sumDaily[d] || 0));
        if (deficit) {
          mergedLegacy.dailyListenSec[d] = (mergedLegacy.dailyListenSec[d] || 0) + deficit;
          sumDaily[d] = value;
        }
      });
      Object.entries(remCounts).forEach(([id, count]) => {
        const value = Math.floor(Number(count));
        if (!id || !Number.isFinite(value)) return;
        const deficit = Math.max(0, value - (sumCounts[id] || 0));
        if (deficit) {
          mergedLegacy.itemListenCounts[id] = (mergedLegacy.itemListenCounts[id] || 0) + deficit;
          sumCounts[id] = value;
        }
      });
      const oldTotal = mergedLegacy.totalListenSec;
      mergedLegacy.totalListenSec = Math.max(
        oldTotal + Math.max(0, remTotal - sumTotal),
        Object.values(mergedLegacy.dailyListenSec).reduce((a, b) => a + b, 0)
      );
      sumTotal += mergedLegacy.totalListenSec - oldTotal;
    }

    const mergedDaily = {};
    const allDays = new Set(Object.keys(sumDaily));
    let dailySum = 0;
    allDays.forEach((d) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      const v = Number(sumDaily[d]) || 0;
      if (v > 0) {
        mergedDaily[d] = v;
        dailySum += v;
      }
    });

    const mergedCounts = {};
    let countsLocalNewer = false;
    const allCountIds = new Set([...Object.keys(sumCounts), ...Object.keys(sumDecrements)]);
    allCountIds.forEach((id) => {
      if (!id) return;
      const sv = Math.max(0, Math.floor(Number(sumCounts[id]) || 0));
      const rv = Math.max(0, Math.floor(Number(remCounts[id]) || 0));
      const mv = Math.max(0, sv - (sumDecrements[id] || 0));
      if (mv > 0) mergedCounts[id] = mv;
      if (mv !== rv) countsLocalNewer = true;
    });

    const mergedTotal = Math.max(dailySum, sumTotal);
    const mergedUpdated = Math.max(loc.updatedAt || 0, remUpdated);
    const localHasNewer = (
      mergedDates.length > remDates.length ||
      mergedCompleted.length > remCompleted.length ||
      mergedTotal > remTotal + 0.5 ||
      countsLocalNewer ||
      bucketsLocalNewer ||
      legacyRes.localNewer ||
      progressLocalNewer ||
      (loc.updatedAt || 0) > remUpdated
    );

    const b = getBridge();
    const masteryCount = Object.values(b ? b.getMasteryState() : {}).filter(v => v === 'mastered').length;
    const mergedLogs = {
      dates: mergedDates,
      completedIds: mergedCompleted,
      totalCardsCompleted: Math.max(mergedCompleted.length, masteryCount),
      dailyListenSec: mergedDaily,
      totalListenSec: mergedTotal,
      itemListenCounts: mergedCounts,
      listenProgress,
      legacyListen: mergedLegacy,
      deviceBuckets: mergedBuckets,
      listenSchemaVersion: 2
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
      if (!itemId || itemId === '__sys_chat_threads__') return;
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

  function mergeLearningProfileWithRemote(remoteLp) {
    const loc = getLearningProfile();
    const rem = normalizeLearningProfile(remoteLp);
    let localHasNewer = false;
    if (rem.updatedAt > loc.updatedAt || (loc.updatedAt === 0 && !loc.summary && rem.summary)) {
      setLearningProfile(rem);
    } else if (loc.updatedAt > rem.updatedAt || (loc.summary && !rem.summary)) {
      localHasNewer = true;
    }
    return { localHasNewer };
  }

  function mergeAiClozeCacheWithRemote(remoteCloze) {
    const localMap = getAiClozeCacheMap();
    const remoteMap = (remoteCloze && typeof remoteCloze === 'object' && !Array.isArray(remoteCloze)) ? remoteCloze : {};
    const merged = {};
    let localHasNewer = false;
    let activeUpdated = false;
    const b = getBridge();
    const activeId = b && b.getState ? b.getState().activeItemId : '';

    const allIds = new Set([...Object.keys(localMap), ...Object.keys(remoteMap)]);
    allIds.forEach((itemId) => {
      const loc = normalizeClozeEntry(localMap[itemId]);
      const rem = normalizeClozeEntry(remoteMap[itemId]);
      if (loc && rem) {
        if ((loc.updatedAt || 0) > (rem.updatedAt || 0)) {
          merged[itemId] = loc;
          localHasNewer = true;
        } else {
          merged[itemId] = rem;
          if (itemId === activeId) activeUpdated = true;
        }
      } else if (loc) {
        merged[itemId] = loc;
        localHasNewer = true;
      } else if (rem) {
        merged[itemId] = rem;
        if (itemId === activeId) activeUpdated = true;
      }
    });

    setAiClozeCacheMap(merged);
    if (b && typeof b.setAiClozeDataBatch === 'function') {
      const batchObj = {};
      Object.entries(merged).forEach(([itemId, entry]) => {
        batchObj[itemId] = {
          skeleton: entry.skeleton,
          scoring: entry.scoring,
          model: entry.model,
          updated_at: entry.updated_at || new Date(entry.updatedAt || Date.now()).toISOString()
        };
      });
      b.setAiClozeDataBatch(batchObj);
    } else if (b && typeof b.setAiClozeData === 'function') {
      Object.entries(merged).forEach(([itemId, entry]) => {
        b.setAiClozeData(itemId, {
          skeleton: entry.skeleton,
          scoring: entry.scoring,
          model: entry.model,
          updated_at: entry.updated_at || new Date(entry.updatedAt || Date.now()).toISOString()
        });
      });
    }
    if (activeUpdated && b && typeof b.refreshCloze === 'function') {
      b.refreshCloze();
    }
    return { localHasNewer };
  }

  let syncMutationSeq = 0;
  let queuedSyncOptions = null;

  async function fetchWithTimeout(url, options = {}, timeoutMs = 15000, readResponse = res => res) {
    const ctrl = typeof AbortController === 'undefined' ? null : new AbortController();
    const parentSignal = options && options.signal;
    let rejectRequest;
    const cancelled = new Promise((_, reject) => { rejectRequest = reject; });
    const abortRequest = (message) => {
      const err = new Error(message);
      err.name = 'AbortError';
      rejectRequest(err);
      try { if (ctrl) ctrl.abort(); } catch (e) {}
    };
    const timer = setTimeout(() => abortRequest('REQUEST_TIMEOUT'), timeoutMs);
    const onParentAbort = () => abortRequest('REQUEST_ABORTED');
    if (parentSignal) {
      if (parentSignal.aborted) onParentAbort();
      else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    try {
      // Keep the deadline alive through JSON/body consumption, even if a transport ignores abort.
      return await Promise.race([
        cancelled,
        Promise.resolve().then(() => {
          if (parentSignal && parentSignal.aborted) throw new Error('REQUEST_ABORTED');
          return fetch(url, { ...options, signal: ctrl ? ctrl.signal : parentSignal });
        }).then(readResponse)
      ]);
    } finally {
      clearTimeout(timer);
      if (parentSignal) {
        try { parentSignal.removeEventListener('abort', onParentAbort); } catch (e) {}
      }
    }
  }

  function readSyncJsonResponse(res) {
    if (res.status === 401) throw new Error('SYNC_PIN_INVALID');
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return res.json();
  }

  function markSyncDirty() {
    syncMutationSeq++;
    try {
      localStorage.setItem(STORAGE_KEYS.syncDirty, '1');
    } catch (e) {}
  }

  function clearSyncDirty(seqAtStart = null) {
    if (seqAtStart !== null && seqAtStart !== syncMutationSeq) {
      return false;
    }
    try {
      localStorage.setItem(STORAGE_KEYS.syncDirty, '0');
      localStorage.setItem(STORAGE_KEYS.syncLastAt, String(Date.now()));
    } catch (e) {}
    return true;
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
    return fetchWithTimeout(`${cfg.url}/api/sync/pull`, {
      method: 'GET',
      headers: {
        'X-Sync-Pin': cfg.pin
      }
    }, 15000, readSyncJsonResponse);
  }

  function buildRemoteClozePayload() {
    const map = getAiClozeCacheMap();
    const out = {};
    Object.entries(map).forEach(([itemId, entry]) => {
      out[itemId] = {
        skeleton: entry.skeleton,
        scoring: entry.scoring,
        model: entry.model,
        updated_at: entry.updated_at || new Date(entry.updatedAt || Date.now()).toISOString()
      };
    });
    return out;
  }

  async function syncPushOnly(cfg) {
    const memoriesCopy = { ...getAiMemories() };
    const chatPayload = buildChatThreadsSyncPayload();
    if (Object.keys(chatPayload).length > 0) {
      let maxTs = 1;
      Object.values(chatPayload).forEach(v => {
        if (v && v.updatedAt > maxTs) maxTs = v.updatedAt;
      });
      const serialized = JSON.stringify(chatPayload);
      if (serialized.length <= 65536) {
        memoriesCopy.__sys_chat_threads__ = {
          kind: 'system_chat_threads',
          text: serialized,
          updatedAt: maxTs
        };
      }
    }
    const payload = {
      mastery: buildLocalMasteryPayload(),
      studyLogs: buildLocalStudyLogsPayload(),
      aiMemories: memoriesCopy,
      reciteLogs: getReciteLogs(),
      learningProfile: getLearningProfile(),
      ai_cloze_cache: buildRemoteClozePayload(),
      chatThreads: chatPayload
    };
    return fetchWithTimeout(`${cfg.url}/api/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Pin': cfg.pin
      },
      body: JSON.stringify(payload)
    }, 18000, readSyncJsonResponse);
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
    if (aiState.isSyncing) {
      queuedSyncOptions = {
        quiet: queuedSyncOptions ? (queuedSyncOptions.quiet && quiet) : quiet,
        pushFirst: Boolean((queuedSyncOptions && queuedSyncOptions.pushFirst) || pushFirst)
      };
      return false;
    }

    aiState.isSyncing = true;
    const seqAtStart = syncMutationSeq;
    updateSyncStatusUI('正在同步...', 'busy');
    try {
      let needPush = pushFirst || isSyncDirty();

      if (!pushFirst) {
        const pullData = await syncPullOnly(cfg);
        const r1 = mergeMasteryWithRemote(pullData.mastery);
        const r2 = mergeStudyLogsWithRemote(pullData.studyLogs);
        const r3 = mergeAiMemoriesWithRemote(pullData.aiMemories);
        const r4 = mergeReciteLogsWithRemote(pullData.reciteLogs);
        const r5 = mergeLearningProfileWithRemote(pullData.learningProfile);
        const r6 = mergeAiClozeCacheWithRemote(pullData.ai_cloze_cache ?? pullData.aiClozeCache);
        const remThreads = pullData.chatThreads || extractChatThreadsFromMemories(pullData.aiMemories);
        const r7 = mergeChatThreadsWithRemote(remThreads);
        if (r1.localHasNewer || r2.localHasNewer || r3.localHasNewer || r4.localHasNewer || r5.localHasNewer || r6.localHasNewer || r7.localHasNewer) {
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
          mergeLearningProfileWithRemote(merged.learningProfile);
          mergeAiClozeCacheWithRemote(merged.ai_cloze_cache ?? merged.aiClozeCache);
          mergeChatThreadsWithRemote(merged.chatThreads || extractChatThreadsFromMemories(merged.aiMemories));
        }
      }

      clearSyncDirty(seqAtStart);
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
      const pending = queuedSyncOptions;
      queuedSyncOptions = null;
      if (pending || syncMutationSeq !== seqAtStart) {
        const nextOpts = pending || { quiet: true, pushFirst: true };
        setTimeout(() => {
          syncBidirectional({ quiet: nextOpts.quiet !== false, pushFirst: Boolean(nextOpts.pushFirst) });
        }, 80);
      }
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
      const data = await fetchWithTimeout(`${cfg.url}/api/health`, { method: 'GET', headers }, 10000, readSyncJsonResponse);
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
    clone.querySelectorAll(
      '.card-ai-btn, .card-relay-btn, .seal-btn, .en-audio-jump-pill, .tj-point-jump-pill, .xt-point-jump-hint, .live-repeat-badge, ' +
      '.relay-toolbar, .relay-chain-bar, .relay-chain-head, .relay-mini-btn, .relay-card-actions, .relay-role, .relay-origin-tip, .relay-t1-chain-bar, .relay-bookend-head, svg'
    ).forEach(n => n.remove());
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

    const paperEl = document.getElementById('paper-content');
    const paperText = extractCleanTextFromElement(paperEl);
    const fullSentences = collectScopedSentences(null);
    const fullRefText = (paperText || aiState.scopedCardText || '').slice(0, 12000);
    const focusedCardText = aiState.scopedCardEl ? (aiState.scopedCardText || '').slice(0, 4000) : '';
    const sentences = aiState.scopedCardEl ? aiState.scopedSentences : fullSentences;
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
      refText: fullRefText,
      fullRefText,
      focusedCardText,
      sentences: (sentences || []).slice(0, 160),
      allSentences: (fullSentences || []).slice(0, 300)
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

  function setReasoningEffort(nextEffort, showFeedback = false) {
    const clean = normalizeReasoningEffort(nextEffort);
    try { localStorage.setItem(STORAGE_KEYS.reasoningEffort, clean); } catch (e) {}
    if (dom.aiEffortSelect) dom.aiEffortSelect.value = clean;
    if (dom.effortSeg) {
      dom.effortSeg.querySelectorAll('.ai-effort-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.effort === clean);
      });
    }
    if (showFeedback) {
      const labelMap = { low: '极速 Low', high: '标准 High', max: '深思 Max' };
      showToast(`思考强度已设为：${labelMap[clean] || clean}`, 1600);
    }
    return clean;
  }

  function updateCacheBadgeUI(usage) {
    if (!dom.cacheBadge) return;
    if (!usage || typeof usage !== 'object') {
      dom.cacheBadge.style.display = 'none';
      return;
    }
    const totalP = Number(usage.prompt_tokens) || 0;
    const hit = Number(usage.prompt_cache_hit_tokens) || 0;
    if (totalP <= 0) {
      dom.cacheBadge.style.display = 'none';
      return;
    }
    const pct = Math.min(100, Math.round((hit / totalP) * 100));
    dom.cacheBadge.style.display = 'inline-flex';
    if (hit > 0) {
      dom.cacheBadge.textContent = `⚡ 缓存命中 ${pct}%`;
      dom.cacheBadge.title = `命中前缀缓存 ${hit} / ${totalP} tokens`;
    } else {
      dom.cacheBadge.textContent = `⚡ 已建缓存`;
      dom.cacheBadge.title = `首轮提示词 ${totalP} tokens 已写入前缀缓存，追问可直接复用`;
    }
  }

  function switchMemoryTab(tabName) {
    const tab = tabName === 'global' ? 'global' : 'item';
    aiState.memoryTab = tab;
    if (dom.memTabItem) dom.memTabItem.classList.toggle('active', tab === 'item');
    if (dom.memTabGlobal) dom.memTabGlobal.classList.toggle('active', tab === 'global');
    if (dom.memPaneItem) dom.memPaneItem.style.display = tab === 'item' ? 'block' : 'none';
    if (dom.memPaneGlobal) dom.memPaneGlobal.style.display = tab === 'global' ? 'block' : 'none';
  }

  function refreshMemoryBoxUI() {
    const ctx = getScopeContext();
    const memories = getAiMemories();
    const mem = normalizeMemoryEntry(memories[ctx.itemId]);
    if (dom.memorySummaryInput && document.activeElement !== dom.memorySummaryInput) {
      const sameDirtyItem = dom.memorySummaryInput.dataset.dirty === '1' && dom.memorySummaryInput.dataset.itemId === ctx.itemId;
      if (!sameDirtyItem) {
        dom.memorySummaryInput.value = mem ? mem.summary : '';
        dom.memorySummaryInput.dataset.itemId = ctx.itemId;
        dom.memorySummaryInput.dataset.dirty = '0';
      }
    }
    if (dom.memoryStats) {
      if (mem && (mem.reciteCount > 0 || mem.lastScore !== null)) {
        const scorePart = mem.lastScore !== null ? `${mem.lastScore}分` : '已记录';
        dom.memoryStats.textContent = `${mem.reciteCount}次 · ${scorePart}`;
      } else if (mem && mem.summary) {
        dom.memoryStats.textContent = '已记录';
      } else {
        const lp = getLearningProfile();
        dom.memoryStats.textContent = lp.summary ? '已建画像' : '暂无笔记';
      }
    }
    if (dom.memoryToggleBtn) {
      const lp = getLearningProfile();
      dom.memoryToggleBtn.classList.toggle('has-memory', Boolean((mem && (mem.summary || mem.reciteCount > 0)) || lp.summary));
    }

    const snap = buildGlobalProgressSnapshot();
    if (dom.globalStatsLine) {
      dom.globalStatsLine.textContent = snap.statsLine;
    }
    const lp = getLearningProfile();
    if (dom.globalProfileInput && document.activeElement !== dom.globalProfileInput) {
      dom.globalProfileInput.value = lp.summary || '';
    }
    if (dom.globalProfileMeta) {
      if (lp.updatedAt > 0) {
        const dt = new Date(lp.updatedAt);
        const hh = String(dt.getHours()).padStart(2, '0');
        const mm = String(dt.getMinutes()).padStart(2, '0');
        dom.globalProfileMeta.textContent = `更新于 ${dt.getMonth() + 1}/${dt.getDate()} ${hh}:${mm}`;
      } else {
        dom.globalProfileMeta.textContent = '尚未提炼画像';
      }
    }
  }

  function setReciteViewMode() {}

  function updateScopeHeaderUI() {
    const ctx = getScopeContext();
    const cfg = getSyncConfig();
    if (dom.drawerModelBadge) {
      dom.drawerModelBadge.textContent = cfg.model;
    }
    if (dom.effortSeg) {
      dom.effortSeg.querySelectorAll('.ai-effort-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.effort === cfg.effort);
      });
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

  function setMemoryBoxOpen(open) {
    if (!dom.memoryBox) return;
    const isOpen = Boolean(open);
    dom.memoryBox.style.display = isOpen ? 'block' : 'none';
    if (dom.memoryToggleBtn) {
      dom.memoryToggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }
  }

  function setAskSendBtnStreaming(streaming) {
    if (!dom.askSendBtn) return;
    const isActive = Boolean(streaming);
    dom.askSendBtn.disabled = false;
    dom.askSendBtn.classList.toggle('is-streaming', isActive);
    dom.askSendBtn.textContent = isActive ? '停止' : '发送';
    dom.askSendBtn.setAttribute('aria-label', isActive ? '停止生成' : '发送');
    dom.askSendBtn.title = isActive ? '点击停止生成' : '发送 (Enter)';
  }

  function abortActiveStream({ markStopped = true } = {}) {
    if (aiState.abortController) {
      const ctrl = aiState.abortController;
      aiState.abortController = null;
      try { ctrl.abort(); } catch (e) {}
    }
    aiState.isStreaming = false;
    setAskSendBtnStreaming(false);

    let changed = false;
    for (const [, thread] of aiState.chatThreads.entries()) {
      if (Array.isArray(thread) && thread.length > 0) {
        const last = thread[thread.length - 1];
        if (last && last.role === 'assistant') {
          if (last.toolStatus) {
            last.toolStatus = '';
            changed = true;
          }
          if (!last.content && !last.reasoning) {
            thread.pop();
            changed = true;
          } else if (markStopped && last === aiState._activeAssistantMsg) {
            if (last.content && !last.content.endsWith('（已停止生成）')) {
              last.content = `${last.content.trimEnd()}\n\n（已停止生成）`;
              changed = true;
            } else if (!last.content && last.reasoning) {
              last.content = '（已停止生成）';
              changed = true;
            }
          }
        }
      }
    }
    aiState._activeAssistantMsg = null;
    aiState._activeScopeKey = '';
    if (changed) {
      persistChatThreadsToStorage();
      if (aiState.isOpen) renderChatStream();
    }
  }

  function openAiDrawer({ cardEl = null, quote = '', tab = null } = {}) {
    if (!dom.drawer || !dom.backdrop) return;
    hideSelectionPill();

    const prevCardEl = aiState.scopedCardEl;
    if (cardEl) {
      if (prevCardEl && prevCardEl !== cardEl) {
        abortActiveStream();
        if (!quote) aiState.quotedText = '';
      }
      aiState.scopedCardEl = cardEl;
      aiState.scopedCardLabel = extractCardLabel(cardEl);
      aiState.scopedCardText = extractCleanTextFromElement(cardEl);
      aiState.scopedSentences = collectScopedSentences(cardEl);
    } else {
      if (prevCardEl) {
        abortActiveStream();
        if (!quote) aiState.quotedText = '';
      }
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
    dom.drawer.classList.add('open');
    dom.backdrop.classList.add('open');
    dom.drawer.setAttribute('aria-hidden', 'false');

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
    setMemoryBoxOpen(false);
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
          bestIdx = typeof s.idx === 'number' ? s.idx : -1;
        }
      }
    });
    return bestIdx;
  }

  function findMatchingSentenceForQuote(combinedQuote, rawLines, primarySentences, fallbackSentences) {
    const pools = [];
    if (Array.isArray(primarySentences) && primarySentences.length > 0) pools.push(primarySentences);
    if (Array.isArray(fallbackSentences) && fallbackSentences.length > 0 && fallbackSentences !== primarySentences) {
      pools.push(fallbackSentences);
    }
    const candidates = [combinedQuote, ...(Array.isArray(rawLines) ? rawLines : [])]
      .map(s => String(s || '').trim())
      .filter(Boolean);

    for (const pool of pools) {
      for (const cand of candidates) {
        const idx = findSentenceIndexByQuote(cand, pool);
        if (idx >= 0) {
          const found = pool.find(s => s.idx === idx);
          return { idx, start: found ? found.start : undefined };
        }
      }
    }
    return null;
  }

  function renderAiMarkdown(rawMarkdown, sentences = []) {
    // 1. 剥离 [CARD_SUMMARY]...[/CARD_SUMMARY] 并在底部渲染为归档卡片
    let summaryText = '';
    let cleaned = String(rawMarkdown || '')
      .replace(/\[CARD_SUMMARY\]([\s\S]*?)(?:\[\/CARD_SUMMARY\]|$)/g, (_, inner) => {
        summaryText = (inner || '').trim();
        return '';
      })
      .replace(/\s*\[SENT:\d+\]/g, '')
      .trim();

    const b = getBridge();
    const rawBridgeSents = (b && typeof b.getActiveSentences === 'function') ? (b.getActiveSentences() || []) : [];
    const fallbackSentences = rawBridgeSents.map((s, i) => ({
      idx: typeof s.idx === 'number' ? s.idx : i,
      start: s.start,
      text: s.text || ''
    }));
    const primarySentences = (Array.isArray(sentences) && sentences.length > 0) ? sentences : fallbackSentences;

    const formatInline = (line) => {
      let html = escapeHtml(line);
      const itemTokens = [];
      html = html.replace(/\[\[item:([^|\]]+)\|([^\]]+)\]\]/g, (_, rawId, rawTitle) => {
        const cleanId = rawId.trim();
        const cleanTitle = rawTitle.trim() || cleanId;
        if (!cleanId) return cleanTitle;
        const token = `@@AI_ITEM_${itemTokens.length}@@`;
        itemTokens.push(
          `<button type="button" class="ai-item-jump" data-item-id="${cleanId}" title="跳转到：${cleanTitle}"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-flex;vertical-align:-1px;margin-right:3px;"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>${cleanTitle}</button>`
        );
        return token;
      });
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      itemTokens.forEach((pillHtml, idx) => {
        html = html.split(`@@AI_ITEM_${idx}@@`).join(pillHtml);
      });
      return html;
    };

    const parseTableRow = (rowLine) => {
      return rowLine.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    };
    const isTableSep = (rowLine) => {
      const cells = parseTableRow(rowLine);
      return cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c));
    };

    const renderMarkdownCore = (text, allowFolds) => {
      const foldBlocks = [];
      let working = String(text || '');
      if (allowFolds) {
        working = working.replace(/<details(?:\s+class=["'][^"']*["'])?\s*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi, (_, sumText, bodyText) => {
          const idx = foldBlocks.length;
          foldBlocks.push({
            summary: String(sumText || '').trim() || '点击展开提示',
            body: String(bodyText || '').trim()
          });
          return `\n@@AI_FOLD_${idx}@@\n`;
        });
        working = working.replace(/^[ \t]*:::fold(?:[ \t]+([^\r\n]*))?\r?\n([\s\S]*?)\r?\n[ \t]*:::[ \t]*$/gm, (_, sumText, bodyText) => {
          const idx = foldBlocks.length;
          foldBlocks.push({
            summary: String(sumText || '').trim() || '点击展开提示',
            body: String(bodyText || '').trim()
          });
          return `\n@@AI_FOLD_${idx}@@\n`;
        });
      }

      const lines = working.split(/\r?\n/);
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

        const foldMatch = allowFolds ? line.trim().match(/^@@AI_FOLD_(\d+)@@$/) : null;
        if (foldMatch) {
          closeList();
          const block = foldBlocks[Number(foldMatch[1])];
          if (block) {
            out.push(
              `<details class="ai-fold"><summary>${formatInline(block.summary)}</summary><div class="ai-fold-body">${renderMarkdownCore(block.body, false)}</div></details>`
            );
          }
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

        // 引用块支持：> 原文摘录（自动匹配原句并附带跳听按钮）
        const bqMatch = line.match(/^\s*>\s?(.*)$/);
        if (bqMatch) {
          closeList();
          const rawQuoteLines = [bqMatch[1]];
          const quoteLines = [formatInline(bqMatch[1])];
          while (i + 1 < lines.length && /^\s*>\s?/.test(lines[i + 1])) {
            i++;
            const nextRaw = lines[i].replace(/^\s*>\s?/, '');
            rawQuoteLines.push(nextRaw);
            quoteLines.push(formatInline(nextRaw));
          }
          const matchedSent = findMatchingSentenceForQuote(
            rawQuoteLines.join(' ').trim(),
            rawQuoteLines,
            primarySentences,
            fallbackSentences
          );
          const jumpHtml = matchedSent
            ? ` <button type="button" class="ai-quote-jump" data-sent-idx="${matchedSent.idx}" data-sent-start="${matchedSent.start !== undefined && matchedSent.start !== null ? escapeHtml(String(matchedSent.start)) : ''}" title="点击跳转并播放该句音频"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-flex;vertical-align:-1px;margin-right:3px;"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>跳听</button>`
            : '';
          out.push(`<blockquote class="ai-md-quote">${quoteLines.join('<br>')}${jumpHtml}</blockquote>`);
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
      return out.join('');
    };

    const htmlParts = [renderMarkdownCore(cleaned, true)];

    if (summaryText) {
      htmlParts.push(`
        <div class="ai-summary-archived-card">
          <div class="ai-summary-archived-tag">已自动归档本题卡点记忆</div>
          <div class="ai-summary-archived-text">${escapeHtml(summaryText)}</div>
        </div>
      `);
    }

    return htmlParts.join('');
  }

  // ==========================================
  // 6. DeepSeek 流式请求封装 (VPS 代理 / BYOK 兜底 + Tools / JSON)
  // ==========================================
  function isValidSyncUrl(url) {
    const u = String(url || '').trim();
    if (!u) return false;
    if (/^https:\/\//i.test(u)) return true;
    return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(u);
  }

  function mapModelForDirectDeepSeek(modelName) {
    const norm = normalizeAiModel(modelName);
    return norm === 'deepseek-v4-pro' ? 'deepseek-reasoner' : 'deepseek-chat';
  }

  function resolveDefaultMaxTokens(activeModel, activeEffort, explicitMaxTokens) {
    if (typeof explicitMaxTokens === 'number' && explicitMaxTokens > 0) {
      return explicitMaxTokens;
    }
    if (activeModel === 'deepseek-v4-pro' || activeEffort === 'max') {
      return 8192;
    }
    return 4096;
  }

  async function streamDeepSeek({
    messages,
    temperature = 0.4,
    maxTokens = null,
    modelOverride = null,
    effort = null,
    background = false,
    responseFormat = null,
    tools = null,
    toolChoice = null,
    stream = true,
    manageStreamUi = true,
    onDelta
  }) {
    const cfg = getSyncConfig();
    if (!background && aiState.abortController) {
      try { aiState.abortController.abort(); } catch (e) {}
    }
    const controller = new AbortController();
    if (!background) {
      aiState.abortController = controller;
      aiState.isStreaming = true;
      if (manageStreamUi) setAskSendBtnStreaming(true);
    }

    const hasProxy = isSyncConfigured(cfg);
    const hasDirectKey = Boolean(cfg.deepseekKey);
    if (!hasProxy && !hasDirectKey) {
      if (!background) {
        aiState.isStreaming = false;
        if (manageStreamUi) setAskSendBtnStreaming(false);
      }
      throw new Error('NO_AUTH_CONFIGURED');
    }

    const activeModel = modelOverride ? normalizeAiModel(modelOverride) : cfg.model;
    const activeEffort = normalizeReasoningEffort(effort || cfg.effort);
    const resolvedMaxTokens = resolveDefaultMaxTokens(activeModel, activeEffort, maxTokens);
    const isDeepThinking = (activeModel === 'deepseek-v4-pro' || activeEffort === 'max');
    const firstByteTimeoutMs = isDeepThinking ? 90000 : 60000;
    const streamIdleTimeoutMs = isDeepThinking ? 90000 : 60000;

    const buildRequestForMode = (useDirect) => {
      const ep = useDirect ? 'https://api.deepseek.com/chat/completions' : `${cfg.url}/api/ai/chat`;
      const hdrs = { 'Content-Type': 'application/json' };
      if (useDirect) {
        hdrs['Authorization'] = `Bearer ${cfg.deepseekKey}`;
      } else {
        if (!isValidSyncUrl(cfg.url)) {
          throw new Error('同步服务地址须以 https:// 开头（本地 127.0.0.1/localhost 除外），已拦截明文传输个人 Key');
        }
        hdrs['X-Sync-Pin'] = cfg.pin;
        if (cfg.deepseekKey) hdrs['X-Deepseek-Key'] = cfg.deepseekKey;
      }
      const wireModel = useDirect ? mapModelForDirectDeepSeek(activeModel) : activeModel;
      const reqBody = {
        model: wireModel,
        messages,
        stream: Boolean(stream),
        max_tokens: resolvedMaxTokens
      };
      if (!useDirect) {
        reqBody.reasoning_effort = activeEffort;
      }
      if (wireModel !== 'deepseek-reasoner') {
        reqBody.temperature = temperature;
      }
      if (responseFormat && typeof responseFormat === 'object') {
        reqBody.response_format = responseFormat;
      }
      if (Array.isArray(tools) && tools.length > 0) {
        reqBody.tools = tools;
        if (toolChoice !== null && toolChoice !== undefined) {
          reqBody.tool_choice = toolChoice;
        }
      }
      return { ep, hdrs, reqBody };
    };

    let timedOutReason = '';
    let firstByteTimer = null;
    const resetFirstByteTimer = () => {
      if (firstByteTimer) clearTimeout(firstByteTimer);
      firstByteTimer = setTimeout(() => {
        timedOutReason = '请求连接超时，请检查网络或服务状态';
        try { controller.abort(); } catch (e) {}
      }, firstByteTimeoutMs);
    };
    resetFirstByteTimer();
    try {
      let res = null;
      const preferProxy = hasProxy;
      const primaryReq = buildRequestForMode(!preferProxy);
      try {
        res = await fetch(primaryReq.ep, {
          method: 'POST',
          headers: primaryReq.hdrs,
          body: JSON.stringify(primaryReq.reqBody),
          signal: controller.signal
        });
        if (preferProxy && hasDirectKey && res.status >= 500 && !controller.signal.aborted) {
          resetFirstByteTimer();
          const directReq = buildRequestForMode(true);
          res = await fetch(directReq.ep, {
            method: 'POST',
            headers: directReq.hdrs,
            body: JSON.stringify(directReq.reqBody),
            signal: controller.signal
          });
        }
      } catch (fetchErr) {
        if (preferProxy && hasDirectKey && !controller.signal.aborted && (!fetchErr || fetchErr.name !== 'AbortError')) {
          resetFirstByteTimer();
          const directReq = buildRequestForMode(true);
          res = await fetch(directReq.ep, {
            method: 'POST',
            headers: directReq.hdrs,
            body: JSON.stringify(directReq.reqBody),
            signal: controller.signal
          });
        } else {
          throw fetchErr;
        }
      }
      clearTimeout(firstByteTimer);
      firstByteTimer = null;

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

      // 非流式 JSON 兼容（增加读体超时）
      if (contentType.includes('application/json') || !stream) {
        let jsonTimer = null;
        const data = await Promise.race([
          res.json().finally(() => {
            if (jsonTimer) { clearTimeout(jsonTimer); jsonTimer = null; }
          }),
          new Promise((_, reject) => {
            jsonTimer = setTimeout(() => {
              try { controller.abort(); } catch (e) {}
              reject(new Error('响应正文读取超时，请稍后重试'));
            }, 35000);
          })
        ]);
        if (data && data.ok === false) {
          throw new Error(data.message || data.error || '服务端返回异常');
        }
        const choice = data && data.choices && data.choices[0];
        const msgObj = choice && choice.message;
        const fullContent = (msgObj && msgObj.content) || '';
        const fullReasoning = (msgObj && msgObj.reasoning_content) || '';
        const toolCalls = Array.isArray(msgObj && msgObj.tool_calls) ? msgObj.tool_calls : [];
        const finishReason = (choice && choice.finish_reason) || '';
        const usage = (data && data.usage) || null;
        if (!background && usage) {
          aiState.lastCacheUsage = usage;
          updateCacheBadgeUI(usage);
        }
        if (typeof onDelta === 'function') {
          onDelta({ content: fullContent, reasoning: fullReasoning, toolCalls, finishReason, usage, done: true });
        }
        return { content: fullContent, reasoning: fullReasoning, toolCalls, finishReason, usage };
      }

      if (!res.body || !res.body.getReader) {
        throw new Error('当前浏览器不支持流式读取响应');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let fullContent = '';
      let fullReasoning = '';
      let usageData = null;
      let finishReason = '';
      let sawStreamEndMarker = false;
      const toolCallsMap = new Map();

      const buildToolCallsArray = () => {
        if (toolCallsMap.size === 0) return [];
        return Array.from(toolCallsMap.entries())
          .sort((a, b2) => a[0] - b2[0])
          .map(([, entry]) => ({
            id: entry.id,
            type: entry.type || 'function',
            function: {
              name: entry.function.name,
              arguments: entry.function.arguments
            }
          }));
      };

      const processSseLine = (rawLine) => {
        const line = rawLine.trim();
        if (!line || !line.startsWith('data:')) return;
        const payloadStr = line.slice(5).trim();
        if (payloadStr === '[DONE]') {
          sawStreamEndMarker = true;
          return;
        }
        try {
          const parsed = JSON.parse(payloadStr);
          if (parsed && parsed.usage) usageData = parsed.usage;
          const choice = parsed && parsed.choices && parsed.choices[0];
          if (choice && choice.finish_reason) {
            finishReason = choice.finish_reason;
            sawStreamEndMarker = true;
          }
          const delta = choice && choice.delta;
          if (delta) {
            if (delta.reasoning_content) fullReasoning += delta.reasoning_content;
            if (delta.content) fullContent += delta.content;
            if (Array.isArray(delta.tool_calls)) {
              delta.tool_calls.forEach((tc, pos) => {
                const tcIdx = typeof tc.index === 'number' ? tc.index : pos;
                if (!toolCallsMap.has(tcIdx)) {
                  toolCallsMap.set(tcIdx, {
                    id: tc.id || '',
                    type: tc.type || 'function',
                    function: { name: '', arguments: '' }
                  });
                }
                const entry = toolCallsMap.get(tcIdx);
                if (tc.id) entry.id = tc.id;
                if (tc.type) entry.type = tc.type;
                if (tc.function) {
                  if (typeof tc.function.name === 'string' && tc.function.name) {
                    if (!entry.function.name) {
                      entry.function.name = tc.function.name;
                    } else if (entry.function.name !== tc.function.name) {
                      entry.function.name += tc.function.name;
                    }
                  }
                  if (typeof tc.function.arguments === 'string') {
                    entry.function.arguments += tc.function.arguments;
                  }
                }
              });
            }
            if (typeof onDelta === 'function') {
              onDelta({
                content: fullContent,
                reasoning: fullReasoning,
                toolCalls: buildToolCallsArray(),
                finishReason,
                usage: usageData,
                done: false
              });
            }
          }
        } catch (e) {
          // 忽略半包行或心跳注释
        }
      };

      while (true) {
        let idleTimer = null;
        let stepTimedOut = false;
        const { done, value } = await Promise.race([
          reader.read().finally(() => {
            if (idleTimer) {
              clearTimeout(idleTimer);
              idleTimer = null;
            }
          }),
          new Promise((_, reject) => {
            idleTimer = setTimeout(() => {
              stepTimedOut = true;
              try { controller.abort(); } catch (e) {}
              reject(new Error('流式响应超时，请稍后重试'));
            }, streamIdleTimeoutMs);
          })
        ]);
        if (stepTimedOut) break;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const rawLine of lines) {
          processSseLine(rawLine);
        }
      }

      // 冲刷流末尾残余 UTF-8 字节与未以换行结尾的 SSE 尾包，防止丢失末段内容或 finish_reason
      buffer += decoder.decode();
      if (buffer.trim()) {
        for (const tailLine of buffer.split(/\r?\n/)) {
          processSseLine(tailLine);
        }
        buffer = '';
      }

      const finalToolCalls = buildToolCallsArray();
      if (!sawStreamEndMarker && finalToolCalls.length === 0) {
        if (!fullContent && !fullReasoning) {
          throw new Error('流式响应意外中断，未收到有效内容');
        }
        fullContent = `${fullContent.trimEnd()}\n\n（连接提前中断，内容可能不完整）`;
      }
      if (!background && usageData) {
        aiState.lastCacheUsage = usageData;
        updateCacheBadgeUI(usageData);
      }
      if (typeof onDelta === 'function') {
        onDelta({
          content: fullContent,
          reasoning: fullReasoning,
          toolCalls: finalToolCalls,
          finishReason,
          usage: usageData,
          done: true
        });
      }
      return {
        content: fullContent,
        reasoning: fullReasoning,
        toolCalls: finalToolCalls,
        finishReason,
        usage: usageData
      };
    } finally {
      if (firstByteTimer) {
        clearTimeout(firstByteTimer);
        firstByteTimer = null;
      }
      if (!background) {
        if (aiState.abortController === controller) {
          aiState.abortController = null;
        }
        if (manageStreamUi) {
          aiState.isStreaming = false;
          setAskSendBtnStreaming(false);
        }
      }
      if (timedOutReason && !background) {
        console.warn('Stream timed out:', timedOutReason);
      }
    }
  }

  const AI_CLIENT_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'search_knowledge_base',
        description: '检索全科考研背诵题库（807 现当代文学、706 古代文学、考研政治、考研英语写作）中的相关篇目与原文片段，用于跨篇/跨科串联对比与精准引用。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '检索关键词（多个词可用空格分隔，如 "鲁迅 呐喊" 或 "红楼梦 悲剧"）'
            },
            subject: {
              type: 'string',
              enum: ['all', '807', '706', 'pol', 'en'],
              description: '限定科目，默认 all'
            }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_weak_items',
        description: '获取当前薄弱或高优先级的未掌握考点列表（综合考纲等级、掌握状态、听读次数），用于规划复盘重点与今日作战简报。',
        parameters: {
          type: 'object',
          properties: {
            subject: {
              type: 'string',
              enum: ['all', '807', '706', 'pol', 'en'],
              description: '限定科目，默认 all'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_learning_profile',
        description: '读取用户 Layer 2 长期学习认知画像及 Layer 3 相关跨篇历史卡点记忆档案。',
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    }
  ];

  function parseToolArgumentsSafe(rawArgs) {
    if (rawArgs && typeof rawArgs === 'object') return rawArgs;
    const text = String(rawArgs || '').trim();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function executeClientTool(toolName, rawArgs, ctx) {
    const b = getBridge();
    const args = parseToolArgumentsSafe(rawArgs);

    if (toolName === 'search_knowledge_base') {
      const query = String(args.query || '').trim();
      const subject = String(args.subject || 'all').trim() || 'all';
      if (b && typeof b.searchKnowledgeBase === 'function') {
        const hits = b.searchKnowledgeBase(query, subject, 6) || [];
        return {
          statusText: `检索题库「${query || subject}」(${hits.length} 条)`,
          result: JSON.stringify({ query, subject, results: hits })
        };
      }
      const all = (b && typeof b.getAllStudyItems === 'function') ? b.getAllStudyItems() : [];
      const kw = query.toLowerCase();
      const fallbackHits = all
        .filter(it => (subject === 'all' || it.subject === subject) && (!kw || `${it.title} ${it.category}`.toLowerCase().includes(kw)))
        .slice(0, 6);
      return {
        statusText: `检索题库「${query || subject}」(${fallbackHits.length} 条)`,
        result: JSON.stringify({ query, subject, results: fallbackHits })
      };
    }

    if (toolName === 'get_weak_items') {
      const subject = String(args.subject || 'all').trim() || 'all';
      if (b && typeof b.getWeakItems === 'function') {
        const weak = b.getWeakItems(subject, 8) || [];
        return {
          statusText: `排查薄弱考点 (${weak.length} 项)`,
          result: JSON.stringify({ subject, items: weak })
        };
      }
      const all = (b && typeof b.getAllStudyItems === 'function') ? b.getAllStudyItems() : [];
      const fallbackWeak = all
        .filter(it => (subject === 'all' || it.subject === subject) && it.status !== 'mastered')
        .slice(0, 8);
      return {
        statusText: `排查薄弱考点 (${fallbackWeak.length} 项)`,
        result: JSON.stringify({ subject, items: fallbackWeak })
      };
    }

    if (toolName === 'get_learning_profile') {
      const lp = getLearningProfile();
      const allMem = getAiMemories();
      const titleById = new Map();
      if (b && typeof b.getAllStudyItems === 'function') {
        b.getAllStudyItems().forEach(it => titleById.set(it.id, it.title));
      }
      const recentMemories = Object.entries(allMem)
        .map(([id, raw]) => ({ id, title: titleById.get(id) || id, ...normalizeMemoryEntry(raw) }))
        .filter(x => x && x.summary)
        .sort((a, b2) => (b2.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 6);
      const crossMemories = ctx ? recallRelevantCrossMemories(ctx, '') : [];
      return {
        statusText: '读取学习画像与卡点档案',
        result: JSON.stringify({
          learningProfile: lp,
          recentMemories,
          crossMemories
        })
      };
    }

    return {
      statusText: `未知工具 ${toolName}`,
      result: JSON.stringify({ error: `Unsupported tool: ${toolName}` })
    };
  }

  async function runDeepSeekWithTools({
    messages,
    temperature = 0.45,
    maxTokens = null,
    modelOverride = null,
    effort = null,
    tools = AI_CLIENT_TOOLS,
    toolChoice = 'auto',
    maxRounds = 3,
    ctx = null,
    onDelta,
    onToolStatus
  }) {
    const loopMessages = Array.isArray(messages) ? messages.slice() : [];
    aiState.isStreaming = true;
    setAskSendBtnStreaming(true);

    const roundToolExchange = [];
    try {
      for (let round = 0; round <= maxRounds; round++) {
        const allowTools = round < maxRounds && Array.isArray(tools) && tools.length > 0;
        const roundRes = await streamDeepSeek({
          messages: loopMessages,
          temperature,
          maxTokens,
          modelOverride,
          effort,
          tools: allowTools ? tools : undefined,
          toolChoice: allowTools ? toolChoice : undefined,
          manageStreamUi: false,
          onDelta: (deltaObj) => {
            if (typeof onDelta === 'function') {
              onDelta(deltaObj);
            }
          }
        });

        const requestedTools = Array.isArray(roundRes.toolCalls) ? roundRes.toolCalls : [];
        const wantsToolLoop = allowTools && requestedTools.length > 0 && roundRes.finishReason !== 'length' && (roundRes.finishReason === 'tool_calls' || !roundRes.content);

        if (!wantsToolLoop) {
          if (typeof onToolStatus === 'function') onToolStatus('', true);
          return { ...roundRes, toolExchange: roundToolExchange };
        }

        // 记录助手发起的 tool_calls 轮次
        const assistantToolMsg = {
          role: 'assistant',
          content: roundRes.content || '',
          tool_calls: requestedTools.map((tc, idx) => ({
            id: tc.id || `call_${round}_${idx}`,
            type: 'function',
            function: {
              name: tc.function ? tc.function.name : '',
              arguments: tc.function ? tc.function.arguments : '{}'
            }
          }))
        };
        if (roundRes.reasoning) {
          assistantToolMsg.reasoning_content = roundRes.reasoning;
        }
        loopMessages.push(assistantToolMsg);
        roundToolExchange.push(assistantToolMsg);

        for (let i = 0; i < assistantToolMsg.tool_calls.length; i++) {
          if (!aiState.isStreaming) {
            const abortErr = new Error('Aborted');
            abortErr.name = 'AbortError';
            throw abortErr;
          }
          const tc = assistantToolMsg.tool_calls[i];
          const fnName = tc.function.name;
          if (typeof onToolStatus === 'function') {
            onToolStatus(`正在调用 ${fnName}…`, false);
          }
          const exec = executeClientTool(fnName, tc.function.arguments, ctx);
          if (typeof onToolStatus === 'function') {
            onToolStatus(exec.statusText, false);
          }
          const toolReplyMsg = {
            role: 'tool',
            tool_call_id: tc.id,
            content: exec.result
          };
          loopMessages.push(toolReplyMsg);
          roundToolExchange.push(toolReplyMsg);
        }
      }

      if (typeof onToolStatus === 'function') onToolStatus('', true);
      return { content: '', reasoning: '', toolCalls: [], finishReason: 'stop', usage: null, toolExchange: roundToolExchange };
    } finally {
      aiState.isStreaming = false;
      aiState.abortController = null;
      setAskSendBtnStreaming(false);
    }
  }

  // ==========================================
  // 7. AI 伴学答疑 & 三层全局长久记忆
  // ==========================================
  const AI_STATIC_SYSTEM_PREFIX = [
    '你是「2027 考研全科双轨背诵手卷」的专属高分研学助教，精通文学考研（807 现当代文学、706 中国古代文学）、考研政治与考研英语写作。',
    '核心工作原则：',
    '1. 紧扣下方【当前科目标题与参考原文】及考纲采分点作答，语言凝练精准、逻辑层次分明，绝不输出空泛套话或无依据的臆测。',
    '2. 遇到多流派、多作家、多理论或跨专题概念辨析时，优先使用清晰的 Markdown 对比表格呈现；需要引导用户回听音频原句时，务必单独成行使用 `> 原句` 引用块摘录原文（前端会自动渲染跳听按钮），严禁输出音频时间戳或 `[SENT]` 标记。',
    '3. 引用或串联其他考研篇目时，请使用 `[[item:ITEM_ID|标题]]` 格式标注以便一键跳转；需要给出可自测的答题提示、变式参考答案或采分点解析时，使用 `<details class="ai-fold"><summary>点击展开解析/提示</summary>...</details>` 折叠呈现。',
    '4. 每题尽量凝练「考场答题骨架（关键词链）」或「不超过 50 字的顺口溜/记忆口诀」；如需跨科/跨篇检索题库或核对薄弱考点，可主动调用可用工具（search_knowledge_base / get_weak_items / get_learning_profile）。',
    '5. 请结合系统末尾注入的【三层全局记忆与当前动态状态】（全站实时复习进度、长期认知画像、跨篇历史卡点）：若当前篇目涉及顽固未掌握点或零遍高优盲区，请主动给出避坑提醒。'
  ].join('\n');

  function getTodayLocalStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function buildGlobalProgressSnapshot() {
    const b = getBridge();
    const allItems = (b && typeof b.getAllStudyItems === 'function') ? b.getAllStudyItems() : [];
    const logs = (b && typeof b.getStudyLogs === 'function') ? b.getStudyLogs() : {};
    const subjNames = { '807': '807现当代', '706': '706古代', 'pol': '政治', 'en': '英语' };
    const subjStats = { '807': { t: 0, m: 0, f: 0 }, '706': { t: 0, m: 0, f: 0 }, 'pol': { t: 0, m: 0, f: 0 }, 'en': { t: 0, m: 0, f: 0 } };
    const priorityBlind = [];
    const stubbornItems = [];

    allItems.forEach((it) => {
      const s = subjStats[it.subject];
      if (s) {
        s.t++;
        if (it.status === 'mastered') s.m++;
        else if (it.status === 'familiar') s.f++;
      }
      if ((it.level === 'T0' || it.level === 'T1') && it.status === 'unlearned' && it.listenCount === 0) {
        priorityBlind.push(it.title);
      } else if (it.status !== 'mastered' && it.listenCount >= 2) {
        stubbornItems.push(it);
      }
    });

    stubbornItems.sort((a, b2) => b2.listenCount - a.listenCount);
    const todayMin = Math.floor(Math.max(0, Number(logs?.dailyListenSec?.[getTodayLocalStr()]) || 0) / 60);
    const totalMin = Math.floor(Math.max(0, Number(logs?.totalListenSec) || 0) / 60);
    const memCount = Object.keys(getAiMemories()).length;
    const progParts = Object.entries(subjStats)
      .filter(([, st]) => st.t > 0)
      .map(([k, st]) => `${subjNames[k]} ${st.m}/${st.t}(熟${st.f})`);

    const lines = [
      `全科掌握：${progParts.join(' · ') || '加载中'}；今日精听 ${todayMin}m，累计 ${totalMin}m，笔记 ${memCount} 篇。`
    ];
    if (stubbornItems.length > 0) {
      lines.push(`高频待破（听>=2遍未掌握）：${stubbornItems.slice(0, 5).map(x => `${x.title}(${x.listenCount}遍)`).join('、')}`);
    }
    if (priorityBlind.length > 0) {
      lines.push(`T0/T1零遍盲区示例(${priorityBlind.length}题)：${priorityBlind.slice(0, 5).join('、')}`);
    }
    const statsLine = `各科：${progParts.join(' | ') || '暂无'} · 今日 ${todayMin}分钟`;
    return { promptBlock: lines.join('\n'), statsLine, stubbornItems, priorityBlind, allItems };
  }

  function extractRecallTokens(text) {
    const raw = String(text || '').trim();
    const tokens = new Set();
    const asciiMatches = raw.match(/[A-Za-z0-9]{3,}/g) || [];
    asciiMatches.forEach(w => tokens.add(w.toLowerCase()));
    const cjkRuns = raw.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    const stopSet = new Set(['什么', '如何', '怎么', '哪些', '为什么', '对比', '分析', '简述', '论述', '考题', '背诵', '当前', '范围', '原文', '记忆', '口诀', '表格', '一下', '这个', '那个']);
    cjkRuns.forEach((run) => {
      if (run.length <= 4 && !stopSet.has(run)) tokens.add(run);
      for (let i = 0; i + 2 <= run.length && tokens.size < 28; i++) {
        const bi = run.slice(i, i + 2);
        if (!stopSet.has(bi)) tokens.add(bi);
      }
    });
    return Array.from(tokens).slice(0, 24);
  }

  function recallRelevantCrossMemories(ctx, userQuery = '') {
    const memories = getAiMemories();
    const tokens = extractRecallTokens(`${ctx.itemTitle} ${userQuery}`);
    if (tokens.length === 0) return [];
    const b = getBridge();
    const titleById = new Map();
    if (b && typeof b.getAllStudyItems === 'function') {
      b.getAllStudyItems().forEach(it => titleById.set(it.id, it.title));
    }
    const scored = [];
    Object.entries(memories).forEach(([id, rawMem]) => {
      if (id === ctx.itemId) return;
      const mem = normalizeMemoryEntry(rawMem);
      if (!mem || !mem.summary) return;
      const title = titleById.get(id) || id;
      const hay = `${title} ${mem.summary}`.toLowerCase();
      let hits = 0;
      tokens.forEach(tk => {
        if (hay.includes(tk)) hits += tk.length >= 3 ? 2 : 1;
      });
      if (hits >= 2) {
        scored.push({ id, title, summary: mem.summary, hits, updatedAt: mem.updatedAt || 0 });
      }
    });
    scored.sort((a, b2) => b2.hits - a.hits || b2.updatedAt - a.updatedAt);
    return scored.slice(0, 2);
  }

  function buildAskSystemPrompt(ctx, userQuery = '') {
    const memories = getAiMemories();
    const mem = normalizeMemoryEntry(memories[ctx.itemId]);
    const lp = getLearningProfile();
    const snap = buildGlobalProgressSnapshot();
    const crossList = recallRelevantCrossMemories(ctx, userQuery);

    const dynamicParts = [];
    if (mem && mem.summary) {
      dynamicParts.push(`- 本题历史卡点记忆：${mem.summary}`);
    }
    if (lp.summary) {
      dynamicParts.push(`- 用户长期学习画像：${lp.summary}`);
    }
    if (snap.promptBlock) {
      dynamicParts.push(`- 全站实时复习快照：\n${snap.promptBlock}`);
    }
    if (crossList.length > 0) {
      dynamicParts.push(`- 跨篇关联卡点召回：\n${crossList.map(c => `  * [${c.title}] ${c.summary}`).join('\n')}`);
    }

    const fullText = ctx.fullRefText || ctx.refText || '';
    const focusLines = [`- 聚焦范围：${ctx.blockId}`];
    if (ctx.blockId && ctx.blockId !== 'FULL_ITEM' && ctx.focusedCardText) {
      focusLines.push(`- 子卡片摘录：\n${ctx.focusedCardText}`);
    }
    const focusSection = `\n\n【当前聚焦子卡片】\n${focusLines.join('\n')}`;

    const tailSection = dynamicParts.length > 0
      ? `\n\n【三层全局记忆与当前动态状态】\n${dynamicParts.join('\n')}`
      : '';

    return `${AI_STATIC_SYSTEM_PREFIX}

【当前科目标题与参考原文】
- 科目：${ctx.subjectLabel}
- 考题：${ctx.itemTitle}（ID: ${ctx.itemId}，轨道 ${ctx.track}）
- 完整参考原文：
${fullText}${focusSection}${tailSection}`;
  }

  function trimHistoryForCache(msgs) {
    if (!Array.isArray(msgs) || msgs.length <= 18) return msgs || [];
    let dropCount = Math.floor((msgs.length - 12) / 6) * 6;
    while (dropCount < msgs.length && msgs[dropCount] && msgs[dropCount].role !== 'user') {
      dropCount++;
    }
    return msgs.slice(dropCount);
  }

  async function distillLearningProfile({ manual = false } = {}) {
    if (aiState.isDistilling) {
      if (manual) showToast('正在提炼全站档案，请稍候...', 1600);
      return false;
    }
    const cfg = getSyncConfig();
    if (!isSyncConfigured(cfg) && !cfg.deepseekKey) {
      if (manual) showToast('请先配置 Sync PIN 或 DeepSeek Key', 2000);
      return false;
    }

    aiState.isDistilling = true;
    aiState.lastAutoDistillAt = Date.now();
    if (dom.distillProfileBtn) {
      dom.distillProfileBtn.disabled = true;
      dom.distillProfileBtn.textContent = '提炼中...';
    }
    try {
      const snap = buildGlobalProgressSnapshot();
      const memEntries = Object.entries(getAiMemories())
        .map(([id, raw]) => ({ id, ...normalizeMemoryEntry(raw) }))
        .filter(x => x && x.summary)
        .sort((a, b2) => (b2.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 10);
      const recentQuestions = [];
      for (const [, th] of aiState.chatThreads.entries()) {
        (th || []).forEach(m => {
          if (m.role === 'user' && m.content) recentQuestions.push(m.content.slice(0, 80));
        });
      }
      const curProfile = getLearningProfile();
      const prompt = [
        '请基于以下考研背诵数据，为用户提炼一份「全站长期学习认知画像」（纯文本，严格控制在 240 字以内，不要套话，分 3 行简洁总结：1.学科进度短板与高优先盲区；2.高频卡点/易混淆知识模式；3.后续AI讲解应优先采用的策略）：',
        `已有画像：${curProfile.summary || '无'}`,
        snap.promptBlock,
        memEntries.length ? `近期各题卡点：\n${memEntries.map(m => `- ${m.id}: ${m.summary.slice(0, 90)}`).join('\n')}` : '近期各题卡点：暂无',
        recentQuestions.length ? `近期追问：\n${recentQuestions.slice(-6).join('；')}` : ''
      ].filter(Boolean).join('\n\n');

      const res = await streamDeepSeek({
        modelOverride: 'deepseek-flash',
        effort: 'low',
        background: true,
        temperature: 0.3,
        maxTokens: 800,
        messages: [
          { role: 'system', content: '你是考研学习数据分析助手，只输出简洁精准的用户长期学习画像（纯文本，<=240字）。' },
          { role: 'user', content: prompt }
        ]
      });

      const nextSummary = String((res && res.content) || '').trim().slice(0, 600);
      if (nextSummary) {
        setLearningProfile({
          ...curProfile,
          summary: nextSummary,
          updatedAt: Date.now()
        });
        refreshMemoryBoxUI();
        scheduleDebouncedPush();
        if (manual) showToast('全站长期学习画像已更新并同步云端', 2000);
        return true;
      }
      return false;
    } catch (e) {
      if (manual) showToast(`提炼失败：${e && e.message ? e.message : '网络异常'}`, 2200);
      return false;
    } finally {
      aiState.isDistilling = false;
      if (dom.distillProfileBtn) {
        dom.distillProfileBtn.disabled = false;
        dom.distillProfileBtn.textContent = 'AI 自动提炼';
      }
    }
  }

  function renderChatStream(options = {}) {
    if (!dom.chatStream) return;
    const ctx = getScopeContext();
    const msgs = aiState.chatThreads.get(ctx.scopeKey) || [];
    const distFromBottom = dom.chatStream.scrollHeight - dom.chatStream.scrollTop - dom.chatStream.clientHeight;
    const wasNearBottom = Boolean(options.forceScroll) || msgs.length <= 2 || distFromBottom <= 72;

    if (msgs.length === 0) {
      dom.chatStream.dataset.renderedScope = ctx.scopeKey;
      dom.chatStream.innerHTML = `
        <div class="ai-empty-hint">
          已锁定「${escapeHtml(ctx.blockId)}」。你可以直接在下方提问，或点击建议标签生成<strong>答题骨架 / 对比表 / 换考法 / 跨科串联</strong>（支持引用原句「跳听」与篇目一键跳转）。
        </div>
      `;
      return;
    }

    const buildMsgHtml = (m, idx) => {
      if (m.role === 'user') {
        return `<div class="ai-msg ai-msg-user" data-msg-idx="${idx}"><div class="ai-msg-bubble">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div></div>`;
      }
      const isLastStreaming = aiState.isStreaming && idx === msgs.length - 1;
      const reasoningHtml = m.reasoning
        ? `<details class="ai-reasoning-block"><summary>DeepSeek 深度推理过程</summary><div class="ai-reasoning-body">${escapeHtml(m.reasoning).replace(/\n/g, '<br>')}</div></details>`
        : '';
      const toolStatusHtml = m.toolStatus
        ? `<div class="ai-tool-status${m.toolDone ? ' is-done' : ''}">${escapeHtml(m.toolStatus)}</div>`
        : '';
      let bodyHtml = '';
      if (m.content) {
        bodyHtml = renderAiMarkdown(m.content, ctx.sentences);
        if (!isLastStreaming && m.finishReason === 'length') {
          bodyHtml += '<div class="ai-empty-warn" style="margin-top:8px;">本次回复已达单次输出上限，内容可能未完，可点击下方「继续生成」无缝续写。</div>';
        }
      } else if (m.toolStatus) {
        bodyHtml = '';
      } else if (isLastStreaming) {
        bodyHtml = '<span class="ai-typing-dots">正在思考并检索原文...</span>';
      } else if (m.finishReason === 'length') {
        bodyHtml = '<div class="ai-empty-warn">模型深度推理已耗尽本次输出长度上限，未能生成正文结论。可点击重试或调低思考深度。</div>';
      } else {
        bodyHtml = '<div class="ai-empty-warn">模型本次未返回有效正文，请点击重试。</div>';
      }
      const continueBtnHtml = (m.content && !isLastStreaming && m.finishReason === 'length')
        ? `<button type="button" class="ai-msg-action-btn js-ai-continue-btn" data-msg-idx="${idx}">继续生成</button>`
        : '';
      const actionsHtml = (m.content && !isLastStreaming)
        ? `<div class="ai-msg-actions">
            ${continueBtnHtml}
            <button type="button" class="ai-msg-action-btn js-ai-copy-btn" data-msg-idx="${idx}">复制解析</button>
            <button type="button" class="ai-msg-action-btn js-ai-save-mem-btn" data-msg-idx="${idx}">存入卡点记忆</button>
          </div>`
        : '';
      return `<div class="ai-msg ai-msg-assistant" data-msg-idx="${idx}"><div class="ai-msg-bubble">${reasoningHtml}${toolStatusHtml}${bodyHtml}${actionsHtml}</div></div>`;
    };

    const existingMsgs = dom.chatStream.querySelectorAll(':scope > .ai-msg');
    const canReusePrefix = (
      !options.forceFull &&
      dom.chatStream.dataset.renderedScope === ctx.scopeKey &&
      existingMsgs.length > 0 &&
      msgs.length >= existingMsgs.length
    );

    if (canReusePrefix) {
      const prevLastIdx = existingMsgs.length - 1;
      const lastNode = existingMsgs[prevLastIdx];
      if (lastNode) {
        const prevOpenReasoning = lastNode.querySelector('.ai-reasoning-block[open]');
        const prevFoldStates = Array.from(lastNode.querySelectorAll('details.ai-fold')).map(d => d.open);
        const tpl = document.createElement('div');
        tpl.innerHTML = buildMsgHtml(msgs[prevLastIdx], prevLastIdx);
        const replacement = tpl.firstElementChild;
        if (replacement) {
          if (prevOpenReasoning) {
            const newReasoning = replacement.querySelector('.ai-reasoning-block');
            if (newReasoning) newReasoning.open = true;
          }
          if (prevFoldStates.length > 0) {
            replacement.querySelectorAll('details.ai-fold').forEach((d, fi) => {
              if (prevFoldStates[fi]) d.open = true;
            });
          }
          lastNode.replaceWith(replacement);
        }
      }
      if (msgs.length > existingMsgs.length) {
        const appendedHtml = msgs
          .slice(existingMsgs.length)
          .map((m, offset) => buildMsgHtml(m, existingMsgs.length + offset))
          .join('');
        dom.chatStream.insertAdjacentHTML('beforeend', appendedHtml);
      }
    } else {
      dom.chatStream.dataset.renderedScope = ctx.scopeKey;
      dom.chatStream.innerHTML = msgs.map((m, idx) => buildMsgHtml(m, idx)).join('');
    }

    if (wasNearBottom) {
      dom.chatStream.scrollTop = dom.chatStream.scrollHeight;
    }
  }

  async function sendAskMessage(presetPrompt = null, options = {}) {
    if (aiState.isStreaming) {
      showToast('DeepSeek 正在回复中，请点击「停止」后再发起新提问', 1600);
      return;
    }
    const rawInput = presetPrompt !== null ? presetPrompt : (dom.askInput ? dom.askInput.value.trim() : '');
    if (!rawInput) {
      showToast('请输入你的问题', 1600);
      return;
    }

    const ctx = getScopeContext();
    const sendScopeKey = ctx.scopeKey;
    const sendEpoch = aiState.chatThreadEpoch.get(sendScopeKey) || 0;
    const isStaleThreadSend = () => (aiState.chatThreadEpoch.get(sendScopeKey) || 0) !== sendEpoch;

    const thread = aiState.chatThreads.get(sendScopeKey) || [];
    const baseDisplay = options.displayContent || rawInput;
    const userDisplay = aiState.quotedText
      ? `【引用原文】“${aiState.quotedText}”\n\n${baseDisplay}`
      : baseDisplay;

    if (presetPrompt === null && dom.askInput) {
      dom.askInput.value = '';
    }
    const apiUserText = aiState.quotedText
      ? `【引用原文】“${aiState.quotedText}”\n\n${options.apiPromptOverride || rawInput}`
      : (options.apiPromptOverride || rawInput);
    aiState.quotedText = '';
    updateScopeHeaderUI();

    thread.push({ role: 'user', content: userDisplay });
    const assistantMsg = { role: 'assistant', content: '', reasoning: '', toolStatus: '', toolDone: false, finishReason: '', toolExchange: [] };
    thread.push(assistantMsg);
    touchChatThread(sendScopeKey, thread);
    persistChatThreadsToStorage();
    aiState._activeAssistantMsg = assistantMsg;
    aiState._activeScopeKey = sendScopeKey;
    renderChatStream({ forceScroll: true });

    const historyMsgs = [];
    trimHistoryForCache(thread.slice(0, -2)).forEach((m) => {
      if (!m || !m.role) return;
      if (m.role === 'assistant' && Array.isArray(m.toolExchange) && m.toolExchange.length > 0) {
        // 仅在工具调用与 tool 返回一一配对完整时才带入历史，且剥离跨轮 reasoning_content 防止 DeepSeek 400 协议报错
        const expectedToolIds = new Set();
        const repliedToolIds = new Set();
        m.toolExchange.forEach((step) => {
          if (step && step.role === 'assistant' && Array.isArray(step.tool_calls)) {
            step.tool_calls.forEach((tc) => { if (tc && tc.id) expectedToolIds.add(tc.id); });
          } else if (step && step.role === 'tool' && step.tool_call_id) {
            repliedToolIds.add(step.tool_call_id);
          }
        });
        const isExchangeComplete = expectedToolIds.size > 0 && Array.from(expectedToolIds).every(id => repliedToolIds.has(id));
        if (isExchangeComplete) {
          m.toolExchange.forEach((step) => {
            if (!step || !step.role) return;
            if (step.role === 'assistant') {
              const { reasoning_content: _drop, ...cleanStep } = step;
              historyMsgs.push(cleanStep);
            } else {
              historyMsgs.push(step);
            }
          });
        }
      }
      historyMsgs.push({ role: m.role, content: m.content || '' });
    });
    const apiMessages = [
      { role: 'system', content: buildAskSystemPrompt(ctx, rawInput) },
      ...historyMsgs,
      { role: 'user', content: apiUserText }
    ];

    setAskSendBtnStreaming(true);
    try {
      const useTools = options.useTools !== false;
      const toolRes = await runDeepSeekWithTools({
        messages: apiMessages,
        temperature: options.temperature !== undefined ? options.temperature : 0.45,
        maxTokens: options.maxTokens || null,
        modelOverride: options.modelOverride || null,
        effort: options.effort || null,
        tools: useTools ? AI_CLIENT_TOOLS : [],
        toolChoice: useTools ? 'auto' : undefined,
        maxRounds: 3,
        ctx,
        onToolStatus: (statusText, isDone) => {
          if (isStaleThreadSend()) return;
          assistantMsg.toolStatus = statusText || '';
          assistantMsg.toolDone = Boolean(isDone);
          renderChatStream();
        },
        onDelta: ({ content, reasoning, finishReason }) => {
          if (isStaleThreadSend()) return;
          assistantMsg.content = content;
          assistantMsg.reasoning = reasoning;
          if (finishReason) assistantMsg.finishReason = finishReason;
          if (content) {
            assistantMsg.toolStatus = '';
          }
          renderChatStream();
        }
      });
      if (isStaleThreadSend()) return;
      assistantMsg.toolStatus = '';
      if (toolRes && toolRes.finishReason) {
        assistantMsg.finishReason = toolRes.finishReason;
      }
      if (toolRes && Array.isArray(toolRes.toolExchange) && toolRes.toolExchange.length > 0) {
        assistantMsg.toolExchange = toolRes.toolExchange;
      }
      touchChatThread(sendScopeKey, thread);
      persistChatThreadsToStorage({ sync: true });
      renderChatStream();

      const userTurns = thread.filter(m => m.role === 'user').length;
      if (userTurns >= 4 && Date.now() - aiState.lastAutoDistillAt > 25 * 60 * 1000) {
        setTimeout(() => { distillLearningProfile({ manual: false }); }, 800);
      }
    } catch (err) {
      if (isStaleThreadSend()) return;
      assistantMsg.toolStatus = '';
      if (err && err.name === 'AbortError') {
        if (thread[thread.length - 1] === assistantMsg) {
          if (!assistantMsg.content && !assistantMsg.reasoning) {
            thread.pop();
          } else if (assistantMsg.content && !assistantMsg.content.endsWith('（已停止生成）')) {
            assistantMsg.content = `${assistantMsg.content.trimEnd()}\n\n（已停止生成）`;
          } else if (!assistantMsg.content && assistantMsg.reasoning) {
            assistantMsg.content = '（已停止生成）';
          }
        }
        touchChatThread(sendScopeKey, thread);
        persistChatThreadsToStorage({ sync: true });
        renderChatStream();
        return;
      }
      if (err && err.message === 'NO_AUTH_CONFIGURED') {
        assistantMsg.content = '尚未配置云端同步口令或 DeepSeek API Key。请点击右上角齿轮图标进入「设置 → AI 伴学与云端同步」填写 `Sync PIN`（或个人 Key）。';
      } else {
        assistantMsg.content = `请求出错：${err && err.message ? err.message : '未知网络错误'}`;
      }
      touchChatThread(sendScopeKey, thread);
      persistChatThreadsToStorage({ sync: true });
      renderChatStream();
    } finally {
      aiState._activeAssistantMsg = null;
      aiState._activeScopeKey = '';
      setAskSendBtnStreaming(false);
    }
  }

  function clearCurrentThread() {
    const ctx = getScopeContext();
    aiState.chatThreadEpoch.set(ctx.scopeKey, (aiState.chatThreadEpoch.get(ctx.scopeKey) || 0) + 1);
    abortActiveStream({ markStopped: false });
    aiState.chatThreads.delete(ctx.scopeKey);
    aiState.chatThreadMeta.set(ctx.scopeKey, { updatedAt: Date.now(), deleted: true });
    persistChatThreadsToStorage({ sync: true });
    renderChatStream({ forceFull: true });
    showToast('已清空当前范围对话', 1500);
  }

  // ==========================================
  // 7B. 高 ROI 功能：AI 采分眼挖空 / 作战简报 / 用量看板
  // ==========================================
  function parseJsonFromAiContent(rawText) {
    const cleaned = String(rawText || '')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    return JSON.parse(cleaned);
  }

  async function generateAiClozeForCurrentItem() {
    if (aiState.isGeneratingCloze) {
      showToast('正在提炼本题采分眼，请稍候...', 1600);
      return;
    }
    const cfg = getSyncConfig();
    if (!isSyncConfigured(cfg) && !cfg.deepseekKey) {
      showToast('请先配置 Sync PIN 或 DeepSeek Key', 2000);
      return;
    }
    const ctx = getScopeContext();
    const sourceText = (ctx.fullRefText || ctx.refText || '').trim();
    if (!sourceText || sourceText.length < 20) {
      showToast('当前篇目正文过短，暂无可提取的采分眼', 1800);
      return;
    }

    aiState.isGeneratingCloze = true;
    const origText = dom.clozeGenBtn ? dom.clozeGenBtn.textContent : 'AI采分眼';
    if (dom.clozeGenBtn) {
      dom.clozeGenBtn.disabled = true;
      dom.clozeGenBtn.textContent = '提炼中...';
    }

    try {
      const prompt = [
        `请针对以下考研考点「${ctx.itemTitle}」（${ctx.subjectLabel}），精准提取用于背诵挖空的双层级短语，严格以 JSON 对象返回：`,
        '{"skeleton": ["骨架词1", "..."], "scoring": ["采分眼1", "..."]}',
        '要求：',
        '1. skeleton（5~12个）：表示答题结构骨架、核心脉络、时期/流派/代表作或段落主干的短词（2~10字）。',
        '2. scoring（6~16个）：表示阅卷老师重点盯防的专业术语、核心评语、艺术特征或关键论断（2~14字）。',
        '3. 所有词条必须**原字不差地出自下方参考原文**（连续子串），不要改写或加标点，不要与另一组重复。',
        '',
        '参考原文：',
        sourceText.slice(0, 8000)
      ].join('\n');

      const res = await streamDeepSeek({
        modelOverride: 'deepseek-flash',
        effort: 'low',
        background: true,
        stream: false,
        responseFormat: { type: 'json_object' },
        temperature: 0.2,
        maxTokens: 2400,
        messages: [
          { role: 'system', content: '你是考研命题与阅卷专家，只输出合法 JSON：{"skeleton": string[], "scoring": string[]}，所有词条必须是原文中的精确连续子串。' },
          { role: 'user', content: prompt }
        ]
      });

      const parsed = parseJsonFromAiContent(res && res.content);
      const normSource = normalizeForMatch(sourceText);
      const rawSkeleton = cleanClozePhraseList(parsed && parsed.skeleton);
      const rawScoring = cleanClozePhraseList(parsed && parsed.scoring);
      const usedSet = new Set();
      const skeleton = rawSkeleton.filter((p) => {
        const np = normalizeForMatch(p);
        if (!np || !normSource.includes(np) || usedSet.has(p)) return false;
        usedSet.add(p);
        return true;
      });
      const scoring = rawScoring.filter((p) => {
        const np = normalizeForMatch(p);
        if (!np || !normSource.includes(np) || usedSet.has(p)) return false;
        usedSet.add(p);
        return true;
      });
      if (skeleton.length === 0 && scoring.length === 0) {
        throw new Error('AI 提取的词条未在当前原文中命中有效采分点，请重试');
      }

      const nowIso = new Date().toISOString();
      const clozeEntry = {
        skeleton,
        scoring,
        model: 'deepseek-flash',
        updated_at: nowIso,
        updatedAt: Date.now()
      };

      const cacheMap = getAiClozeCacheMap();
      cacheMap[ctx.itemId] = clozeEntry;
      setAiClozeCacheMap(cacheMap);

      const b = getBridge();
      if (b && typeof b.setAiClozeData === 'function') {
        b.setAiClozeData(ctx.itemId, clozeEntry);
      }
      if (b && typeof b.refreshCloze === 'function') {
        b.refreshCloze();
      }

      if (isSyncConfigured(cfg)) {
        try {
          const clozeRes = await fetchWithTimeout(`${cfg.url}/api/ai/cloze`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Sync-Pin': cfg.pin
            },
            body: JSON.stringify({
              item_id: ctx.itemId,
              skeleton,
              scoring,
              model: clozeEntry.model,
              updated_at: nowIso
            })
          }, 12000);
          if (!clozeRes.ok) {
            throw new Error(`HTTP_${clozeRes.status}`);
          }
        } catch (syncErr) {
          console.warn('POST /api/ai/cloze failed:', syncErr);
          markSyncDirty();
        }
      }

      showToast(`已生成 ${skeleton.length} 骨架词 + ${scoring.length} 采分眼并刷新挖空`, 2400);
    } catch (err) {
      showToast(`AI 采分眼提取失败：${err && err.message ? err.message : '请求异常'}`, 2400);
    } finally {
      aiState.isGeneratingCloze = false;
      if (dom.clozeGenBtn) {
        dom.clozeGenBtn.disabled = false;
        dom.clozeGenBtn.textContent = origText;
      }
    }
  }

  function triggerDailyBriefing() {
    const b = getBridge();
    const weakItems = (b && typeof b.getWeakItems === 'function') ? (b.getWeakItems('all', 8) || []) : [];
    const lp = getLearningProfile();
    const snap = buildGlobalProgressSnapshot();

    const weakListText = weakItems.length > 0
      ? weakItems.map((it, i) => `${i + 1}. id=${it.id} | 标题=${it.title} | 科目=${it.subject} | 等级=${it.level || '-'} | 分值=${it.score || '-'} | 状态=${it.status} | 听读=${it.listenCount}遍`).join('\n')
      : '暂无外部 weakItems 列表（可调用 get_weak_items 工具进一步检查）。';

    const apiPrompt = [
      '请为我制定今日考研背诵【最高 ROI 作战简报】：',
      '1. 基于下方薄弱高优篇目列表、我的长期学习画像与全站实时快照，精准筛选并推荐今日最值得优先攻克的 **Top 3 行动项**。',
      '2. 每个行动项必须附带可点击的跳转链接，严格使用 `[[item:ITEM_ID|篇目标题]]` 格式（直接使用下方列表中的精确 `id` 和 `标题`）。',
      '3. 说明推荐理由（分值/盲区/顽固卡点）与具体复习打法（听读轮次/挖空/口诀自测）。',
      '',
      `【长期学习画像】${lp.summary || '暂未建立（可先参考当前薄弱点）'}`,
      `【全站快照】\n${snap.promptBlock}`,
      `【薄弱高优候选篇目】\n${weakListText}`
    ].join('\n');

    sendAskMessage('生成今日最高 ROI 考研背诵作战简报', {
      displayContent: '生成今日最高 ROI 考研背诵作战简报（基于薄弱考点与学习画像）',
      apiPromptOverride: apiPrompt,
      effort: 'low',
      useTools: true
    });
  }

  function formatUsageTokenCount(num) {
    const n = Math.max(0, Number(num) || 0);
    if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(Math.round(n));
  }

  function renderUsagePanelData(data) {
    if (!dom.usagePanelBody) return;
    const summary = (data && data.summary) || {};
    const totalCalls = Number(summary.total_calls) || 0;
    const hitTokens = Number(summary.cache_hit_tokens) || 0;
    const missTokens = Number(summary.cache_miss_tokens) || 0;
    const compTokens = Number(summary.completion_tokens) || 0;
    const rawRate = Number(summary.cache_hit_rate);
    let hitRatePct = '0%';
    if (!isNaN(rawRate) && rawRate > 0) {
      const pctVal = rawRate <= 1 ? rawRate * 100 : rawRate;
      hitRatePct = `${pctVal.toFixed(1)}%`;
    } else if (hitTokens + missTokens > 0) {
      hitRatePct = `${((hitTokens / (hitTokens + missTokens)) * 100).toFixed(1)}%`;
    }

    const byModel = Array.isArray(data && data.by_model) ? data.by_model : [];
    const modelLine = byModel.length > 0
      ? byModel.map(m => `${escapeHtml(m.model || 'unknown')}: ${Number(m.calls ?? m.total_calls ?? 0)}次`).join(' · ')
      : '暂无分模型记录';
    const last24 = data && data.last_24h ? `近 24h：${Number(data.last_24h.total_calls ?? data.last_24h.calls ?? 0)} 次调用` : '';

    dom.usagePanelBody.innerHTML = `
      <div class="ai-usage-grid">
        <div class="ai-usage-stat">
          <span class="ai-usage-stat-label">累计调用</span>
          <span class="ai-usage-stat-val">${totalCalls} 次</span>
        </div>
        <div class="ai-usage-stat">
          <span class="ai-usage-stat-label">缓存命中率</span>
          <span class="ai-usage-stat-val is-hit">${hitRatePct}</span>
        </div>
        <div class="ai-usage-stat">
          <span class="ai-usage-stat-label">Hit / Miss</span>
          <span class="ai-usage-stat-val">${formatUsageTokenCount(hitTokens)} / ${formatUsageTokenCount(missTokens)}</span>
        </div>
        <div class="ai-usage-stat">
          <span class="ai-usage-stat-label">输出 Tokens</span>
          <span class="ai-usage-stat-val">${formatUsageTokenCount(compTokens)}</span>
        </div>
      </div>
      <div class="ai-usage-meta">
        <span>模型分布：${modelLine}</span>
        <span>${escapeHtml(last24)}</span>
      </div>
    `;
  }

  async function toggleAndLoadUsagePanel() {
    if (!dom.usagePanel) return;
    const isCurrentlyHidden = dom.usagePanel.hidden;
    if (!isCurrentlyHidden) {
      dom.usagePanel.hidden = true;
      if (dom.usageBtn) dom.usageBtn.setAttribute('aria-expanded', 'false');
      return;
    }

    dom.usagePanel.hidden = false;
    if (dom.usageBtn) dom.usageBtn.setAttribute('aria-expanded', 'true');
    if (!dom.usagePanelBody) return;

    const cfg = getSyncConfig();
    if (!isSyncConfigured(cfg)) {
      dom.usagePanelBody.innerHTML = '<div class="ai-usage-empty">请先在设置中填写 Sync PIN 后查看云端 Token 与前缀缓存看板</div>';
      return;
    }

    dom.usagePanelBody.innerHTML = '<div class="ai-usage-empty">正在拉取 DeepSeek Token 与缓存命中统计...</div>';
    try {
      const res = await fetch(`${cfg.url}/api/ai/usage`, {
        method: 'GET',
        headers: { 'X-Sync-Pin': cfg.pin }
      });
      if (res.status === 401) throw new Error('Sync PIN 校验失败 (401)');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderUsagePanelData(data);
    } catch (err) {
      dom.usagePanelBody.innerHTML = `<div class="ai-usage-empty">加载用量统计失败：${escapeHtml(err && err.message ? err.message : '网络异常')}</div>`;
    }
  }

  function hydrateBridgeClozeCache() {
    const b = getBridge();
    if (!b || typeof b.setAiClozeData !== 'function') return;
    const map = getAiClozeCacheMap();
    Object.entries(map).forEach(([itemId, entry]) => {
      b.setAiClozeData(itemId, entry);
    });
    if (typeof b.refreshCloze === 'function') {
      b.refreshCloze();
    }
  }

  // ==========================================
  // 8. 卡点记忆持久化辅助
  // ==========================================
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
    dom.aiEffortSelect = document.getElementById('aiEffortSelect');
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
    if (dom.aiEffortSelect) {
      dom.aiEffortSelect.value = cfg.effort;
      dom.aiEffortSelect.addEventListener('change', () => {
        setReasoningEffort(dom.aiEffortSelect.value, true);
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
    dom.effortSeg = document.getElementById('aiEffortSeg');
    dom.cacheBadge = document.getElementById('aiCacheBadge');
    dom.scopeBadge = document.getElementById('aiScopeBadge');
    dom.clearScopeBtn = document.getElementById('aiClearScopeBtn');

    dom.panelAsk = document.getElementById('aiPanelAsk');

    dom.memoryBox = document.getElementById('aiMemoryBox');
    dom.memoryToggleBtn = document.getElementById('aiMemoryToggleBtn');
    dom.memoryCloseBtn = document.getElementById('aiMemoryCloseBtn');
    dom.memorySummaryInput = document.getElementById('aiMemorySummaryInput');
    dom.memoryStats = document.getElementById('aiMemoryStats');
    dom.saveMemoryBtn = document.getElementById('aiSaveMemoryBtn');
    dom.memTabItem = document.getElementById('aiMemTabItem');
    dom.memTabGlobal = document.getElementById('aiMemTabGlobal');
    dom.memPaneItem = document.getElementById('aiMemPaneItem');
    dom.memPaneGlobal = document.getElementById('aiMemPaneGlobal');
    dom.globalStatsLine = document.getElementById('aiGlobalStatsLine');
    dom.globalProfileInput = document.getElementById('aiGlobalProfileInput');
    dom.globalProfileMeta = document.getElementById('aiGlobalProfileMeta');
    dom.distillProfileBtn = document.getElementById('aiDistillProfileBtn');
    dom.saveGlobalProfileBtn = document.getElementById('aiSaveGlobalProfileBtn');

    dom.quoteBox = document.getElementById('aiQuoteBox');
    dom.quoteText = document.getElementById('aiQuoteText');
    dom.quoteClearBtn = document.getElementById('aiQuoteClearBtn');

    dom.chipMnemonic = document.getElementById('aiChipMnemonic');
    dom.chipContrast = document.getElementById('aiChipContrast');
    dom.chipFormula = document.getElementById('aiChipFormula');
    dom.chipClearChat = document.getElementById('aiChipClearChat');
    dom.clearThreadBtn = document.getElementById('aiClearThreadBtn');
    dom.briefingBtn = document.getElementById('aiBriefingBtn');
    dom.usageBtn = document.getElementById('aiUsageBtn');
    dom.usagePanel = document.getElementById('aiUsagePanel');
    dom.usagePanelBody = document.getElementById('aiUsagePanelBody');
    dom.clozeGenBtn = document.getElementById('aiClozeGenBtn');
    dom.quickChipsWrap = dom.drawer ? dom.drawer.querySelector('.ai-quick-chips') : null;

    dom.chatStream = document.getElementById('aiChatStream');
    dom.askInput = document.getElementById('aiAskInput');
    dom.askSendBtn = document.getElementById('aiAskSendBtn');

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
        if (aiState.scopedCardEl) {
          abortActiveStream();
        }
        aiState.scopedCardEl = null;
        aiState.scopedCardLabel = '';
        aiState.scopedCardText = '';
        aiState.scopedSentences = [];
        aiState.quotedText = '';
        setMemoryBoxOpen(false);
        updateScopeHeaderUI();
        renderChatStream();
      });
    }

    if (dom.memoryToggleBtn && dom.memoryBox) {
      dom.memoryToggleBtn.addEventListener('click', () => {
        const isShown = dom.memoryBox.style.display !== 'none';
        if (!isShown) refreshMemoryBoxUI();
        setMemoryBoxOpen(!isShown);
      });
    }
    if (dom.effortSeg) {
      dom.effortSeg.addEventListener('click', (e) => {
        const btn = e.target.closest('.ai-effort-btn');
        if (!btn) return;
        setReasoningEffort(btn.dataset.effort, true);
      });
    }
    if (dom.memTabItem) {
      dom.memTabItem.addEventListener('click', () => switchMemoryTab('item'));
    }
    if (dom.memTabGlobal) {
      dom.memTabGlobal.addEventListener('click', () => {
        refreshMemoryBoxUI();
        switchMemoryTab('global');
      });
    }
    if (dom.distillProfileBtn) {
      dom.distillProfileBtn.addEventListener('click', () => {
        distillLearningProfile({ manual: true });
      });
    }
    if (dom.saveGlobalProfileBtn && dom.globalProfileInput) {
      dom.saveGlobalProfileBtn.addEventListener('click', () => {
        const cur = getLearningProfile();
        setLearningProfile({
          ...cur,
          summary: dom.globalProfileInput.value.trim().slice(0, 1200),
          updatedAt: Date.now()
        });
        refreshMemoryBoxUI();
        scheduleDebouncedPush();
        showToast('全站长期认知画像已保存并加入同步队列', 1800);
      });
    }
    if (dom.memoryCloseBtn && dom.memoryBox) {
      dom.memoryCloseBtn.addEventListener('click', () => {
        setMemoryBoxOpen(false);
      });
    }

    if (dom.saveMemoryBtn && dom.memorySummaryInput) {
      dom.memorySummaryInput.addEventListener('input', () => {
        dom.memorySummaryInput.dataset.dirty = '1';
        dom.memorySummaryInput.dataset.itemId = getScopeContext().itemId;
      });
      dom.saveMemoryBtn.addEventListener('click', () => {
        const ctx = getScopeContext();
        saveMemorySummary(ctx.itemId, {
          summary: dom.memorySummaryInput.value,
          incrementRecite: false
        });
        dom.memorySummaryInput.dataset.dirty = '0';
        dom.memorySummaryInput.dataset.itemId = ctx.itemId;
        setMemoryBoxOpen(false);
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
      dom.chipClearChat.addEventListener('click', clearCurrentThread);
    }
    if (dom.clearThreadBtn) {
      dom.clearThreadBtn.addEventListener('click', clearCurrentThread);
    }
    if (dom.briefingBtn) {
      dom.briefingBtn.addEventListener('click', triggerDailyBriefing);
    }
    if (dom.usageBtn) {
      dom.usageBtn.addEventListener('click', toggleAndLoadUsagePanel);
    }
    if (dom.clozeGenBtn) {
      dom.clozeGenBtn.addEventListener('click', generateAiClozeForCurrentItem);
    }
    if (dom.drawer) {
      dom.drawer.addEventListener('click', (e) => {
        const presetBtn = e.target.closest('[data-ai-preset]');
        if (!presetBtn) return;
        const preset = presetBtn.dataset.aiPreset;
        const ctx = getScopeContext();
        if (preset === 'exam-twist') {
          sendAskMessage(
            `请针对「${ctx.itemTitle}」【换考法考我】：设计 1～2 道高仿真考研变式题（如材料分析、概念辨析、视角转换论述），并在每道题后使用 <details class="ai-fold"><summary>点击展开答题提示与采分点</summary>...</details> 折叠给出答题骨架、采分关键词与避坑提示。`,
            {
              displayContent: `换考法考我：针对「${ctx.itemTitle}」生成考研变式题与折叠采分点`
            }
          );
        } else if (preset === 'cross-link') {
          sendAskMessage(
            `请围绕「${ctx.itemTitle}」进行【跨科/跨篇串联】：先调用 search_knowledge_base 工具检索全库（706 古代文学 / 807 现当代文学 / 考研政治 / 考研英语）中关联度最高的 2～3 个篇目，对比学理脉络或命题角度，并用 [[item:ITEM_ID|标题]] 格式输出可跳转链接。`,
            {
              displayContent: `跨科串联：检索全库关联篇目并梳理「${ctx.itemTitle}」知识脉络`
            }
          );
        }
      });
    }

    if (dom.chatStream) {
      dom.chatStream.addEventListener('click', (e) => {
        const quoteJump = e.target.closest('.ai-quote-jump');
        if (quoteJump) {
          const sentIdx = parseInt(quoteJump.dataset.sentIdx, 10);
          const rawStart = quoteJump.dataset.sentStart;
          const start = (rawStart !== undefined && rawStart !== '' && !isNaN(Number(rawStart)))
            ? Number(rawStart)
            : undefined;
          const b = getBridge();
          if (b && typeof b.getState === 'function' && typeof b.seekToSentence === 'function') {
            const st = b.getState();
            const liveSents = (st && Array.isArray(st.activeSentences)) ? st.activeSentences : [];
            const targetSent = (!isNaN(sentIdx) && sentIdx >= 0 && sentIdx < liveSents.length) ? liveSents[sentIdx] : null;
            const timeMatches = targetSent && (start === undefined || Math.abs(Number(targetSent.start) - start) <= 0.6);
            if (!targetSent || !timeMatches) {
              const quoteBlock = quoteJump.closest('.ai-md-quote');
              const qTxt = quoteBlock ? (quoteBlock.textContent || '').replace(/跳听\s*$/, '').trim() : '';
              const reMatchedIdx = qTxt ? findSentenceIndexByQuote(qTxt, liveSents) : -1;
              if (reMatchedIdx >= 0) {
                b.seekToSentence(reMatchedIdx, liveSents[reMatchedIdx].start);
                showToast('已跳转定位原句音频', 1400);
              } else {
                showToast('当前已切换篇目或音轨，请切回对应文本后再跳听该原句', 2200);
              }
              return;
            }
            b.seekToSentence(sentIdx, start);
            showToast('已跳转定位原句音频', 1400);
          }
          return;
        }

        const itemJump = e.target.closest('.ai-item-jump');
        if (itemJump) {
          const targetId = itemJump.dataset.itemId;
          const b = getBridge();
          if (targetId && b && typeof b.openStudyItem === 'function') {
            b.openStudyItem(targetId);
            closeAiDrawer();
          }
          return;
        }

        const continueBtn = e.target.closest('.js-ai-continue-btn');
        if (continueBtn) {
          sendAskMessage('请紧接你上一条未写完的内容继续输出，不要重复已经写过的部分。', {
            displayContent: '继续生成'
          });
          return;
        }

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

    if (dom.askSendBtn) {
      dom.askSendBtn.addEventListener('click', () => {
        if (aiState.isStreaming || dom.askSendBtn.classList.contains('is-streaming')) {
          abortActiveStream({ markStopped: true });
          return;
        }
        sendAskMessage(null);
      });
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
  }

  // ==========================================
  // 10. 挂载 app.js 生命周期钩子与云同步调度
  // ==========================================
  window.__kaoyanAiHooks = {
    onPaperRendered: () => {
      hideSelectionPill();
      injectCardAiButtons();
      abortActiveStream();
      if (aiState.chatThreads.size === 0) {
        loadChatThreadsFromStorage();
      }
      aiState.scopedCardEl = null;
      aiState.scopedCardLabel = '';
      aiState.scopedCardText = '';
      aiState.scopedSentences = [];
      aiState.quotedText = '';
      setMemoryBoxOpen(false);
      if (aiState.isOpen) {
        updateScopeHeaderUI();
        renderChatStream();
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
    },
    renderAiMarkdown: (rawMarkdown, sentences) => renderAiMarkdown(rawMarkdown, sentences),
    getScopeContext: () => getScopeContext(),
    buildAskSystemPrompt: (ctx, userQuery = '') => buildAskSystemPrompt(ctx || getScopeContext(), userQuery)
  };

  function initAiSyncModule() {
    migrateLegacySyncUrl();
    loadChatThreadsFromStorage();
    hydrateBridgeClozeCache();
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
