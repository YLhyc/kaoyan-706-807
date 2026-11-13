/**
 * 2027 考研全科双轨随身背诵手卷 · 核心交互引擎 (全科金石朱墨专研版)
 * 深度集成 807 专业课、706 专业课 与 考研英语写作听力磨耳库
 * 支持纯本地离线 (ZERO-CORS) 瞬时加载与全量 176 音轨毫秒级点读对齐
 */

(function () {
  'use strict';

  // 安全前置初始化同步补偿量 (保留用户显式设置，默认 0.15s 灵敏合拍)
  let initialSyncOffset = 0.15;
  try {
    const rawSync = localStorage.getItem('kaoyan_sync_offset');
    const savedSync = rawSync !== null ? parseFloat(rawSync) : NaN;
    if (!isNaN(savedSync) && savedSync >= -0.2 && savedSync <= 0.35) {
      initialSyncOffset = savedSync;
    } else {
      initialSyncOffset = 0.15;
      localStorage.setItem('kaoyan_sync_offset', '0.15');
    }
  } catch (e) {
    initialSyncOffset = 0.15;
  }

  const state = {
    allData: null,
    currentSubject: '807', // '807' | '706' | 'pol' | 'en'
    polSubMode: localStorage.getItem('kaoyan_pol_submode') || 'recite47', // 'recite47' | 'xutao16' | 'tuijie11'
    polCategory: localStorage.getItem('kaoyan_pol_cat') || 'all', // 'all' | 'my' | 'mzt' | 'xsx' | 'sg' | 'sx'
    polXtVoice: localStorage.getItem('kaoyan_pol_xt_voice') || 'anlang', // 'anlang' | 'voice'
    polSubCardId: localStorage.getItem('kaoyan_pol_subcard_id') || null,
    polData: null,
    currentTrack: 1, // 1: 考场直接答题/中英磨耳, 2: 答题版逻辑精解/替换仿写
    activeItemId: null,
    activeItem: null,
    activeSentences: [],
    currentSentIndex: -1,
    
    // 播放状态
    isPlaying: false,
    speed: 1.0,
    playMode: 'sequence', // 'all', 'sentence', 'section', 'loop3'
    clozeMode: 'off', // 'off' | 'keyword' | 'body'
    reciteMode: 'normal',
    loopCount: 0,
    fontSize: 17,
    theme: 'parchment',
    
    // 筛选条件
    tierFilter: 'all',
    masteryFilter: 'all', // 'all' | 'unlearned' | 'familiar' | 'mastered'
    scoreFilter: 'all',
    searchQuery: '',
    
    // 研学掌握度与打卡数据 (localStorage 持久化)
    masteryState: {}, // itemId -> 'unlearned' | 'familiar' | 'mastered'
    studyLogs: { dates: [], totalCardsCompleted: 0 },

    lastUserScrollTime: 0,
    syncOffset: initialSyncOffset
  };

  let isPolDataLoading = false;
  let polDataLoadPromise = null;
  let syncRafId = null;
  let lastSpotlightEl = null;
  let isProgrammaticScrolling = false;
  let programmaticScrollTimer = null;
  let seekToken = 0;
  let lastMediaSessionKey = '';
  let lastHudSectionKey = '';
  let playModeCloseTimer = null;
  let speedModalCloseTimer = null;

  // 严密循环闭环与寻音防重入锁引擎 (Anti-Reentry & Drift-Prevention Engine)
  let isLoopSeeking = false;
  let loopSeekTimer = null;
  let lastSeekTs = 0;
  let manualSeekEpoch = 0;
  let pendingSeekTarget = null; // { token, time, idx, startedAt, wasMuted, mutedForSeek }
  let pendingSeekTimer = null;
  let lastClickedSentGuard = null; // { idx, time, until }

  function clearPendingSeek(restoreMute = true) {
    if (pendingSeekTimer) {
      clearTimeout(pendingSeekTimer);
      pendingSeekTimer = null;
    }
    if (pendingSeekTarget && restoreMute && pendingSeekTarget.mutedForSeek) {
      try {
        audio.muted = Boolean(pendingSeekTarget.wasMuted);
      } catch (e) {}
    }
    pendingSeekTarget = null;
  }

  function findSectionIndexAtTime(time) {
    if (!currentFrameworkSections || currentFrameworkSections.length === 0) return -1;
    const t = Math.max(0, typeof time === 'number' ? time : parseFloat(time || 0));
    if (t < currentFrameworkSections[0].start) return 0;
    let matched = 0;
    for (let i = 0; i < currentFrameworkSections.length; i++) {
      if (t >= currentFrameworkSections[i].start - 0.02) {
        matched = i;
      }
    }
    return matched;
  }

  function getLoopCutoff(start, end, nextStart) {
    const safeStart = typeof start === 'number' && !isNaN(start) ? start : 0;
    const hasEnd = typeof end === 'number' && !isNaN(end) && end > safeStart;
    const hasNext = typeof nextStart === 'number' && isFinite(nextStart) && nextStart > safeStart;
    const safeEnd = hasEnd ? end : (hasNext ? nextStart : Infinity);
    if (!isFinite(safeEnd)) return Infinity;
    const rawCutoff = hasNext
      ? Math.min(safeEnd - 0.03, nextStart - 0.05)
      : (safeEnd - 0.03);
    return Math.max(safeStart + 0.06, rawCutoff);
  }

  function getCardTimedSentences(card) {
    if (!card) return [];
    const candidates = card.querySelectorAll('[data-sent-idx], [data-sent-id], [data-start], .recite-sent, .recite-sent-item, .recite-sentence, .tj-sent-span, .tj-point-card');
    return Array.from(candidates).filter(node => {
      if (node.dataset.sentIdx !== undefined && node.dataset.sentIdx !== '') return true;
      if (node.dataset.sentId !== undefined && node.dataset.sentId !== '') return true;
      if (node.dataset.start !== undefined && node.dataset.start !== '' && !isNaN(parseFloat(node.dataset.start))) return true;
      if (node.classList.contains('tj-point-card') && node.dataset.pointId) return true;
      return false;
    });
  }

  function triggerLoopSeek(targetTime, targetSentIdx = null) {
    const now = Date.now();
    if (isLoopSeeking && (now - lastSeekTs < 150)) {
      return;
    }
    isLoopSeeking = true;
    lastSeekTs = now;
    try {
      audio.currentTime = targetTime;
    } catch (err) {
      console.warn('Seek error:', err);
    }
    if (targetSentIdx !== null && typeof targetSentIdx === 'number' && state.activeSentences && targetSentIdx >= 0 && targetSentIdx < state.activeSentences.length) {
      state.currentSentIndex = targetSentIdx;
      highlightSentence(targetSentIdx);
    }
    if (loopSeekTimer) clearTimeout(loopSeekTimer);
    loopSeekTimer = setTimeout(() => {
      isLoopSeeking = false;
    }, 150);
  }

  const audio = new Audio();
  audio.preload = 'metadata';
  window.state = state;
  window.audio = audio;

  const el = {};

  // ==========================================
  // 听读背诵循环模式配置 (按顺序依次播放 / 完全循环 / 单段循环 / 单句循环)
  // ==========================================
  const PLAY_MODES = [
    {
      id: 'sequence',
      label: '顺序',
      name: '按顺序依次播放',
      badge: '顺序播放',
      desc: '顺序通读全篇大题，播完自动进入下一个知识点',
      toast: '已设置为【按顺序依次播放】· 顺畅通读全篇大题',
      iconSvg: '<polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path>'
    },
    {
      id: 'item',
      label: '完全',
      name: '完全循环（整个知识点循环）',
      badge: '整题循环',
      desc: '当前整道考题反复循环播放，播完自动从头重播',
      toast: '已开启【完全循环】· 当前整道考题将反复循环朗读',
      iconSvg: '<polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path><circle cx="12" cy="12" r="2.8" fill="currentColor"></circle>'
    },
    {
      id: 'section',
      label: '单段',
      name: '单段循环',
      badge: '分论点循环',
      desc: '在当前分论点/板块内循环背诵，选哪段就循环哪段',
      toast: '已开启【单段循环】· 将在当前板块内无限循环背诵',
      iconSvg: '<polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path><text x="12" y="15.5" font-size="7" font-weight="900" text-anchor="middle" fill="currentColor">段</text>'
    },
    {
      id: 'loop3',
      label: '三遍',
      name: '单句精听（三遍推进）',
      badge: '三遍精听',
      desc: '每句连续朗读三遍后自动推进下一句，兼顾巩固与通篇进度',
      toast: '已开启【单句精听 · 3遍推进】· 每句连读三遍后自动下行',
      iconSvg: '<polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path><text x="12" y="16" font-size="8" font-weight="900" text-anchor="middle" fill="currentColor">3</text>'
    },
    {
      id: 'sentence',
      label: '单句',
      name: '单句循环',
      badge: '逐句循环',
      desc: '在当前单句内循环跟读背诵，点击任意句子即可循环该句',
      toast: '已开启【单句循环】· 点击任意句子即无限循环朗读',
      iconSvg: '<polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path><text x="12" y="16" font-size="8" font-weight="900" text-anchor="middle" fill="currentColor">1</text>'
    }
  ];

  function clearAudioSource() {
    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch (e) {}
  }

  function resetAudioProgressUI() {
    if (el.timeCurrent) el.timeCurrent.textContent = '00:00';
    if (el.timeTotal) el.timeTotal.textContent = '00:00';
    if (el.progressFill) el.progressFill.style.width = '0%';
    const ticksWrap = document.getElementById('progress-ticks');
    if (ticksWrap) ticksWrap.innerHTML = '';
    lastHudSectionKey = '';
    lastMediaSessionKey = '';
  }

  function tryRestoreAudioTime(restoreTime, expectedKey) {
    if (!restoreTime) return;
    try {
      if (localStorage.getItem('kaoyan_last_time_key') !== expectedKey) return;
      const savedTime = parseFloat(localStorage.getItem('kaoyan_last_time') || '0');
      if (!(savedTime > 1)) return;
      const restoreEpoch = manualSeekEpoch;
      const applyRestored = () => {
        if (restoreEpoch !== manualSeekEpoch || (pendingSeekTarget && Date.now() - pendingSeekTarget.startedAt < 5000)) return;
        const dur = audio.duration || 0;
        const safeTime = dur > 0 ? Math.min(savedTime, Math.max(0, dur - 0.5)) : savedTime;
        try { audio.currentTime = safeTime; } catch (err) {}
        audio.playbackRate = state.speed;
        if (el.timeCurrent) el.timeCurrent.textContent = formatTime(safeTime);
        if (dur > 0 && el.progressFill) {
          el.progressFill.style.width = Math.min(100, (safeTime / dur) * 100) + '%';
        }
        updateHUDDisplay(safeTime);
        if (state.activeSentences && state.activeSentences.length > 0) {
          const activeIdx = findActiveSentenceIndex(safeTime);
          if (activeIdx !== -1) {
            state.currentSentIndex = activeIdx;
            highlightSentence(activeIdx);
          }
        }
      };
      if (audio.readyState >= 1) applyRestored();
      else audio.addEventListener('loadedmetadata', applyRestored, { once: true });
    } catch (e) {}
  }

  function updatePlayModeUI(showToastNotice = false) {
    if (!el.loopModeBtn) return;
    const modeConfig = PLAY_MODES.find(m => m.id === state.playMode) || PLAY_MODES[0];
    el.loopModeBtn.classList.toggle('active', modeConfig.id !== 'sequence');
    el.loopModeBtn.title = `听读模式：${modeConfig.name}（点击打开选择列表）`;

    const iconEl = el.loopModeBtn.querySelector('svg');
    if (iconEl) iconEl.innerHTML = modeConfig.iconSvg;
    const textEl = el.loopModeBtn.querySelector('.mode-text') || el.loopModeBtn.querySelector('span');
    if (textEl) textEl.textContent = modeConfig.label;

    if (showToastNotice) {
      showToast(modeConfig.toast, 2500);
    }
    updateHUDDisplay(audio.currentTime || 0);
  }

  function setPlayMode(modeId, showToastNotice = true) {
    state.playMode = modeId;
    state.loopCount = 0;
    localStorage.setItem('kaoyan_play_mode', modeId);
    updatePlayModeUI(showToastNotice);

    // 智能校准当前高光与指针
    if (state.activeSentences && state.activeSentences.length > 0) {
      if (state.currentSentIndex === -1 || !state.activeSentences[state.currentSentIndex]) {
        state.currentSentIndex = findActiveSentenceIndex(audio.currentTime || 0);
      }
      if (state.currentSentIndex !== -1 && state.activeSentences[state.currentSentIndex]) {
        highlightSentence(state.currentSentIndex);
      }
    }

    if (modeId === 'section' && currentFrameworkSections.length > 0) {
      const matchedSecIdx = findSectionIndexAtTime(audio.currentTime || 0);
      currentActiveSectionIndex = matchedSecIdx !== -1 ? matchedSecIdx : 0;
    }
    updateHUDDisplay(audio.currentTime || 0);
  }

  // ==========================================
  // 移动端抽屉滚动穿透锁与触摸隔离管理器 (Touch Isolation & Scroll Lock Manager)
  // ==========================================
  const activeDrawers = new Set();

  function hasAnyOpenDrawer() {
    const isSidebarOpenAsDrawer = !!(el.sidebar && el.sidebar.classList.contains('open') && isSidebarDrawerMode());
    if (isSidebarOpenAsDrawer) return true;

    const drawerElements = [
      el.outlineDrawer,
      el.playModeDrawer,
      el.studyDashboardDrawer,
      document.getElementById('settingsDrawer'),
      document.getElementById('speedModal'),
      document.getElementById('updateModal'),
      document.querySelector('.appearance-drawer')
    ];

    for (const d of drawerElements) {
      if (d && d.classList.contains('open')) {
        return true;
      }
    }
    return false;
  }

  function syncBodyScrollLock() {
    const trulyOpen = hasAnyOpenDrawer();
    if (trulyOpen) {
      document.documentElement.classList.add('drawer-scroll-locked');
      document.body.classList.add('drawer-scroll-locked');
    } else {
      activeDrawers.clear();
      document.documentElement.classList.remove('drawer-scroll-locked');
      document.body.classList.remove('drawer-scroll-locked');
    }
  }

  function lockBodyScroll(drawerName = 'drawer') {
    const key = (typeof drawerName === 'string') ? drawerName : (drawerName?.id || drawerName?.className || 'drawer');
    activeDrawers.add(key);
    document.documentElement.classList.add('drawer-scroll-locked');
    document.body.classList.add('drawer-scroll-locked');
  }

  function unlockBodyScroll(drawerName = 'drawer') {
    const key = (typeof drawerName === 'string') ? drawerName : (drawerName?.id || drawerName?.className || 'drawer');
    activeDrawers.delete(key);
    syncBodyScrollLock();
  }

  function isBodyScrollLocked() {
    return hasAnyOpenDrawer() || (activeDrawers.size > 0 && document.body.classList.contains('drawer-scroll-locked'));
  }

  function isSidebarDrawerMode() {
    return (window.innerWidth <= 834 || (window.innerWidth <= 1024 && window.innerHeight > window.innerWidth) || (window.innerHeight <= 500 && window.innerWidth > window.innerHeight));
  }

  function openSidebar() {
    if (!el.sidebar) return;
    el.sidebar.classList.add('open');
    if (el.backdrop) el.backdrop.classList.add('open');
    lockBodyScroll('sidebar');
    setPlayerDockReceded(true);
    setBottomNavActiveTab('syllabus');
  }

  function closeSidebar() {
    if (!el.sidebar) return;
    el.sidebar.classList.remove('open');
    if (el.backdrop) el.backdrop.classList.remove('open');
    unlockBodyScroll('sidebar');
    setPlayerDockReceded(false);
    setBottomNavActiveTab('');
  }

  function toggleSidebar() {
    if (!el.sidebar) return;
    if (el.sidebar.classList.contains('open')) {
      closeSidebar();
    } else {
      openSidebar();
    }
  }

  function openPlayModeDrawer() {
    if (!el.playModeDrawer || !el.playModeList) return;
    if (playModeCloseTimer) {
      clearTimeout(playModeCloseTimer);
      playModeCloseTimer = null;
    }
    renderPlayModeList();
    setPlayerDockReceded(true);
    if (el.playModeBackdrop) el.playModeBackdrop.style.display = 'block';
    requestAnimationFrame(() => {
      el.playModeDrawer.classList.add('open');
      el.playModeDrawer.setAttribute('aria-hidden', 'false');
    });
    lockBodyScroll('playModeDrawer');
  }

  function closePlayModeDrawer() {
    if (!el.playModeDrawer) return;
    if (playModeCloseTimer) clearTimeout(playModeCloseTimer);
    el.playModeDrawer.classList.remove('open');
    el.playModeDrawer.setAttribute('aria-hidden', 'true');
    playModeCloseTimer = setTimeout(() => {
      if (el.playModeBackdrop && !el.playModeDrawer.classList.contains('open')) {
        el.playModeBackdrop.style.display = 'none';
      }
      playModeCloseTimer = null;
    }, 280);
    unlockBodyScroll('playModeDrawer');
    setPlayerDockReceded(false);
  }

  function renderPlayModeList() {
    if (!el.playModeList) return;
    el.playModeList.innerHTML = '';

    PLAY_MODES.forEach(m => {
      const isCurrent = m.id === state.playMode;
      const card = document.createElement('div');
      card.className = `mode-option-card ${isCurrent ? 'active-mode-card' : ''}`;
      card.innerHTML = `
        <div class="mode-option-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            ${m.iconSvg}
          </svg>
        </div>
        <div class="mode-option-info">
          <div class="mode-option-title-row">
            <span class="mode-option-name">${m.name}</span>
            <span class="mode-option-badge">${m.badge}</span>
          </div>
          <div class="mode-option-desc">${m.desc}</div>
        </div>
        ${isCurrent ? `
          <div class="mode-option-check">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
        ` : ''}
      `;

      card.addEventListener('click', () => {
        setPlayMode(m.id, true);
        closePlayModeDrawer();
      });

      el.playModeList.appendChild(card);
    });
  }



  function initElements() {
    el.subject807Btn = document.getElementById('btn-subject-807');
    el.subject706Btn = document.getElementById('btn-subject-706');
    el.subjectEnBtn = document.getElementById('btn-subject-en');
    
    el.count807 = document.getElementById('count-807');
    el.count706 = document.getElementById('count-706');
    el.countEn = document.getElementById('count-en');
    el.countPol = document.getElementById('count-pol');
    
    el.headerVoiceBadge = document.getElementById('headerVoiceBadge');
    el.filterPillsWrap = document.getElementById('filter-pills-wrap');
    
    el.searchInput = document.getElementById('search-input');
    el.itemList = document.getElementById('item-list');
    
    el.questionTitle = document.getElementById('stage-title');
    el.stageSubject = document.getElementById('stage-subject');
    el.stageTopic = document.getElementById('stage-topic');
    el.stageScore = document.getElementById('stage-score');
    el.stageTier = document.getElementById('stage-tier');
    
    el.tabTrack1 = document.getElementById('tab-track-1');
    el.tabTrack2 = document.getElementById('tab-track-2');
    el.tab1TextFull = document.getElementById('tab1-text-full');
    el.tab1TextShort = document.getElementById('tab1-text-short');
    el.tab2TextFull = document.getElementById('tab2-text-full');
    el.tab2TextShort = document.getElementById('tab2-text-short');
    el.trackVoicePill = document.getElementById('trackVoicePill');
    el.trackTabs = document.querySelector('.track-switcher-wrap') || document.querySelector('.track-tabs');
    el.scoreFilterWrap = document.getElementById('score-filter-wrap');
    
    el.paperContent = document.getElementById('paper-content');
    
    el.playBtn = document.getElementById('dock-play-btn');
    el.prevBtn = document.getElementById('dock-prev-btn');
    el.nextBtn = document.getElementById('dock-next-btn');
    el.rewindBtn = document.getElementById('dock-rewind-btn');
    el.forwardBtn = document.getElementById('dock-forward-btn');
    
    el.timeCurrent = document.getElementById('time-current');
    el.timeTotal = document.getElementById('time-total');
    el.progressBar = document.getElementById('progress-bar');
    el.progressFill = document.getElementById('progress-fill');
    
    el.speedBtn = document.getElementById('btn-speed');
    el.loopModeBtn = document.getElementById('btn-loop-mode');
    el.dockTitle = document.getElementById('dock-title');
    el.dockTrackPill = document.getElementById('dock-track-pill');
    
    el.themeToggleBtn = document.getElementById('btn-theme-toggle');
    el.fontDecBtn = document.getElementById('btn-font-dec');
    el.fontIncBtn = document.getElementById('btn-font-inc');
    el.sidebar = document.getElementById('sidebar');
    el.mobileMenuBtn = document.getElementById('btn-mobile-menu');
    el.subjectPolBtn = document.getElementById('btn-subject-pol');
    el.polSubmodeBar = document.getElementById('pol-submode-bar');
    el.polCategoryPills = document.getElementById('pol-category-pills');
    el.stagePolNav = document.getElementById('stage-pol-nav');
    el.stagePolSubmodeBar = document.getElementById('stage-pol-submode-bar');
    el.stagePolCategoryPills = document.getElementById('stage-pol-category-pills');
    el.backdrop = document.getElementById('sidebar-backdrop');
    
    // 全息态感知条 (Now-Playing HUD)
    el.dockHudBar = document.getElementById('dockHudBar');
    el.hudTrackBadge = document.getElementById('hudTrackBadge');
    el.hudTrackText = document.getElementById('hudTrackText');
    el.hudTitleText = document.getElementById('hudTitleText');
    el.hudFrameworkTrigger = document.getElementById('hudFrameworkTrigger');
    el.hudFrameworkText = document.getElementById('hudFrameworkText');
    el.btnOpenOutline = document.getElementById('btnOpenOutline');
    
    // 答题思维骨架抽屉 (Outline Drawer)
    el.outlineDrawerBackdrop = document.getElementById('outlineDrawerBackdrop');
    el.outlineDrawer = document.getElementById('outlineDrawer');
    el.outlineDrawerClose = document.getElementById('outlineDrawerClose');
    el.drawerTrackBadge = document.getElementById('drawerTrackBadge');
    el.drawerTopicSub = document.getElementById('drawerTopicSub');
    el.outlineDrawerBody = document.getElementById('outlineDrawerBody');
    el.playModeDrawer = document.getElementById('playModeDrawer');
    el.playModeBackdrop = document.getElementById('playModeBackdrop');
    el.playModeClose = document.getElementById('playModeClose');
    el.playModeList = document.getElementById('playModeList');
    el.clozeModeBtn = document.getElementById('btn-cloze-mode');
    el.clozeModeName = document.getElementById('cloze-mode-name');

    // 掌握度与研学进度看板元素
    el.masteryPillsWrap = document.getElementById('mastery-pills-wrap');
    el.btnMasteryToggle = document.getElementById('btn-mastery-toggle');
    el.masteryBtnIcon = document.getElementById('masteryBtnIcon');
    el.masteryBtnText = document.getElementById('masteryBtnText');
    
    el.btnStudyDashboard = document.getElementById('btn-study-dashboard');
    el.studyDashboardBackdrop = document.getElementById('studyDashboardBackdrop');
    el.studyDashboardDrawer = document.getElementById('studyDashboardDrawer');
    el.studyDashboardClose = document.getElementById('studyDashboardClose');
    el.studyDashboardBody = document.getElementById('studyDashboardBody');
    
    el.dashStreakCount = document.getElementById('dashStreakCount');
    el.btnDashPunchToday = document.getElementById('btnDashPunchToday');
    el.dashPunchBtnText = document.getElementById('dashPunchBtnText');
    el.dashTotalScoreText = document.getElementById('dashTotalScoreText');
    el.dashTotalBarMastered = document.getElementById('dashTotalBarMastered');
    el.dashTotalBarFamiliar = document.getElementById('dashTotalBarFamiliar');
    el.dashTotalMasteredNum = document.getElementById('dashTotalMasteredNum');
    el.dashTotalFamiliarNum = document.getElementById('dashTotalFamiliarNum');
    el.dashTotalUnlearnedNum = document.getElementById('dashTotalUnlearnedNum');
    
    el.dashRatio807 = document.getElementById('dashRatio807');
    el.dashBar807Mastered = document.getElementById('dashBar807Mastered');
    el.dashBar807Familiar = document.getElementById('dashBar807Familiar');
    el.dashDetail807 = document.getElementById('dashDetail807');
    
    el.dashRatio706 = document.getElementById('dashRatio706');
    el.dashBar706Mastered = document.getElementById('dashBar706Mastered');
    el.dashBar706Familiar = document.getElementById('dashBar706Familiar');
    el.dashDetail706 = document.getElementById('dashDetail706');
    
    el.dashRatioPol = document.getElementById('dashRatioPol');
    el.dashBarPolMastered = document.getElementById('dashBarPolMastered');
    el.dashBarPolFamiliar = document.getElementById('dashBarPolFamiliar');
    el.dashDetailPol = document.getElementById('dashDetailPol');

    el.dashRatioEn = document.getElementById('dashRatioEn');
    el.dashBarEnMastered = document.getElementById('dashBarEnMastered');
    el.dashBarEnFamiliar = document.getElementById('dashBarEnFamiliar');
    el.dashDetailEn = document.getElementById('dashDetailEn');
    
    el.dashT0Percent = document.getElementById('dashT0Percent');
    el.dashBarT0Mastered = document.getElementById('dashBarT0Mastered');
    el.dashT0Ratio = document.getElementById('dashT0Ratio');
    
    el.dashT1Percent = document.getElementById('dashT1Percent');
    el.dashBarT1Mastered = document.getElementById('dashBarT1Mastered');
    el.dashT1Ratio = document.getElementById('dashT1Ratio');
    
    el.btnDashRandomPick = document.getElementById('btnDashRandomPick');
  }

  // 加载数据包 (优先调用已嵌入的 window.KAOYAN_MANIFEST，彻底免疫 file:/// 下的 CORS 阻断)
  async function loadManifestData() {
    loadMasteryData();

    // 1. 等待 window.KAOYAN_MANIFEST 就绪（防移动端大脚本异步解析微竞态）
    let waitLoops = 0;
    while (!window.KAOYAN_MANIFEST && waitLoops < 15) {
      await new Promise(r => setTimeout(r, 100));
      waitLoops++;
    }

    if (window.KAOYAN_MANIFEST) {
      state.allData = window.KAOYAN_MANIFEST;
    } else {
      try {
        const res = await fetch('data/kaoyan_all_manifest.json?t=' + Date.now());
        if (res.ok) {
          state.allData = await res.json();
        }
      } catch (err) {
        console.error('Failed to load data:', err);
      }
    }

    if (!state.allData) {
      if (el.questionTitle) el.questionTitle.textContent = '手卷装载提醒';
      if (el.itemList) {
        el.itemList.innerHTML = `<div style="padding:40px 16px;text-align:center;color:var(--accent-red);font-size:13px;">数据装载受阻，请点击主界面重试</div>`;
      }
      if (el.paperContent) {
        el.paperContent.innerHTML = `
          <div style="padding:40px 20px;text-align:center;max-width:440px;margin:32px auto;background:var(--bg-card);border-radius:18px;border:1px solid var(--border-soft);box-shadow:0 6px 24px rgba(0,0,0,0.06);">
            <div style="width:54px;height:54px;margin:0 auto 16px;border-radius:50%;background:rgba(184,51,42,0.1);display:inline-flex;align-items:center;justify-content:center;color:var(--accent-red);">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
            </div>
            <h3 style="font-size:17px;font-weight:600;margin-bottom:8px;color:var(--ink-dark);">离线题库数据装载未完成</h3>
            <p style="font-size:13px;line-height:1.6;color:var(--ink-muted);margin-bottom:24px;">网络波动可能中断了首屏离线数据包初始化。请点击下方按钮重新装载，或一键清除离线缓存。</p>
            <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
              <button type="button" onclick="window.location.reload()" style="display:inline-flex;align-items:center;gap:6px;padding:10px 20px;border-radius:99px;background:var(--accent-red);color:#fff;font-size:14px;font-weight:500;border:none;cursor:pointer;">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                <span>立即刷新重试</span>
              </button>
              <button type="button" onclick="if('caches' in window){caches.keys().then(k=>Promise.all(k.map(c=>caches.delete(c)))).then(()=>window.location.reload());}else{window.location.reload();}" style="display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:99px;background:transparent;color:var(--ink-muted);font-size:13px;border:1px solid var(--border-soft);cursor:pointer;">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                <span>重置离线缓存</span>
              </button>
            </div>
          </div>
        `;
      }
      return;
    }

    // 恢复上次背诵的音轨
    const savedTrack = localStorage.getItem('kaoyan_last_track');
    if (savedTrack && (savedTrack === '1' || savedTrack === '2')) {
      state.currentTrack = parseInt(savedTrack, 10);
      if (el.tabTrack1) el.tabTrack1.classList.toggle('active', state.currentTrack === 1);
      if (el.tabTrack2) el.tabTrack2.classList.toggle('active', state.currentTrack === 2);
    }

    // 基础初始化必须完整执行（包含全科打卡徽标计算等）
    updateBadgeCounts();

    // 恢复上次背诵的科目
    const savedSubject = localStorage.getItem('kaoyan_last_subject');
    if (savedSubject === 'pol') {
      switchSubject('pol');
    } else {
      if (savedSubject && ['807', '706', 'en'].includes(savedSubject)) {
        state.currentSubject = savedSubject;
        if (el.subject807Btn) el.subject807Btn.classList.toggle('active', savedSubject === '807');
        if (el.subject706Btn) el.subject706Btn.classList.toggle('active', savedSubject === '706');
        if (el.subjectPolBtn) el.subjectPolBtn.classList.toggle('active', savedSubject === 'pol');
        if (el.subjectEnBtn) el.subjectEnBtn.classList.toggle('active', savedSubject === 'en');
        updateSubjectUI(savedSubject);
      }
      renderFilterPills();
      renderSidebarList();
      
      // 恢复上次听到的知识点，不再每次进入都回到最开始的第一题
      const defaultList = getCurrentItemsList();
      const savedItemId = localStorage.getItem(`kaoyan_last_item_${state.currentSubject}`) || localStorage.getItem('kaoyan_last_item_id');
      const targetItem = (savedItemId && defaultList.find(x => x.id === savedItemId)) || defaultList[0];
      if (targetItem) {
        selectItem(targetItem.id, false, true);
      }
      // 空闲静默预加载政治数据包，确保看板统计、全科抽查与底栏数量即时完整
      setTimeout(() => {
        if (!window.KAOYAN_POL_DATA && !isPolDataLoading) {
          ensurePolDataLoaded({ silent: true }).catch(() => {});
        }
      }, 900);
    }
  }

  function getCurrentItemsList() {
    if (!state.allData) return [];
    let rawList;
    if (state.currentSubject === 'pol') {
      return getPolItemList();
    }
    if (state.currentSubject === '807') {
      rawList = state.allData.items_807;
    } else if (state.currentSubject === '706') {
      rawList = state.allData.items_706;
    } else {
      rawList = state.allData.items_en;
    }
    if (!rawList) return [];

    return rawList.filter(item => {
      if (state.tierFilter !== 'all') {
        if (state.currentSubject === 'en') {
          if (item.category_id !== state.tierFilter) return false;
        } else {
          if (item.level !== state.tierFilter) return false;
        }
      }
      if (state.masteryFilter !== 'all') {
        const mStatus = getMasteryStatus(item.id);
        if (state.masteryFilter !== mStatus) return false;
      }
      if (state.scoreFilter !== 'all') {
        if (state.scoreFilter === '30' && !item.score.includes('30')) return false;
        if (state.scoreFilter === '20' && !item.score.includes('20')) return false;
      }
      if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        const inTitle = (item.title || '').toLowerCase().includes(q);
        const inTopic = (item.topic || '').toLowerCase().includes(q);
        const inAuthor = (item.author || '').toLowerCase().includes(q);
        const inStem = (item.stem || '').toLowerCase().includes(q);
        if (!inTitle && !inTopic && !inAuthor && !inStem) return false;
      }
      return true;
    });
  }

  function updateBadgeCounts() {
    if (!state.allData) return;
    const i807 = state.allData.items_807 || [];
    const i706 = state.allData.items_706 || [];
    const iEn = state.allData.items_en || [];

    const m807 = i807.filter(x => getMasteryStatus(x.id) === 'mastered').length;
    const m706 = i706.filter(x => getMasteryStatus(x.id) === 'mastered').length;
    const mEn = iEn.filter(x => getMasteryStatus(x.id) === 'mastered').length;

    const checkIconSvg = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" style="display:inline-block;vertical-align:-1px;margin-right:2px;"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    if (el.count807) {
      el.count807.innerHTML = `${i807.length}题${m807 > 0 ? ` · <span style="color:var(--vermilion);font-weight:700;">${checkIconSvg}${m807}</span>` : ''}`;
    }
    if (el.count706) {
      el.count706.innerHTML = `${i706.length}题${m706 > 0 ? ` · <span style="color:var(--vermilion);font-weight:700;">${checkIconSvg}${m706}</span>` : ''}`;
    }
    if (el.countEn) {
      el.countEn.innerHTML = `${iEn.length}篇${mEn > 0 ? ` · <span style="color:var(--vermilion);font-weight:700;">${checkIconSvg}${mEn}</span>` : ''}`;
    }

    let polItems = [];
    if (window.KAOYAN_POL_DATA) {
      polItems = [
        ...(window.KAOYAN_POL_DATA.chapters47 || []),
        ...(window.KAOYAN_POL_DATA.xutao16 || []),
        ...(window.KAOYAN_POL_DATA.tuijie11 || [])
      ];
    }
    const polTotal = polItems.length || 74;
    const mPol = polItems.length
      ? polItems.filter(x => getMasteryStatus(x.id) === 'mastered').length
      : Object.keys(state.masteryState).filter(k => (k.startsWith('ch_') || k.startsWith('pol_')) && state.masteryState[k] === 'mastered').length;

    if (el.countPol) {
      el.countPol.innerHTML = `${polTotal}讲${mPol > 0 ? ` · <span style="color:var(--vermilion);font-weight:700;">${checkIconSvg}${mPol}</span>` : ''}`;
    }
  }

  function renderFilterPills() {
    if (!el.filterPillsWrap) return;
    el.filterPillsWrap.innerHTML = '';
    
    if (state.currentSubject === 'en') {
      const pills = [
        { id: 'all', label: '全部范文 (16)' },
        { id: 'essay_letter', label: '高分书信 (6)' },
        { id: 'essay_notice', label: '告示通知 (2)' },
        { id: 'essay_picture', label: '真题图画 (6)' },
        { id: 'essay_chart', label: '真题图表 (2)' }
      ];
      pills.forEach(p => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `filter-pill ${state.tierFilter === p.id ? 'active' : ''}`;
        btn.dataset.filter = p.id;
        btn.dataset.tier = p.id;
        btn.textContent = p.label;
        btn.addEventListener('click', () => {
          state.tierFilter = p.id;
          el.filterPillsWrap.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          renderSidebarList();

          const matchingList = getCurrentItemsList();
          if (matchingList.length > 0) {
            const currentStillMatches = matchingList.some(it => it.id === state.activeItemId);
            if (!currentStillMatches) {
              selectItem(matchingList[0].id, false);
            }
          }
        });
        el.filterPillsWrap.appendChild(btn);
      });
    } else {
      const pills = [
        { id: 'all', label: '全部考点' },
        { id: 'T0', label: 'T0 极高频必背' },
        { id: 'T1', label: 'T1 核心考点' },
        { id: 'T2', label: 'T2 重点拓展' }
      ];
      pills.forEach(p => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `filter-pill ${state.tierFilter === p.id ? 'active' : ''}`;
        btn.dataset.filter = p.id;
        btn.dataset.tier = p.id;
        btn.textContent = p.label;
        btn.addEventListener('click', () => {
          state.tierFilter = p.id;
          el.filterPillsWrap.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          renderSidebarList();

          const matchingList = getCurrentItemsList();
          if (matchingList.length > 0) {
            const currentStillMatches = matchingList.some(it => it.id === state.activeItemId);
            if (!currentStillMatches) {
              selectItem(matchingList[0].id, false);
            }
          }
        });
        el.filterPillsWrap.appendChild(btn);
      });
    }
  }

  function updateSubjectUI(sub) {
    document.body.setAttribute('data-subject', sub);
    if (sub === 'en') {
      if (el.headerVoiceBadge) {
        el.headerVoiceBadge.innerHTML = 'Emily（纯正美音）+ 龙安立（中文导引）';
      }
      if (el.tab1TextFull) el.tab1TextFull.textContent = '【轨道一】考场高分纯英文范文';
      if (el.tab1TextShort) el.tab1TextShort.textContent = '轨道一 · 考场纯享';
      if (el.tab2TextFull) el.tab2TextFull.textContent = '【轨道二】答题骨架与变体精解';
      if (el.tab2TextShort) el.tab2TextShort.textContent = '轨道二 · 双轨精解';
      if (el.trackVoicePill) el.trackVoicePill.textContent = 'Emily + 龙安立';
    } else {
      if (el.headerVoiceBadge) {
        el.headerVoiceBadge.innerHTML = '龙安朗 · 清爽利落全段通读';
      }
      if (el.tab1TextFull) el.tab1TextFull.textContent = '【轨道一】考场直接答题完整版';
      if (el.tab1TextShort) el.tab1TextShort.textContent = '轨道一 · 考场答题版';
      if (el.tab2TextFull) el.tab2TextFull.textContent = '【轨道二】答题版内部逻辑精解版';
      if (el.tab2TextShort) el.tab2TextShort.textContent = '轨道二 · 逻辑精解版';
      if (el.trackVoicePill) el.trackVoicePill.textContent = '龙安朗 · 通读';
    }
  }

  function switchSubject(sub) {
    if (state.currentSubject === sub) return;
    state.currentSubject = sub;
    
    // 跨科切换状态隔离：立即暂停原音频并注销帧循环与残余焦点，杜绝幽灵音频与回调穿透
    if (audio && !audio.paused) {
      audio.pause();
    }
    if (syncRafId) {
      cancelAnimationFrame(syncRafId);
      syncRafId = null;
    }
    lastSpotlightEl = null;
    
    if (el.subject807Btn) el.subject807Btn.classList.toggle('active', sub === '807');
    if (el.subject706Btn) el.subject706Btn.classList.toggle('active', sub === '706');
    if (el.subjectPolBtn) el.subjectPolBtn.classList.toggle('active', sub === 'pol');
    if (el.subjectEnBtn) el.subjectEnBtn.classList.toggle('active', sub === 'en');
    
    updateSubjectUI(sub);

    // a) 跨科目切换时，必须完全重置过滤状态
    state.tierFilter = 'all';
    state.masteryFilter = 'all';
    state.scoreFilter = 'all';
    state.searchQuery = '';
    if (el.searchInput) el.searchInput.value = '';
    const clearBtnOnSwitch = document.getElementById('btn-clear-search');
    if (clearBtnOnSwitch) clearBtnOnSwitch.style.display = 'none';
    resetAudioProgressUI();

    // 同步重置 DOM 中所有 filter pills 的 active 状态
    document.querySelectorAll('#mastery-pills-wrap .filter-pill').forEach(b => {
      b.classList.toggle('active', b.dataset.mastery === 'all');
    });
    if (el.scoreFilterWrap) {
      el.scoreFilterWrap.querySelectorAll('.filter-pill').forEach(b => {
        b.classList.toggle('active', b.dataset.score === 'all' || !b.dataset.score);
      });
    }
    document.querySelectorAll('[data-pol-cat]').forEach(b => {
      b.classList.toggle('active', b.dataset.polCat === 'all');
    });

    localStorage.setItem('kaoyan_last_subject', sub);

    if (sub === 'pol') {
      if (el.polSubmodeBar) el.polSubmodeBar.style.display = 'flex';
      if (el.polCategoryPills) el.polCategoryPills.style.display = state.polSubMode === 'recite47' ? 'flex' : 'none';
      if (el.stagePolNav) el.stagePolNav.style.display = 'block';
      if (el.stagePolCategoryPills) el.stagePolCategoryPills.style.display = state.polSubMode === 'recite47' ? 'flex' : 'none';
      if (el.filterPillsWrap) el.filterPillsWrap.style.display = 'none';
      if (el.scoreFilterWrap) el.scoreFilterWrap.style.display = 'none';

      // 恢复激活状态高亮
      document.querySelectorAll('.pol-submode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.polSubmode === state.polSubMode);
      });
      document.querySelectorAll('[data-pol-cat]').forEach(b => {
        b.classList.toggle('active', b.dataset.polCat === state.polCategory);
      });

      return ensurePolDataLoaded().then(() => {
        if (state.currentSubject !== 'pol') return; // 用户已切走，终止过期的异步回调
        renderSidebarList();
        let list = getCurrentItemsList();
        if (!list || list.length === 0) {
          list = getPolItemList() || [];
        }
        const savedForSub = localStorage.getItem(`kaoyan_last_item_${sub}`);
        let targetItem = (savedForSub && list.find(x => x.id === savedForSub)) || list[0];
        if (targetItem) {
          selectItem(targetItem.id, false);
        }
      });
      return;
    } else {
      // e) 检查从 pol 切到专业课时：必须清理 paperContent 上的任何政治类名与残留 HTML，强制让专业课的 renderPaperContent 完整接管！
      if (el.polSubmodeBar) el.polSubmodeBar.style.display = 'none';
      if (el.polCategoryPills) el.polCategoryPills.style.display = 'none';
      if (el.stagePolNav) el.stagePolNav.style.display = 'none';
      if (el.stagePolCategoryPills) el.stagePolCategoryPills.style.display = 'none';
      if (el.filterPillsWrap) el.filterPillsWrap.style.display = 'flex';
      if (el.scoreFilterWrap) el.scoreFilterWrap.style.display = (sub === 'en' ? 'none' : '');
      if (el.trackTabs) el.trackTabs.style.display = '';
      if (el.paperContent) {
        el.paperContent.classList.remove('pol-scope');
        el.paperContent.innerHTML = '';
      }
    }

    renderFilterPills();
    renderSidebarList();

    // b) 计算 list = getCurrentItemsList()。若 list 为空（做防御性容错），则强制重置后重新取 rawList
    let list = getCurrentItemsList();
    if (!list || list.length === 0) {
      state.tierFilter = 'all';
      state.masteryFilter = 'all';
      state.scoreFilter = 'all';
      state.searchQuery = '';
      if (sub === '807') list = state.allData?.items_807 || [];
      else if (sub === '706') list = state.allData?.items_706 || [];
      else if (sub === 'en') list = state.allData?.items_en || [];
      else list = [];
    }

    // c) 寻找 targetItem：如果用户之前在政治（或其他科目），savedForSub 在当前科目的列表中不存在，必须坚决 fallback 到当前科目的第一项 list[0]！
    const savedForSub = localStorage.getItem(`kaoyan_last_item_${sub}`);
    let targetItem = null;
    if (savedForSub && list.length > 0) {
      targetItem = list.find(x => x.id === savedForSub);
    }
    if (!targetItem && list.length > 0) {
      targetItem = list[0];
    }

    // d) 强制调用 selectItem(targetItem.id, false)
    if (targetItem) {
      selectItem(targetItem.id, false);
    }
  }

  function renderSidebarList() {
    if (!el.itemList) return;
    const items = getCurrentItemsList();
    el.itemList.innerHTML = '';

    if (items.length === 0) {
      el.itemList.innerHTML = `
        <div style="padding: 40px 16px; text-align: center; color: var(--ink-muted); font-size: 13px;">
          <div style="margin-bottom:12px;">未检索到符合条件的考点题目</div>
          <button type="button" class="btn-reset-filters" id="btnResetFilters" style="padding:5px 14px;font-size:12px;font-weight:600;border:1px solid var(--line-strong);border-radius:14px;background:var(--bg-card);color:var(--vermilion);cursor:pointer;transition:all 0.2s;">
            重置筛选条件
          </button>
        </div>`;
      const btnReset = el.itemList.querySelector('#btnResetFilters');
      if (btnReset) {
        btnReset.addEventListener('click', () => {
          state.masteryFilter = 'all';
          state.searchQuery = '';
          state.polCategory = 'all';
          state.tierFilter = 'all';
          state.scoreFilter = 'all';
          if (el.searchInput) el.searchInput.value = '';
          const clearBtn = document.getElementById('btn-clear-search');
          if (clearBtn) clearBtn.style.display = 'none';
          document.querySelectorAll('#mastery-pills-wrap .filter-pill').forEach(b => b.classList.toggle('active', b.dataset.mastery === 'all'));
          document.querySelectorAll('#filter-pills-wrap .filter-pill').forEach(b => b.classList.toggle('active', b.dataset.tier === 'all'));
          if (el.scoreFilterWrap) el.scoreFilterWrap.querySelectorAll('.filter-pill').forEach(b => b.classList.toggle('active', b.dataset.score === 'all' || !b.dataset.score));
          document.querySelectorAll('[data-pol-cat]').forEach(b => b.classList.toggle('active', b.dataset.polCat === 'all'));
          localStorage.setItem('kaoyan_pol_cat', 'all');
          renderSidebarList();
          const list = getCurrentItemsList();
          if (list.length > 0) selectItem(list[0].id, false);
        });
      }
      return;
    }

    items.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = `question-card-item ${item.id === state.activeItemId ? 'active' : ''}`;
      card.dataset.id = item.id;

      const mStatus = getMasteryStatus(item.id);
      let masteryBadgeHtml = '';
      if (mStatus === 'mastered') {
        masteryBadgeHtml = `<span class="card-mastery-badge seal-mastered" title="已背熟掌握（朱砂印）"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>已掌握</span>`;
      } else if (mStatus === 'familiar') {
        masteryBadgeHtml = `<span class="card-mastery-badge badge-familiar" title="磨耳熟悉中"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle></svg>磨耳</span>`;
      } else {
        masteryBadgeHtml = `<span class="card-mastery-badge badge-unlearned" title="未背诵待攻克">待攻克</span>`;
      }

      if (state.currentSubject === 'pol') {
        const isRecite47 = state.polSubMode === 'recite47';
        const isXt = state.polSubMode === 'xutao16';
        const subCount = (item.track2 && item.track2.subCards) ? item.track2.subCards.length : 0;
        const tagText = isRecite47 ? (item.importance || '必背') : (isXt ? '16天带背' : '冲刺背诵');
        const scoreText = isRecite47 ? (item.chapterNum || `第${idx+1}章`) : `Day ${item.day}`;
        const descText = isRecite47 ? `${item.categoryName || '考研政治'} · ${subCount}微考点` : (isXt ? `${item.points ? item.points.length : 0}个核心题眼` : '考前冲刺必背');

        card.innerHTML = `
          <div class="card-top-meta">
            <div class="card-tag-group">
              <span class="tier-badge tier-T0">${tagText}</span>
              <span class="score-badge">${scoreText}</span>
              ${masteryBadgeHtml}
            </div>
            <span class="card-audio-status has-audio" title="伴读音频已就绪">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
              </svg>
              音频
            </span>
          </div>
          <div class="card-title">${item.title}</div>
          <div class="card-desc-meta">
            <span>${descText}</span>
          </div>
        `;
      } else {
        const hasAudio = item.track1 && item.track1.has_audio;
        const audioStatusHtml = hasAudio 
          ? `<span class="card-audio-status has-audio" title="通读音频已就绪">
               <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                 <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                 <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
               </svg>
               ${state.currentSubject === 'en' ? '范文' : '通读'}
             </span>`
          : `<span class="card-audio-status" title="文本已就绪">
               <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                 <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                 <polyline points="14 2 14 8 20 8"></polyline>
               </svg>
               文本
             </span>`;

        card.innerHTML = `
          <div class="card-top-meta">
            <div class="card-tag-group">
              <span class="tier-badge tier-${item.level}">${item.level}</span>
              <span class="score-badge">${item.score}</span>
              ${masteryBadgeHtml}
            </div>
            ${audioStatusHtml}
          </div>
          <div class="card-title">${item.title}</div>
          <div class="card-desc-meta">
            <span>考点 #${idx + 1}</span>
            <span>${item.author || ''}</span>
          </div>
        `;
      }

      card.addEventListener('click', () => {
        selectItem(item.id);
        const studyTab = document.getElementById('nav-tab-study');
        if (studyTab) studyTab.click();
        if (isSidebarDrawerMode() && el.sidebar) {
          closeSidebar();
        }
      });

      el.itemList.appendChild(card);
    });
  }

  // ==========================================
  // 考题掌握状态与研学打卡系统 (Mastery & Study Dashboard)
  // ==========================================
  function loadMasteryData() {
    try {
      const savedMastery = localStorage.getItem('kaoyan_mastery_state');
      if (savedMastery) state.masteryState = JSON.parse(savedMastery);
      // 兼容迁移旧版政治打卡章节
      const oldPolStudied = localStorage.getItem('xt_v3_studied_chapters');
      if (oldPolStudied) {
        try {
          const arr = JSON.parse(oldPolStudied);
          if (Array.isArray(arr)) {
            arr.forEach(id => {
              if (!state.masteryState[id]) state.masteryState[id] = 'mastered';
            });
          }
        } catch(e) {}
      }
      state.masteryMap = state.masteryState;
    } catch (e) {
      console.warn('Failed to parse kaoyan_mastery_state:', e);
      state.masteryState = {};
      state.masteryMap = state.masteryState;
    }

    try {
      const savedLogs = localStorage.getItem('kaoyan_study_logs');
      if (savedLogs) {
        state.studyLogs = JSON.parse(savedLogs);
        if (!Array.isArray(state.studyLogs.dates)) state.studyLogs.dates = [];
      } else {
        state.studyLogs = { dates: [], totalCardsCompleted: 0 };
      }
    } catch (e) {
      console.warn('Failed to parse kaoyan_study_logs:', e);
      state.studyLogs = { dates: [], totalCardsCompleted: 0 };
    }
  }

  function saveMasteryData() {
    try {
      localStorage.setItem('kaoyan_mastery_state', JSON.stringify(state.masteryState));
    } catch (e) {
      console.warn('Failed to save kaoyan_mastery_state:', e);
    }
  }

  function saveStudyLogs() {
    try {
      localStorage.setItem('kaoyan_study_logs', JSON.stringify(state.studyLogs));
    } catch (e) {
      console.warn('Failed to save kaoyan_study_logs:', e);
    }
  }

  function getTodayDateStr() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function recordStudyPunch(itemId = null) {
    const today = getTodayDateStr();
    if (!state.studyLogs.dates.includes(today)) {
      state.studyLogs.dates.push(today);
    }
    state.studyLogs.dates.sort();
    if (itemId) {
      if (!Array.isArray(state.studyLogs.completedIds)) state.studyLogs.completedIds = [];
      if (!state.studyLogs.completedIds.includes(itemId)) {
        state.studyLogs.completedIds.push(itemId);
      }
      state.studyLogs.totalCardsCompleted = Math.max(
        state.studyLogs.completedIds.length,
        Object.values(state.masteryState || {}).filter(v => v === 'mastered').length
      );
    }
    saveStudyLogs();
    updateStudyDashboardUI();
  }

  function calcContinuousStreak() {
    const dates = state.studyLogs.dates || [];
    if (dates.length === 0) return 0;

    const todayStr = getTodayDateStr();
    const dateSet = new Set(dates);

    let checkDate = new Date();
    let curStr = getTodayDateStr();
    if (!dateSet.has(curStr)) {
      checkDate.setDate(checkDate.getDate() - 1);
      const y = checkDate.getFullYear();
      const m = String(checkDate.getMonth() + 1).padStart(2, '0');
      const d = String(checkDate.getDate()).padStart(2, '0');
      curStr = `${y}-${m}-${d}`;
      if (!dateSet.has(curStr)) {
        return 0;
      }
    }

    let streak = 0;
    while (true) {
      const y = checkDate.getFullYear();
      const m = String(checkDate.getMonth() + 1).padStart(2, '0');
      const d = String(checkDate.getDate()).padStart(2, '0');
      const ds = `${y}-${m}-${d}`;
      if (dateSet.has(ds)) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }
    return Math.max(1, streak);
  }

  function getMasteryStatus(itemId) {
    if (!itemId) return 'unlearned';
    return state.masteryState[itemId] || 'unlearned';
  }

  function setMasteryStatus(itemId, newStatus) {
    if (!itemId) return;
    state.masteryState[itemId] = newStatus;
    saveMasteryData();

    if (newStatus === 'mastered') {
      recordStudyPunch(itemId);
      showToast('恭贺功不唐捐！已盖印【已背熟掌握】朱砂印章，今日研学打卡成功！', 2500);
    } else if (newStatus === 'familiar') {
      showToast('已标记为【磨耳熟悉中】· 坚持晨昏听读，必定水到渠成', 2000);
    } else {
      showToast('已重置为【未背诵·待攻克】', 1800);
    }

    updateHeaderMasteryUI();
    renderSidebarList();
    updateBadgeCounts();
    if (el.studyDashboardDrawer && el.studyDashboardDrawer.classList.contains('open')) {
      updateStudyDashboardUI();
    }
  }

  function cycleCurrentItemMastery() {
    if (!state.activeItemId) return;
    const cur = getMasteryStatus(state.activeItemId);
    const next = cur === 'unlearned' ? 'familiar' : (cur === 'familiar' ? 'mastered' : 'unlearned');
    setMasteryStatus(state.activeItemId, next);
  }

  function updateHeaderMasteryUI() {
    if (!el.btnMasteryToggle || !state.activeItemId) return;
    const status = getMasteryStatus(state.activeItemId);

    el.btnMasteryToggle.className = `mastery-toggle-btn status-${status}`;
    if (status === 'mastered') {
      if (el.masteryBtnIcon) {
        el.masteryBtnIcon.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
      }
      if (el.masteryBtnText) el.masteryBtnText.textContent = '已背熟掌握';
      el.btnMasteryToggle.title = '当前考题：已背熟掌握（朱砂印章）· 点击可切换状态';
    } else if (status === 'familiar') {
      if (el.masteryBtnIcon) {
        el.masteryBtnIcon.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
      }
      if (el.masteryBtnText) el.masteryBtnText.textContent = '磨耳熟悉中';
      el.btnMasteryToggle.title = '当前考题：磨耳熟悉中 · 点击切换为已背熟掌握';
    } else {
      if (el.masteryBtnIcon) {
        el.masteryBtnIcon.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"></circle></svg>`;
      }
      if (el.masteryBtnText) el.masteryBtnText.textContent = '未背诵';
      el.btnMasteryToggle.title = '当前考题：未背诵 · 点击切换为磨耳熟悉中';
    }

    // 实时联动同步页面上所有 .seal-btn 研毕印章按钮状态
    if (el.paperContent) {
      const sealBtns = el.paperContent.querySelectorAll('.seal-btn, [id^="sealBtn_"]');
      sealBtns.forEach(b => {
        const isMastered = (status === 'mastered');
        b.classList.toggle('sealed', isMastered);
        const spans = b.querySelectorAll('span');
        if (spans.length >= 2) {
          spans[1].textContent = isMastered ? '已落印研毕' : '落印研毕';
        }
      });
    }
  }

  function openStudyDashboard() {
    if (!el.studyDashboardDrawer) return;
    updateStudyDashboardUI();
    el.studyDashboardDrawer.classList.add('open');
    setPlayerDockReceded(true);
    if (el.studyDashboardBackdrop) el.studyDashboardBackdrop.style.display = 'block';
    lockBodyScroll('studyDashboardDrawer');
    setBottomNavActiveTab('dashboard');
    if (!window.KAOYAN_POL_DATA) {
      ensurePolDataLoaded({ silent: true }).then(() => {
        if (el.studyDashboardDrawer && el.studyDashboardDrawer.classList.contains('open')) {
          updateStudyDashboardUI();
        }
      }).catch(() => {});
    }
  }

  function closeStudyDashboard() {
    if (!el.studyDashboardDrawer) return;
    el.studyDashboardDrawer.classList.remove('open');
    if (el.studyDashboardBackdrop) el.studyDashboardBackdrop.style.display = 'none';
    unlockBodyScroll('studyDashboardDrawer');
    setPlayerDockReceded(false);
    const navDash = document.getElementById('nav-tab-dashboard');
    if (navDash && navDash.classList.contains('active')) {
      setBottomNavActiveTab('');
    }
  }

  function updateStudyDashboardUI() {
    if (!state.allData) return;

    // 1. 连续打卡与今日打卡状态
    const streak = calcContinuousStreak();
    if (el.dashStreakCount) el.dashStreakCount.textContent = streak;

    const todayStr = getTodayDateStr();
    const hasPunchedToday = (state.studyLogs.dates || []).includes(todayStr);
    if (el.btnDashPunchToday) {
      el.btnDashPunchToday.classList.toggle('punched', hasPunchedToday);
      if (el.dashPunchBtnText) {
        el.dashPunchBtnText.textContent = hasPunchedToday ? '今日已打卡' : '完成今日打卡';
      }
    }

    // 2. 统计各科目与全科题数
    const items807 = state.allData.items_807 || [];
    const items706 = state.allData.items_706 || [];
    const itemsEn = state.allData.items_en || [];
    let polItems = [];
    if (window.KAOYAN_POL_DATA) {
      polItems = [
        ...(window.KAOYAN_POL_DATA.chapters47 || []),
        ...(window.KAOYAN_POL_DATA.xutao16 || []),
        ...(window.KAOYAN_POL_DATA.tuijie11 || [])
      ];
    }
    const allItems = [...items807, ...items706, ...itemsEn, ...polItems];

    function calcStats(list) {
      let m = 0, f = 0, u = 0;
      list.forEach(item => {
        const s = getMasteryStatus(item.id);
        if (s === 'mastered') m++;
        else if (s === 'familiar') f++;
        else u++;
      });
      return { total: list.length, m, f, u, percent: list.length ? Math.round((m / list.length) * 100) : 0 };
    }

    const totalStats = calcStats(allItems);
    const s807 = calcStats(items807);
    const s706 = calcStats(items706);
    const sEn = calcStats(itemsEn);

    // 全科总攻克进度
    if (el.dashTotalScoreText) {
      el.dashTotalScoreText.textContent = `已攻克 ${totalStats.m} / ${totalStats.total} 题 (${totalStats.percent}%)`;
    }
    if (el.dashTotalBarMastered) {
      el.dashTotalBarMastered.style.width = `${totalStats.percent}%`;
    }
    if (el.dashTotalBarFamiliar) {
      const famPercent = totalStats.total ? (totalStats.f / totalStats.total) * 100 : 0;
      el.dashTotalBarFamiliar.style.width = `${famPercent}%`;
    }
    if (el.dashTotalMasteredNum) el.dashTotalMasteredNum.textContent = totalStats.m;
    if (el.dashTotalFamiliarNum) el.dashTotalFamiliarNum.textContent = totalStats.f;
    if (el.dashTotalUnlearnedNum) el.dashTotalUnlearnedNum.textContent = totalStats.u;

    // 807
    if (el.dashRatio807) el.dashRatio807.textContent = `${s807.m} / ${s807.total} 题 · ${s807.percent}%`;
    if (el.dashBar807Mastered) el.dashBar807Mastered.style.width = `${s807.percent}%`;
    if (el.dashBar807Familiar) el.dashBar807Familiar.style.width = `${s807.total ? (s807.f / s807.total) * 100 : 0}%`;
    if (el.dashDetail807) el.dashDetail807.textContent = `已掌握 ${s807.m} · 磨耳 ${s807.f} · 待背 ${s807.u}`;

    // 706
    if (el.dashRatio706) el.dashRatio706.textContent = `${s706.m} / ${s706.total} 题 · ${s706.percent}%`;
    if (el.dashBar706Mastered) el.dashBar706Mastered.style.width = `${s706.percent}%`;
    if (el.dashBar706Familiar) el.dashBar706Familiar.style.width = `${s706.total ? (s706.f / s706.total) * 100 : 0}%`;
    if (el.dashDetail706) el.dashDetail706.textContent = `已掌握 ${s706.m} · 磨耳 ${s706.f} · 待背 ${s706.u}`;

    // 政治
    const sPol = calcStats(polItems);
    if (el.dashRatioPol) el.dashRatioPol.textContent = `${sPol.m} / ${sPol.total} 节 · ${sPol.percent}%`;
    if (el.dashBarPolMastered) el.dashBarPolMastered.style.width = `${sPol.percent}%`;
    if (el.dashBarPolFamiliar) el.dashBarPolFamiliar.style.width = `${sPol.total ? (sPol.f / sPol.total) * 100 : 0}%`;
    if (el.dashDetailPol) el.dashDetailPol.textContent = `已掌握 ${sPol.m} · 磨耳 ${sPol.f} · 待背 ${sPol.u}`;

    // 英语
    if (el.dashRatioEn) el.dashRatioEn.textContent = `${sEn.m} / ${sEn.total} 篇 · ${sEn.percent}%`;
    if (el.dashBarEnMastered) el.dashBarEnMastered.style.width = `${sEn.percent}%`;
    if (el.dashBarEnFamiliar) el.dashBarEnFamiliar.style.width = `${sEn.total ? (sEn.f / sEn.total) * 100 : 0}%`;
    if (el.dashDetailEn) el.dashDetailEn.textContent = `已掌握 ${sEn.m} · 磨耳 ${sEn.f} · 待背 ${sEn.u}`;

    // 3. T0 & T1 核心攻克率（覆盖 807 / 706 / 英语写作 / 考研政治全科）
    const t0Items = [];
    const t1Items = [];
    items807.concat(items706).forEach(x => {
      if (x.level === 'T0') t0Items.push(x);
      else if (x.level === 'T1') t1Items.push(x);
    });
    itemsEn.forEach(x => {
      if (x.category_id === 'essay_letter' || x.category_id === 'essay_picture') t0Items.push(x);
      else t1Items.push(x);
    });
    if (window.KAOYAN_POL_DATA) {
      (window.KAOYAN_POL_DATA.chapters47 || []).forEach(x => {
        if (x.category === 'my' || x.category === 'xsx') t0Items.push(x);
        else t1Items.push(x);
      });
      (window.KAOYAN_POL_DATA.xutao16 || []).forEach(x => t0Items.push(x));
      (window.KAOYAN_POL_DATA.tuijie11 || []).forEach(x => t0Items.push(x));
    }

    const t0Mastered = t0Items.filter(x => getMasteryStatus(x.id) === 'mastered').length;
    const t0Pct = t0Items.length ? Math.round((t0Mastered / t0Items.length) * 100) : 0;
    if (el.dashT0Percent) el.dashT0Percent.textContent = `${t0Pct}%`;
    if (el.dashBarT0Mastered) el.dashBarT0Mastered.style.width = `${t0Pct}%`;
    if (el.dashT0Ratio) el.dashT0Ratio.textContent = `已背熟 ${t0Mastered} / ${t0Items.length} 题`;

    const t1Mastered = t1Items.filter(x => getMasteryStatus(x.id) === 'mastered').length;
    const t1Pct = t1Items.length ? Math.round((t1Mastered / t1Items.length) * 100) : 0;
    if (el.dashT1Percent) el.dashT1Percent.textContent = `${t1Pct}%`;
    if (el.dashBarT1Mastered) el.dashBarT1Mastered.style.width = `${t1Pct}%`;
    if (el.dashT1Ratio) el.dashT1Ratio.textContent = `已背熟 ${t1Mastered} / ${t1Items.length} 题`;
  }

  async function randomPickUnmasteredT0T1() {
    if (!state.allData) return;
    if (!window.KAOYAN_POL_DATA) {
      try {
        await ensurePolDataLoaded({ silent: true });
      } catch (e) {}
    }
    const items807 = state.allData.items_807 || [];
    const items706 = state.allData.items_706 || [];
    const itemsEn = state.allData.items_en || [];
    let polItems = [];
    if (window.KAOYAN_POL_DATA) {
      polItems = [
        ...(window.KAOYAN_POL_DATA.chapters47 || []).map(it => ({ ...it, subj: 'pol', polMode: 'recite47' })),
        ...(window.KAOYAN_POL_DATA.xutao16 || []).map(it => ({ ...it, subj: 'pol', polMode: 'xutao16' })),
        ...(window.KAOYAN_POL_DATA.tuijie11 || []).map(it => ({ ...it, subj: 'pol', polMode: 'tuijie11' }))
      ];
    }
    const allItems = [
      ...items807.map(it => ({ ...it, subj: '807' })),
      ...items706.map(it => ({ ...it, subj: '706' })),
      ...itemsEn.map(it => ({ ...it, subj: 'en' })),
      ...polItems
    ];
    if (allItems.length === 0) return;

    let candidates = allItems.filter(x => {
      const isHighPriority = x.level === 'T0' || x.level === 'T1' || !!x.category_id || x.subj === 'pol';
      const isNotMastered = getMasteryStatus(x.id) !== 'mastered';
      return isHighPriority && isNotMastered;
    });

    if (candidates.length === 0) {
      candidates = allItems.filter(x => getMasteryStatus(x.id) !== 'mastered');
    }

    if (candidates.length === 0) {
      showToast(`大圆满！全科 ${allItems.length} 节考点已全部背熟掌握！正在随机抽查一节进行复习...`, 2500);
      candidates = allItems;
    }

    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    if (!picked) return;
    closeStudyDashboard();

    if (picked.subj === 'pol') {
      state.polCategory = 'all';
      localStorage.setItem('kaoyan_pol_cat', 'all');
      if (picked.polMode) {
        state.polSubMode = picked.polMode;
        localStorage.setItem('kaoyan_pol_submode', picked.polMode);
      }
      if (state.currentSubject !== 'pol') {
        await switchSubject('pol');
      }
      document.querySelectorAll('.pol-submode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.polSubmode === state.polSubMode);
      });
      document.querySelectorAll('[data-pol-cat]').forEach(b => {
        b.classList.toggle('active', b.dataset.polCat === 'all');
      });
      const showCats = state.polSubMode === 'recite47' ? 'flex' : 'none';
      if (el.polCategoryPills) el.polCategoryPills.style.display = showCats;
      if (el.stagePolCategoryPills) el.stagePolCategoryPills.style.display = showCats;
      renderSidebarList();
      selectItem(picked.id, true);
    } else {
      if (state.currentSubject !== picked.subj) {
        await switchSubject(picked.subj);
      }
      selectItem(picked.id, true);
    }
    showToast(`已为你抽查【${picked.level || picked.importance || (picked.polMode === 'xutao16' ? '徐涛16天' : '腿姐11天') || '必背'}】${picked.title}，立即开始磨耳背诵！`, 3000);
  }

  // 权威时间戳净化引擎：严格确保递增、数值合法、0-based连续idx，且每句 end 决不越过下句 start
  function sanitizeSentences(sentences) {
    if (!sentences || !Array.isArray(sentences) || sentences.length === 0) return [];
    const list = sentences.map((s, idx) => {
      const rawStart = typeof s.start === 'number' ? s.start : parseFloat(s.start || 0);
      const safeStart = isNaN(rawStart) ? 0 : rawStart;
      const rawEnd = typeof s.end === 'number' ? s.end : parseFloat(s.end || 0);
      return {
        ...s,
        id: (s.id !== undefined && s.id !== null) ? s.id : (s.idx !== undefined ? s.idx : idx),
        start: safeStart,
        end: isNaN(rawEnd) ? (safeStart + 1.0) : Math.max(safeStart + 0.05, rawEnd),
        text: s.text || '',
        domId: s.domId || (s.id !== undefined ? String(s.id) : undefined)
      };
    });
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i < list.length - 1; i++) {
      if (list[i].end > list[i + 1].start) {
        list[i].end = list[i + 1].start;
      }
    }
    // 标准化严格 0-based 连续整数索引 0, 1, ..., len - 1，彻底消解 1-based 与 0-based 错位
    list.forEach((item, index) => {
      item.idx = index;
    });
    return list;
  }

  // DOM 兜底解析机制：离线或 file:/// 协议无 JSON 缓存时，从当前 DOM 提取
  function extractSentencesFromDOM() {
    if (!el.paperContent) return [];
    const nodes = el.paperContent.querySelectorAll('.recite-sent, .recite-sent-item, .recite-sentence, .tj-sent-span, [data-sent-id], [data-sent-idx]');
    const list = [];
    nodes.forEach((node, idx) => {
      const start = parseFloat(node.dataset.start);
      const end = parseFloat(node.dataset.end);
      if (!isNaN(start)) {
        const id = node.dataset.sentId || node.dataset.sentIdx || node.dataset.id || node.id || `sent_${idx}`;
        const text = (node.innerText || node.textContent || '').trim();
        list.push({
          id,
          start,
          end: (!isNaN(end) && end > start) ? end : (start + 1.5),
          text,
          domId: node.id
        });
      }
    });
    const sanitized = sanitizeSentences(list);
    return sanitized;
  }

  // 政治 47 章 DOM-文本顺序对齐净化器：剥离源 HTML 嵌套/错配句标，按真实阅读顺序逐句一对一贴标并无损拆分同段多句
  function normalizePoliticsSentenceDom() {
    if (!el.paperContent || !el.paperContent.classList.contains('pol-scope') || !state.activeSentences || state.activeSentences.length === 0) return;
    const root = el.paperContent;
    const sents = state.activeSentences;
    const cleanCharRe = /[^\s\u3000，。；：、！？“”‘’（）()《》【】\[\]—…·.,!?;:'"\-]/;
    const cleanStr = (str) => (str || '').replace(/[\s\u3000，。；：、！？“”‘’（）()《》【】\[\]—…·.,!?;:'"\-]+/g, '');

    // 1. 彻底清除源 HTML 中错位/嵌套的旧句标属性，避免内层或错号元素劫持点击
    root.querySelectorAll('.recite-sent-item, .recite-sent, .recite-sentence, [data-sent-idx], [id^="sent_"]').forEach(n => {
      n.classList.remove('recite-sent-item', 'recite-sent', 'recite-sentence', 'active-spotlight');
      delete n.dataset.sentIdx;
      delete n.dataset.sentId;
      delete n.dataset.start;
      delete n.dataset.end;
      if (n.id && /^sent_/.test(n.id)) n.removeAttribute('id');
      if (n.getAttribute('title') === '点击从该句播放') n.removeAttribute('title');
    });

    // 2. 收集正文区域按阅读顺序排列的字符流与归属原子块
    const skipSelector = '.paper-header, button, svg, .seal-btn, .xt-card-actions, .recite-bar-actions, .pol-sub-controls, script, style';
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_SKIP;
        if (node.parentElement && node.parentElement.closest(skipSelector)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const entries = [];
    const cleanChars = [];
    const getBlock = (nodeEl) => {
      if (!nodeEl) return root;
      return nodeEl.closest('.xt-part-badge-row')
        || nodeEl.closest('.recite-bar-title')
        || nodeEl.closest('.recite-bar-badge')
        || nodeEl.closest('.xt-subline')
        || nodeEl.closest('.xt-item-content')
        || nodeEl.closest('td, th')
        || nodeEl.closest('p.xt-text-para, h4.xt-sec-title, h3, li')
        || nodeEl;
    };

    let tn;
    while ((tn = walker.nextNode())) {
      const val = tn.nodeValue;
      const block = getBlock(tn.parentElement);
      for (let i = 0; i < val.length; i++) {
        if (cleanCharRe.test(val[i])) {
          entries.push({ node: tn, rawOff: i, block });
          cleanChars.push(val[i]);
        }
      }
    }
    const stream = cleanChars.join('');
    if (!stream) return;

    const applySentAttrs = (target, sent, arrayIdx) => {
      target.classList.add('recite-sent-item');
      target.dataset.sentIdx = String(arrayIdx);
      target.dataset.sentId = String(sent.id !== undefined ? sent.id : '');
      target.dataset.start = String(sent.start);
      target.dataset.end = String(sent.end);
      if (sent.domId && !root.querySelector('#' + (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(sent.domId) : sent.domId))) {
        target.id = sent.domId;
      }
      target.title = '点击从该句播放';
    };

    // 3. 按时间轴顺序将每句话精准对齐到 DOM 文本偏移
    let cursor = 0;
    const spansByBlock = new Map();

    for (let i = 0; i < sents.length; i++) {
      const sent = sents[i];
      const sc = cleanStr(sent.text);
      if (!sc) continue;

      const findAnchor = (minPos, maxPos) => {
        const slice = stream.slice(minPos, maxPos);
        if (sc.length <= 16) {
          const p = slice.indexOf(sc);
          if (p !== -1) return { pos: minPos + p, off: 0, len: sc.length };
        }
        // 外层按锚点长度降序尝试，防止短前缀抢跑命中下游无关片段
        for (const anchorLen of [16, 12, 9, 6, 4]) {
          if (anchorLen > sc.length && sc.length >= 4) continue;
          const effLen = Math.min(anchorLen, sc.length);
          const maxOff = anchorLen <= 5 ? Math.min(8, Math.max(0, sc.length - effLen)) : Math.min(20, Math.max(0, sc.length - effLen));
          for (let off = 0; off <= maxOff; off++) {
            const anchor = sc.slice(off, off + effLen);
            const p = slice.indexOf(anchor);
            if (p !== -1) return { pos: minPos + p, off, len: effLen };
          }
        }
        if (sc.length >= 8) {
          const tailLen = Math.min(10, sc.length);
          const tail = sc.slice(sc.length - tailLen);
          const p = slice.indexOf(tail);
          if (p !== -1) {
            return { pos: Math.max(minPos, minPos + p - (sc.length - tailLen)), off: 0, len: tailLen };
          }
        }
        return null;
      };

      let found = findAnchor(cursor, Math.min(stream.length, cursor + Math.max(300, sc.length * 4)));
      if (!found) found = findAnchor(cursor, stream.length);
      if (!found && cursor > 0) found = findAnchor(Math.max(0, cursor - 250), stream.length);

      if (!found) {
        const stampHeaderFallback = (sel) => {
          const hdr = root.querySelector(sel);
          if (!hdr || hdr.dataset.sentIdx !== undefined || hdr.querySelector('[data-sent-idx]')) return false;
          applySentAttrs(hdr, sent, i);
          return true;
        };
        if (i <= 3 && /原书/.test(sc) && stampHeaderFallback('.recite-bar-badge')) continue;
        if (i <= 3 && /背诵(部分|内容)/.test(sc) && stampHeaderFallback('.xt-part-badge-row')) continue;
        continue;
      }

      let startIdx = found.pos;
      if (found.off > 0) {
        const anchorBlock = entries[found.pos].block;
        let back = 0;
        while (back < found.off && startIdx - 1 >= cursor && entries[startIdx - 1].block === anchorBlock) {
          startIdx--;
          back++;
        }
      }

      // 若仅蹭到上一段末尾不足 12 字（如 TTS 跨越“其他内容见附录2”），优先落到后续正文主体块
      let startBlock = entries[startIdx].block;
      let remainInBlock = 1;
      while (startIdx + remainInBlock < entries.length && entries[startIdx + remainInBlock].block === startBlock && remainInBlock <= 14) {
        remainInBlock++;
      }
      if (remainInBlock < 12 && sc.length - found.off >= 12) {
        const nextIdx = startIdx + remainInBlock;
        if (nextIdx < entries.length && entries[nextIdx].block !== startBlock) {
          const probeSlice = stream.slice(nextIdx, nextIdx + 16);
          if (probeSlice.length >= 4 && sc.includes(probeSlice.slice(0, Math.min(7, probeSlice.length)))) {
            startIdx = nextIdx;
            startBlock = entries[nextIdx].block;
          }
        }
      }

      let endIdx = Math.min(entries.length - 1, startIdx + Math.max(1, sc.length - found.off) - 1);
      while (endIdx > startIdx && entries[endIdx].block !== startBlock) {
        endIdx--;
      }

      if (!spansByBlock.has(startBlock)) spansByBlock.set(startBlock, []);
      spansByBlock.get(startBlock).push({ sent, arrayIdx: i, startIdx, endIdx });
      cursor = Math.max(cursor, startIdx + Math.min(found.len, 6));
    }

    // 4. 按块落实唯一 DOM 句标或 DOM Range 无损拆分子句
    for (const [block, list] of spansByBlock.entries()) {
      list.sort((a, b) => a.startIdx - b.startIdx);
      let blockEnd = list[list.length - 1].endIdx;
      while (blockEnd + 1 < entries.length && entries[blockEnd + 1].block === block) blockEnd++;
      let blockStart = list[0].startIdx;
      while (blockStart - 1 >= 0 && entries[blockStart - 1].block === block) blockStart--;

      if (list.length === 1) {
        let target = block;
        if (block.classList && block.classList.contains('xt-item-content')) {
          const row = block.closest('.xt-item-row');
          if (row && row.querySelectorAll('.xt-item-content').length === 1 && !row.querySelector('.xt-subline') && !row.querySelector('[data-sent-idx]')) {
            target = row;
          }
        }
        applySentAttrs(target, list[0].sent, list[0].arrayIdx);
        continue;
      }

      const boundaries = list.map((item, k) => ({
        sent: item.sent,
        arrayIdx: item.arrayIdx,
        start: (k === 0 && item.startIdx - blockStart <= 6) ? blockStart : item.startIdx
      }));
      for (let k = 1; k < boundaries.length; k++) {
        if (boundaries[k].start <= boundaries[k - 1].start) {
          boundaries[k].start = Math.min(blockEnd, boundaries[k - 1].start + 1);
        }
      }

      const frags = [];
      for (let k = 0; k < boundaries.length; k++) {
        const bStart = boundaries[k].start;
        const eStart = (k + 1 < boundaries.length) ? boundaries[k + 1].start : blockEnd + 1;
        const startEnt = entries[bStart];
        if (!startEnt) continue;
        const range = doc.createRange();
        if (k === 0 && block.firstChild) {
          range.setStart(block, 0);
        } else {
          range.setStart(startEnt.node, startEnt.rawOff);
        }
        if (k + 1 < boundaries.length && entries[eStart]) {
          range.setEnd(entries[eStart].node, entries[eStart].rawOff);
        } else {
          range.setEnd(block, block.childNodes.length);
        }
        const span = doc.createElement('span');
        applySentAttrs(span, boundaries[k].sent, boundaries[k].arrayIdx);
        span.appendChild(range.cloneContents());
        frags.push(span);
      }
      if (frags.length === boundaries.length) {
        block.innerHTML = '';
        frags.forEach(f => block.appendChild(f));
      }
    }
  }
  // 权威句标与 DOM 1:1 双向映射校准器：严格确保 DOM 节点上的 data-sent-idx 与 state.activeSentences[idx] 绝对一致
  function stampSentenceIndices() {
    if (!el.paperContent || !state.activeSentences || state.activeSentences.length === 0) return;
    const sents = state.activeSentences;

    sents.forEach((s, idx) => {
      let node = null;
      if (s.id !== undefined && s.id !== null) {
        const escSentId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(String(s.id)) : String(s.id).replace(/"/g, '\\"');
        node = el.paperContent.querySelector(`[data-sent-id="${escSentId}"], [data-point-id="${escSentId}"]`);
      }
      if (!node && s.domId) {
        try {
          const escId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(String(s.domId)) : String(s.domId).replace(/([ #;?%&,.+*~\':"!^$[\]()=>|\/@])/g, '\\$1');
          node = el.paperContent.querySelector(`#${escId}, [data-sent-id="${s.domId}"]`);
        } catch (e) {}
      }
      if (!node && typeof s.start === 'number' && !isNaN(s.start)) {
        const timeCandidates = el.paperContent.querySelectorAll('.recite-sent, .recite-sent-item, .recite-sentence, .tj-sent-span');
        for (let j = 0; j < timeCandidates.length; j++) {
          const tNode = timeCandidates[j];
          const tStart = parseFloat(tNode.dataset.start);
          if (!isNaN(tStart) && Math.abs(tStart - s.start) < 0.04) {
            node = tNode;
            break;
          }
        }
      }
      if (node) {
        node.dataset.sentIdx = String(idx);
      }
    });

    el.paperContent.querySelectorAll('.xt-day-point-card').forEach((card, cIdx) => {
      card.dataset.sentIdx = String(cIdx);
    });

    const unstamped = el.paperContent.querySelectorAll('.recite-sent:not([data-sent-idx]), .recite-sent-item:not([data-sent-idx]), .recite-sentence:not([data-sent-idx])');
    if (unstamped.length > 0) {
      const allEls = el.paperContent.querySelectorAll('.recite-sent, .recite-sent-item, .recite-sentence, .tj-sent-span');
      if (allEls.length === sents.length) {
        allEls.forEach((elNode, eIdx) => {
          elNode.dataset.sentIdx = String(eIdx);
        });
      }
    }

    // Track 2 联动锚点句（.t1-linked-sent）补全 data-linked-sent-idx，确保点读可用且不抢占主句聚光灯
    const linkedEls = el.paperContent.querySelectorAll('.t1-linked-sent:not([data-sent-idx])');
    if (linkedEls.length > 0) {
      const normText = (str) => (str || '')
        .replace(/【[^】]*】/g, '')
        .replace(/[\s，。！？、；：“”‘’（）《》【】·—…,.!?;:"'()\-]/g, '');
      const sNorms = sents.map((s) => normText(s.text));
      linkedEls.forEach((lNode) => {
        if (lNode.dataset.linkedSentIdx !== undefined) return;
        const lNorm = normText(lNode.textContent);
        if (!lNorm || lNorm.length < 4) return;
        let matchIdx = sNorms.findIndex((sn) => sn && sn === lNorm);
        if (matchIdx === -1) {
          matchIdx = sNorms.findIndex((sn) => sn.length >= 6 && (lNorm.startsWith(sn) || lNorm.includes(sn) || sn.includes(lNorm)));
        }
        if (matchIdx !== -1) {
          lNode.dataset.linkedSentIdx = String(matchIdx);
        }
      });
    }
  }

  // 板块/卡片级点读交互引擎：点击任意板块头部或卡片背景，自动定位并起音朗读该板块的第一句话（杜绝落空或归零）
  function bindCardSectionClickHandlers(container) {
    if (!container) return;

    const cardOrHeaderSelectors = [
      '.exam-section-card',
      '.section-card-header',
      '.sec-badge',
      '.sec-desc',
      '.logic-block-card',
      '.logic-block-title',
      '.xt-day-point-card',
      '.xt-day-point-header',
      '.en-essay-para',
      '.sub-card',
      '.stream-card',
      '.xt-part-box',
      '.xt-part-badge-row',
      '.tj-handbook-card',
      '.tj-card-header'
    ].join(', ');

    const targets = container.querySelectorAll(cardOrHeaderSelectors);
    targets.forEach(targetEl => {
      if (targetEl.dataset.cardClickBound === '1') return;
      targetEl.dataset.cardClickBound = '1';

      targetEl.addEventListener('click', (e) => {
        // 若点击的是交互控件（按钮、链接、专属跳转胶囊、或挖空测验模式的填空词），由其自身专属事件接管
        if (e.target.closest('button, a, input, .seal-btn, .en-audio-jump-pill')) {
          return;
        }
        if (state.clozeMode === 'keyword' && (e.target.closest('.cloze') || e.target.closest('.kw-red') || e.target.closest('.stream-kw'))) {
          return;
        }
        const clickedTimedSent = e.target.closest('[data-sent-idx], [data-sent-id], .recite-sent[data-start], .recite-sent-item[data-start], .recite-sentence[data-start], .tj-sent-span[data-start]');
        if (clickedTimedSent) {
          return;
        }

        // 向上锁定所属板块卡片
        const card = targetEl.closest('.exam-section-card, .logic-block-card, .xt-part-box, .stream-card, .xt-day-point-card, .tj-handbook-card, .en-essay-para, .sub-card') || targetEl;

        // 获取该卡片内的第一句带时间戳的句子（跳过无时间戳的副标题或关联句）
        const timedSents = getCardTimedSentences(card);
        const firstSent = timedSents.length > 0 ? timedSents[0] : null;

        if (firstSent) {
          e.stopPropagation();
          const rawIdx = firstSent.dataset.sentIdx !== undefined ? parseInt(firstSent.dataset.sentIdx, 10) : NaN;
          const rawStart = parseFloat(firstSent.dataset.start);
          const rawId = firstSent.dataset.sentId || firstSent.id;

          let targetIdx = -1;
          let targetStart = isNaN(rawStart) ? 0 : rawStart;

          if (!isNaN(rawIdx) && state.activeSentences && rawIdx >= 0 && rawIdx < state.activeSentences.length) {
            targetIdx = rawIdx;
            if (typeof state.activeSentences[rawIdx].start === 'number') {
              targetStart = state.activeSentences[rawIdx].start;
            }
          } else if (state.activeSentences && state.activeSentences.length > 0) {
            const foundIdx = state.activeSentences.findIndex(s =>
              (rawId && (String(s.id) === String(rawId) || String(s.domId) === String(rawId))) ||
              (typeof s.start === 'number' && !isNaN(rawStart) && Math.abs(s.start - rawStart) < 0.05)
            );
            if (foundIdx !== -1) {
              targetIdx = foundIdx;
              targetStart = state.activeSentences[foundIdx].start;
            }
          }

          if (targetIdx !== -1) {
            seekToSentence(targetIdx, targetStart);
          } else if (!isNaN(targetStart)) {
            seekToSentence(rawId || (!isNaN(rawIdx) ? rawIdx : 0), targetStart);
          }
        } else if (currentFrameworkSections && currentFrameworkSections.length > 0) {
          const matchedSec = currentFrameworkSections.find(s => s.cardEl === card);
          if (matchedSec && typeof matchedSec.start === 'number' && !isNaN(matchedSec.start)) {
            e.stopPropagation();
            seekToSentence(matchedSec.sentId, matchedSec.start);
          }
        }
      });
    });
  }

  function selectItem(itemId, autoPlay = false, restoreTime = false) {
    let list = getCurrentItemsList();
    let item = list.find(x => x.id === itemId);
    if (!item) {
      let rawList;
      if (state.currentSubject === 'pol') rawList = getPolItemList();
      else if (state.currentSubject === '807') rawList = state.allData?.items_807;
      else if (state.currentSubject === '706') rawList = state.allData?.items_706;
      else rawList = state.allData?.items_en;
      item = (rawList && rawList.find(x => x.id === itemId)) || (rawList && rawList[0]) || (list && list[0]);
    }
    if (!item) return;

    const resolvedId = item.id;
    lastSpotlightEl = null; // 切换考题清除旧聚光引用，消除跨题内存残留与同名 sentId 穿透
    state.activeItemId = resolvedId;
    state.activeItem = item;
    state.currentSentIndex = -1;
    state.loopCount = 0;

    localStorage.setItem(`kaoyan_last_item_${state.currentSubject}`, resolvedId);
    localStorage.setItem('kaoyan_last_item_id', resolvedId);
    localStorage.setItem('kaoyan_last_subject', state.currentSubject);
    localStorage.setItem('kaoyan_last_track', String(state.currentTrack));

    document.querySelectorAll('.question-card-item').forEach(card => {
      card.classList.toggle('active', card.dataset.id === resolvedId);
    });

    el.questionTitle.textContent = item.title;
    if (state.currentSubject === 'pol') {
      selectPolItem(item, autoPlay, restoreTime);
      return;
    }
    if (el.paperContent) {
      el.paperContent.classList.remove('pol-scope');
    }
    if (state.currentSubject === '807') {
      el.stageSubject.textContent = '807 现当代文学';
    } else if (state.currentSubject === '706') {
      el.stageSubject.textContent = '706 古代文学';
    } else {
      el.stageSubject.textContent = '考研英语写作';
    }
    let breadcrumbTopic = item.topic || (item.author ? `${item.author} 专章` : '核心考点');
    if (breadcrumbTopic.length > 12 && item.author) {
      breadcrumbTopic = `${item.author} 专章`;
    } else if (breadcrumbTopic.length > 15) {
      breadcrumbTopic = breadcrumbTopic.slice(0, 14) + '...';
    }
    el.stageTopic.textContent = breadcrumbTopic;
    el.stageScore.textContent = item.score;
    el.stageTier.textContent = item.level;
    el.stageTier.className = `tier-badge tier-${item.level}`;
    
    if (el.hudTitleText) {
      const subjPrefix = state.currentSubject === 'pol' ? '考研政治' : (state.currentSubject === '807' ? '807' : (state.currentSubject === '706' ? '706' : '英语'));
      el.hudTitleText.textContent = `${subjPrefix} · ${item.title}${item.score ? ' (' + item.score + ')' : ''}`;
    }

    if (el.dockTitle) el.dockTitle.textContent = item.title;
    if (el.dockTrackPill) {
      if (state.currentSubject === 'en') {
        el.dockTrackPill.textContent = state.currentTrack === 1 ? '中英听读磨耳版' : '替换变体与仿写拓展';
      } else {
        el.dockTrackPill.textContent = state.currentTrack === 1 ? '考场直接答题完整版' : '答题版内部逻辑精解版';
      }
    }

    updateHeaderMasteryUI();
    loadTrackData(state.currentTrack, autoPlay, restoreTime);
  }

  function loadTrackData(trackNum, autoPlay = false, restoreTime = false) {
    if (state.currentSubject === 'pol') {
      loadPolTrackData(trackNum, autoPlay, restoreTime);
      return;
    }
    state.currentTrack = trackNum;
    state.currentSentIndex = -1;
    state.loopCount = 0;
    localStorage.setItem('kaoyan_last_track', String(trackNum));

    if (el.tabTrack1) el.tabTrack1.classList.toggle('active', trackNum === 1);
    if (el.tabTrack2) el.tabTrack2.classList.toggle('active', trackNum === 2);
    if (el.dockTrackPill) {
      if (state.currentSubject === 'en') {
        el.dockTrackPill.textContent = trackNum === 1 ? '中英听读磨耳版' : '替换变体与仿写拓展';
      } else {
        el.dockTrackPill.textContent = trackNum === 1 ? '考场直接答题完整版' : '答题版内部逻辑精解版';
      }
    }

    const item = state.activeItem;
    if (!item) return;

    const trackObj = trackNum === 1 ? item.track1 : item.track2;
    resetAudioProgressUI();

    // 1. 同步第一时间挂载音频并处理自动播放（保护 iOS Safari WebKit 用户手势与后台连播上下文）
    if (trackObj && trackObj.audio) {
      audio.src = trackObj.audio;
      audio.load();
      audio.playbackRate = state.speed;

      tryRestoreAudioTime(restoreTime, `${state.currentSubject}_${state.activeItemId}_${trackNum}`);

      if (autoPlay) {
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.catch(e => console.log('Autoplay prevented:', e));
        }
      }
    } else {
      clearAudioSource();
    }
    updatePlayBtnUI();

    // 2. 同步渲染正文 HTML（使得 DOM 节点到位）
    renderPaperContent(trackObj, []);
    enhanceClozeKeywords();

    // 3. 异步并行加载/DOM兜底解析打点数据并绑定
    const sFile = trackObj ? (trackObj.sentences_file || '').replace(/\\/g, '/') : '';
    
    // 优先同步读取内嵌全量打点包
    let sentences = [];
    if (window.KAOYAN_SENTENCES && window.KAOYAN_SENTENCES[sFile]) {
      sentences = window.KAOYAN_SENTENCES[sFile];
    }

    // 若未命中，优先通过 DOM 兜底解析（确保在离线、file:/// 协议或未缓存 json 时即刻可用）
    if (!sentences || sentences.length === 0) {
      sentences = extractSentencesFromDOM();
    }

    state.activeSentences = sanitizeSentences(sentences);
    stampSentenceIndices();
    buildFrameworkIndex();

    // 若未命中内置包且有 sFile，发起异步非阻塞 fetch 进行补充校准
    if (sFile && (!window.KAOYAN_SENTENCES || !window.KAOYAN_SENTENCES[sFile])) {
      fetch(sFile + '?t=' + Date.now())
        .then(res => res.ok ? res.json() : null)
        .then(fetchedSents => {
          if (fetchedSents && fetchedSents.length > 0 && state.currentTrack === trackNum && state.activeItemId === item.id) {
            state.activeSentences = sanitizeSentences(fetchedSents);
            stampSentenceIndices();
            bindSentenceClickHandlers(el.paperContent);
            bindCardSectionClickHandlers(el.paperContent);
            buildFrameworkIndex();
          }
        })
        .catch(e => {
          console.warn('Sentence timestamps fallback failed:', e);
          if (!state.activeSentences || state.activeSentences.length === 0) {
            state.activeSentences = extractSentencesFromDOM();
            stampSentenceIndices();
            bindSentenceClickHandlers(el.paperContent);
            bindCardSectionClickHandlers(el.paperContent);
            buildFrameworkIndex();
          }
        });
    }
  }

  // 权威句子点击事件代理绑定器 (优先从 state.activeSentences 读取权威起止时间戳，彻底纠正点击前一句/串音)
  function bindSentenceClickHandlers(container) {
    if (!container) return;
    const sentEls = container.querySelectorAll('.recite-sent, .recite-sent-item, .recite-sentence, .tj-sent-span, [data-sent-id], [data-sent-idx], [id^="recite_bar_"], [id^="recite_blk_"]');
    sentEls.forEach(elItem => {
      if (elItem.dataset.clickBound === '1') return;
      elItem.dataset.clickBound = '1';
      elItem.addEventListener('click', (e) => {
        if (state.clozeMode === 'keyword' && (e.target.closest('.cloze') || e.target.closest('.kw-red') || e.target.closest('.stream-kw'))) return;
        if (state.clozeMode === 'body') {
          elItem.classList.toggle('cloze-revealed');
          return;
        }

        // 1. 优先从 state.activeSentences 根据 sentIdx / sentId 权威索引匹配
        const rawIdx = elItem.dataset.sentIdx !== undefined ? parseInt(elItem.dataset.sentIdx, 10) : NaN;
        const rawLinkedIdx = elItem.dataset.linkedSentIdx !== undefined ? parseInt(elItem.dataset.linkedSentIdx, 10) : NaN;
        const rawId = elItem.dataset.sentId || elItem.id || elItem.dataset.pointId;
        let matched = null;
        let targetIdx = -1;

        if (state.activeSentences && state.activeSentences.length > 0) {
          // 优先级 1: 0-based sentIdx 连续下标直接访问（100% 精准无歧义，消除 1-based 与 0-based 错位碰撞）
          if (!isNaN(rawIdx) && rawIdx >= 0 && rawIdx < state.activeSentences.length) {
            targetIdx = rawIdx;
            matched = state.activeSentences[rawIdx];
          }
          // 优先级 1b: Track 2 .t1-linked-sent 联动索引
          if (!matched && !isNaN(rawLinkedIdx) && rawLinkedIdx >= 0 && rawLinkedIdx < state.activeSentences.length) {
            targetIdx = rawLinkedIdx;
            matched = state.activeSentences[rawLinkedIdx];
          }
          // 优先级 2: 匹配唯一 sentence id
          if (!matched && rawId) {
            const foundIdx = state.activeSentences.findIndex(s => String(s.id) === String(rawId));
            if (foundIdx !== -1) {
              targetIdx = foundIdx;
              matched = state.activeSentences[foundIdx];
            }
          }
          // 优先级 3: 匹配 domId
          if (!matched && rawId) {
            const foundIdx = state.activeSentences.findIndex(s => String(s.domId) === String(rawId));
            if (foundIdx !== -1) {
              targetIdx = foundIdx;
              matched = state.activeSentences[foundIdx];
            }
          }
          // 优先级 4: 按 dataset.start 时间戳近似匹配
          if (!matched) {
            const dsStart = parseFloat(elItem.dataset.start);
            if (!isNaN(dsStart)) {
              const foundIdx = state.activeSentences.findIndex(s => Math.abs(s.start - dsStart) < 0.1);
              if (foundIdx !== -1) {
                targetIdx = foundIdx;
                matched = state.activeSentences[foundIdx];
              }
            }
          }
        }

        if (targetIdx !== -1 && matched && typeof matched.start === 'number' && !isNaN(matched.start)) {
          e.stopPropagation();
          seekToSentence(targetIdx, matched.start);
        } else {
          const fallbackStart = parseFloat(elItem.dataset.start);
          const fallbackId = (!isNaN(rawIdx) ? rawIdx : rawId);
          if (!isNaN(fallbackStart) && fallbackId !== null && fallbackId !== undefined) {
            e.stopPropagation();
            seekToSentence(fallbackId, fallbackStart);
          }
          // 无有效时间戳的修饰性元素（如 .sec-desc）不阻止冒泡，交由卡片级点读兜底
        }
      });
    });
  }

  function renderPaperContent(trackObj, sentences) {
    if (!el.paperContent) return;
    lastSpotlightEl = null;
    el.paperContent.classList.remove('pol-scope');
    el.paperContent.innerHTML = '';
    applyClozeClassToPaper();

    if (!trackObj) {
      el.paperContent.innerHTML = `<p class="paper-paragraph" style="color: var(--ink-muted);">暂无内容</p>`;
      return;
    }

    if (trackObj.html) {
      el.paperContent.innerHTML = trackObj.html;

      // 绑定权威高光追踪与点击点读事件
      bindSentenceClickHandlers(el.paperContent);

      // 绑定板块与卡片级别点读事件
      bindCardSectionClickHandlers(el.paperContent);

      // 英语写作专属：审题任务导引交互与一键直达开读对应段落高分范文
      const enJumpPills = el.paperContent.querySelectorAll('.en-audio-jump-pill');
      enJumpPills.forEach(pill => {
        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          const targetCard = pill.closest('.en-essay-para') || pill.closest('.exam-section-card') || el.paperContent.querySelector('.en-full-essay-box') || el.paperContent;
          const firstSentEl = targetCard.querySelector('.recite-sent, .recite-sent-item, [data-sent-idx]');
          if (firstSentEl) {
            const rawIdx = firstSentEl.dataset.sentIdx !== undefined ? parseInt(firstSentEl.dataset.sentIdx, 10) : NaN;
            const sStart = parseFloat(firstSentEl.dataset.start);
            if (!isNaN(rawIdx) && state.activeSentences && rawIdx >= 0 && rawIdx < state.activeSentences.length) {
              seekToSentence(rawIdx, state.activeSentences[rawIdx].start);
            } else {
              seekToSentence(firstSentEl.dataset.sentId || rawIdx, sStart);
            }
            showToast('已为您开读本段高分范文', 1800);
          }
        });
      });

      if (state.currentSubject === 'en') {
        const enPromptBoxes = el.paperContent.querySelectorAll('.en-task-prompt-box, .en-task-prompt-text, .section-thesis-box');
        enPromptBoxes.forEach(pBox => {
          pBox.addEventListener('click', (e) => {
            if (e.target.closest('.en-audio-jump-pill')) return;
            e.stopPropagation();
            const targetCard = pBox.closest('.en-essay-para') || pBox.closest('.exam-section-card') || pBox.nextElementSibling || el.paperContent.querySelector('.en-full-essay-box');
            const firstSentEl = targetCard ? targetCard.querySelector('.recite-sent, .recite-sent-item, [data-sent-idx]') : null;
            if (firstSentEl) {
              const rawIdx = firstSentEl.dataset.sentIdx !== undefined ? parseInt(firstSentEl.dataset.sentIdx, 10) : NaN;
              const sStart = parseFloat(firstSentEl.dataset.start);
              if (!isNaN(rawIdx) && state.activeSentences && rawIdx >= 0 && rawIdx < state.activeSentences.length) {
                seekToSentence(rawIdx, state.activeSentences[rawIdx].start);
              } else {
                seekToSentence(firstSentEl.dataset.sentId || rawIdx, sStart);
              }
              showToast('此部分为审题任务导引（静读），已定位开读对应段落范文', 2200);
            } else {
              showToast('此部分为审题任务导引，点击下方正文即可点词朗读', 2200);
            }
          });
        });

        const enIntroBadges = el.paperContent.querySelectorAll('.en-intro-badge, .card-intro .section-card-header');
        enIntroBadges.forEach(ib => {
          ib.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetCard = ib.closest('.en-essay-para') || ib.closest('.exam-section-card') || el.paperContent.querySelector('.en-full-essay-box');
            const firstSentEl = targetCard ? targetCard.querySelector('.recite-sent, .recite-sent-item, [data-sent-idx]') : null;
            if (firstSentEl) {
              const rawIdx = firstSentEl.dataset.sentIdx !== undefined ? parseInt(firstSentEl.dataset.sentIdx, 10) : NaN;
              const sStart = parseFloat(firstSentEl.dataset.start);
              if (!isNaN(rawIdx) && state.activeSentences && rawIdx >= 0 && rawIdx < state.activeSentences.length) {
                seekToSentence(rawIdx, state.activeSentences[rawIdx].start);
              } else {
                seekToSentence(firstSentEl.dataset.sentId || rawIdx, sStart);
              }
              showToast('审题导引供静读构思，已为您起音开读对应段落范文', 2000);
            }
          });
        });
      }

      return;
    }

    // Fallback if html not present
    if (trackObj.text) {
      el.paperContent.innerHTML = `<div class="exam-section-card"><div class="section-card-content"><p>${trackObj.text.replace(/\n/g, '<br>')}</p></div></div>`;
    }
  }

  function formatSentenceHtml(text) {
    return text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  function seekToSentence(sentIdxOrId, startTime) {
    let exactTime = typeof startTime === 'number' && !isNaN(startTime) ? startTime : 0;
    let targetSent = null;
    let targetIdx = -1;

    if (state.activeSentences && state.activeSentences.length > 0) {
      const len = state.activeSentences.length;

      // 1. 若传入严格 0-based 整数索引，直接按下标精准读取 state.activeSentences[idx]
      // 彻底消除 1-based id 与 0-based idx 在 findIndex 中的碰撞错位！
      if (typeof sentIdxOrId === 'number' && Number.isInteger(sentIdxOrId) && sentIdxOrId >= 0 && sentIdxOrId < len) {
        targetIdx = sentIdxOrId;
        targetSent = state.activeSentences[sentIdxOrId];
      } else {
        // 2. 按 s.id 或 s.domId 查找
        const matchIdx = state.activeSentences.findIndex(s =>
          String(s.id) === String(sentIdxOrId) ||
          (s.domId && String(s.domId) === String(sentIdxOrId))
        );
        if (matchIdx !== -1) {
          targetIdx = matchIdx;
          targetSent = state.activeSentences[matchIdx];
        } else {
          const parsed = parseInt(sentIdxOrId, 10);
          if (!isNaN(parsed) && parsed >= 0 && parsed < len) {
            targetIdx = parsed;
            targetSent = state.activeSentences[parsed];
          }
        }
      }

      if (targetSent) {
        state.currentSentIndex = targetIdx;
        state.loopCount = 0;
        if (typeof targetSent.start === 'number' && !isNaN(targetSent.start)) {
          exactTime = targetSent.start;
        }
      }
    }

    // 精准定位目标时刻：以权威起始时间为基准，绝不随意提前减去负偏移导致播放到前一句
    const targetTime = Math.max(0, exactTime);
    if (currentFrameworkSections.length > 0) {
      const matchedSecIdx = findSectionIndexAtTime(targetTime);
      if (matchedSecIdx !== -1) {
        currentActiveSectionIndex = matchedSecIdx;
      }
    }
    highlightSentence(targetIdx !== -1 ? targetIdx : (targetSent ? targetSent.idx : sentIdxOrId));
    updateHUDDisplay(targetTime);

    manualSeekEpoch++;
    clearPendingSeek(true);

    if (targetIdx !== -1) {
      lastClickedSentGuard = { idx: targetIdx, time: targetTime, until: Date.now() + 900 };
    } else {
      lastClickedSentGuard = null;
    }

    // 严密防重入与防漂移寻音锁：在寻音真实落地前锁定当前句指针，杜绝慢网/Safari 重置至 0 秒覆盖高亮
    isLoopSeeking = true;
    lastSeekTs = Date.now();
    if (loopSeekTimer) clearTimeout(loopSeekTimer);
    loopSeekTimer = setTimeout(() => {
      isLoopSeeking = false;
    }, 4000);

    const applySeek = () => {
      try {
        audio.currentTime = targetTime;
      } catch (err) {
        console.warn('Seek error:', err);
      }
    };

    if (!audio.getAttribute('src') && !audio.currentSrc) {
      isLoopSeeking = false;
      if (loopSeekTimer) { clearTimeout(loopSeekTimer); loopSeekTimer = null; }
      showToast('当前内容为纯文本导学，无伴读音频', 2000);
      return;
    }

    const myToken = ++seekToken;
    const seekIdx = targetIdx !== -1 ? targetIdx : (targetSent ? targetSent.idx : -1);
    pendingSeekTarget = {
      token: myToken,
      time: targetTime,
      idx: seekIdx,
      startedAt: Date.now(),
      wasMuted: audio.muted,
      mutedForSeek: false
    };
    pendingSeekTimer = setTimeout(() => {
      if (pendingSeekTarget && pendingSeekTarget.token === myToken) {
        clearPendingSeek(true);
        isLoopSeeking = false;
      }
    }, 4200);

    const settlePendingIfLanded = () => {
      if (!pendingSeekTarget || pendingSeekTarget.token !== myToken) return false;
      if (Math.abs(audio.currentTime - targetTime) <= 0.45 && audio.readyState >= 2 && !audio.seeking) {
        clearPendingSeek(true);
        isLoopSeeking = false;
        if (loopSeekTimer) { clearTimeout(loopSeekTimer); loopSeekTimer = null; }
        return true;
      }
      return false;
    };

    const playAndEnforceTarget = () => {
      if (myToken !== seekToken) return;
      if (audio.paused) {
        // 慢网 readyState === 0 时暂静音并在同步手势内起音以保留 iOS Safari 播放权限，到位即恢复有声
        if (audio.readyState < 2 && targetTime > 0.25 && !audio.muted && pendingSeekTarget && pendingSeekTarget.token === myToken) {
          pendingSeekTarget.mutedForSeek = true;
          audio.muted = true;
        }
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.then(() => {
            if (myToken !== seekToken) return;
            if (audio.readyState >= 1 && Math.abs(audio.currentTime - targetTime) > 0.25) {
              applySeek();
            }
            settlePendingIfLanded();
          }).catch(e => {
            if (pendingSeekTarget && pendingSeekTarget.token === myToken && pendingSeekTarget.mutedForSeek) {
              audio.muted = Boolean(pendingSeekTarget.wasMuted);
              pendingSeekTarget.mutedForSeek = false;
            }
            console.log('Audio play failed:', e);
          });
        }
      } else {
        settlePendingIfLanded();
      }
    };

    if (audio.readyState >= 1) {
      applySeek();
      playAndEnforceTarget();
    } else {
      const cleanupReadyListeners = () => {
        audio.removeEventListener('loadedmetadata', onReadySeekAndPlay);
        audio.removeEventListener('canplay', onReadySeekAndPlay);
      };
      const onReadySeekAndPlay = () => {
        if (myToken !== seekToken) {
          cleanupReadyListeners();
          return;
        }
        if (audio.readyState >= 1) {
          applySeek();
        }
        playAndEnforceTarget();
        if (audio.readyState >= 2) {
          cleanupReadyListeners();
        }
      };
      audio.addEventListener('loadedmetadata', onReadySeekAndPlay);
      audio.addEventListener('canplay', onReadySeekAndPlay);
      if (audio.paused && audio.networkState === 0) {
        audio.load();
      }
      // iOS WebKit PWA 必须在用户点击手势同一调用栈内触发 play() 才能激活音频权限
      playAndEnforceTarget();
    }
  }

  lastSpotlightEl = null;
  let lastScrollTs = 0;

  // 工业级严格区间对齐引擎 (结合 syncOffset 前瞻补偿与 60fps 实时追踪，消除高光滞后)
  function findActiveSentenceIndex(currentTime) {
    const sents = state.activeSentences;
    if (!sents || sents.length === 0) return -1;
    const len = sents.length;
    const offset = (typeof state.syncOffset === 'number' && !isNaN(state.syncOffset)) ? state.syncOffset : 0.15;
    const t = Math.max(0, currentTime + offset);

    const firstStart = typeof sents[0].start === 'number' ? sents[0].start : parseFloat(sents[0].start || 0);
    if (t < firstStart) return 0;

    // 二分查找满足 sents[i].start <= t 的最大索引 i
    let low = 0;
    let high = len - 1;
    let ans = 0;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const mStart = typeof sents[mid].start === 'number' ? sents[mid].start : parseFloat(sents[mid].start || 0);
      if (mStart <= t) {
        ans = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return ans;
  }

  function highlightSentence(target) {
    if (target === null || target === undefined || target === '') {
      if (lastSpotlightEl) {
        lastSpotlightEl.classList.remove('active-spotlight');
        lastSpotlightEl.classList.remove('loop-sent-active');
        lastSpotlightEl = null;
      }
      return;
    }

    let targetIdx = -1;
    let sentObj = null;

    if (state.activeSentences && state.activeSentences.length > 0) {
      const len = state.activeSentences.length;
      if (typeof target === 'number' && Number.isInteger(target) && target >= 0 && target < len) {
        targetIdx = target;
        sentObj = state.activeSentences[target];
      } else {
        const found = state.activeSentences.findIndex(s => 
          String(s.id) === String(target) || 
          (s.domId && String(s.domId) === String(target)) ||
          (s.idx !== undefined && String(s.idx) === String(target))
        );
        if (found !== -1) {
          targetIdx = found;
          sentObj = state.activeSentences[found];
        }
      }
    }

    let targetEl = null;
    if (el.paperContent) {
      // 1. 绝对第一优先级：严格以 [data-sent-idx="${targetIdx}"] 查询（100% 音画同拍）
      if (targetIdx !== -1) {
        targetEl = el.paperContent.querySelector(`[data-sent-idx="${targetIdx}"]`);
      }
      // 2. 备用：按 sentObj.id 或 sentObj.domId 查询
      if (!targetEl && sentObj) {
        if (sentObj.id !== undefined && sentObj.id !== null) {
          targetEl = el.paperContent.querySelector(`[data-sent-id="${sentObj.id}"], [data-point-id="${sentObj.id}"]`);
        }
        if (!targetEl && sentObj.domId) {
          try {
            const escId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(String(sentObj.domId)) : String(sentObj.domId).replace(/([ #;?%&,.+*~\':"!^$[\]()=>|\/@])/g, '\\$1');
            targetEl = el.paperContent.querySelector(`#${escId}, [data-sent-id="${sentObj.domId}"]`);
          } catch (e) {}
        }
      }
      // 3. 备用：全局 getElementById 兜底
      if (!targetEl) {
        targetEl = el.paperContent.querySelector(`[data-sent-id="${target}"], [data-point-id="${target}"]`);
      }
      if (!targetEl) {
        try {
          targetEl = document.getElementById(String(target));
        } catch (e) {}
      }
    }

    if (lastSpotlightEl && targetEl === lastSpotlightEl) {
      if (state.playMode === 'sentence') {
        targetEl.classList.add('loop-sent-active');
      } else {
        targetEl.classList.remove('loop-sent-active');
      }
      return;
    }

    if (lastSpotlightEl) {
      lastSpotlightEl.classList.remove('active-spotlight');
      lastSpotlightEl.classList.remove('loop-sent-active');
    }

    if (targetEl) {
      targetEl.classList.add('active-spotlight');
      if (state.playMode === 'sentence') {
        targetEl.classList.add('loop-sent-active');
      }
      lastSpotlightEl = targetEl;

      // 视口舒适视线中心滑动追踪：保持高光处于屏幕黄金阅读线（vh * 0.40），杜绝沉底挤压与反复弹跳
      const now = Date.now();
      const rate = (audio && audio.playbackRate > 0) ? audio.playbackRate : (state.speed || 1.0);
      const throttleInterval = Math.max(300, Math.round(700 / rate));
      if (!isBodyScrollLocked() && now - state.lastUserScrollTime > 2000 && now - lastScrollTs > throttleInterval) {
        const rect = targetEl.getBoundingClientRect();
        const vh = window.innerHeight || 800;
        const idealTop = vh * 0.40;
        const delta = rect.top - idealTop;
        if (Math.abs(delta) > 50) {
          lastScrollTs = now;
          isProgrammaticScrolling = true;
          if (programmaticScrollTimer) clearTimeout(programmaticScrollTimer);
          programmaticScrollTimer = setTimeout(() => { isProgrammaticScrolling = false; }, 380);
          const mainStage = document.querySelector('.main-stage');
          const isStageScrollable = mainStage && mainStage.scrollHeight > mainStage.clientHeight;
          if (isStageScrollable) {
            mainStage.scrollBy({ top: delta, behavior: 'smooth' });
          } else {
            window.scrollBy({ top: delta, behavior: 'smooth' });
          }
        }
      }
    } else {
      lastSpotlightEl = null;
    }

    if (currentFrameworkSections.length > 0 && currentActiveSectionIndex >= 0) {
      currentFrameworkSections.forEach((s, idx) => {
        if (s.cardEl) {
          s.cardEl.classList.toggle('loop-sec-active', idx === currentActiveSectionIndex && state.playMode === 'section');
        }
      });
    }
  }

  // ==========================================
  // 全息感知 (Now-Playing HUD)) 与骨架大纲核心引擎
  // ==========================================
  let currentFrameworkSections = [];
  let currentActiveSectionIndex = -1;

  function buildFrameworkIndex() {
    currentFrameworkSections = [];
    currentActiveSectionIndex = -1;

    if (!el.paperContent) return;

    // 政治 47 章背诵模式优先索引 .xt-part-box 与 .stream-card；英语大/小作文优先索引各自然段 .en-essay-para
    let cards = [];
    if (el.paperContent.querySelector('.xt-part-box')) {
      cards = Array.from(el.paperContent.querySelectorAll('.xt-part-box, .stream-card, .xt-day-point-card, .tj-handbook-card, .exam-section-card, .logic-block-card')).filter(c => c.classList.contains('xt-part-box') || !c.closest('.xt-part-box'));
    } else if (state.currentSubject === 'en' && el.paperContent.querySelector('.en-essay-para')) {
      cards = Array.from(el.paperContent.querySelectorAll('.en-essay-para'));
    } else {
      cards = Array.from(el.paperContent.querySelectorAll('.exam-section-card, .logic-block-card, section.exam-section-card, .xt-section, .xt-day-point-card, .stream-card, .tj-handbook-card'));
    }
    
    cards.forEach((card, idx) => {
      const isPointCard = card.classList.contains('xt-day-point-card') && !!card.dataset.pointId;
      const cardSents = getCardTimedSentences(card);
      if (!isPointCard && cardSents.length === 0) {
        return;
      }
      const firstSent = cardSents.length > 0 ? cardSents[0] : null;
      const lastSent = cardSents.length > 0 ? cardSents[cardSents.length - 1] : null;
      let start = firstSent ? parseFloat(firstSent.dataset.start || 0) : 0;
      let end = lastSent ? parseFloat(lastSent.dataset.end || 0) : 0;
      let sentId = firstSent ? (firstSent.dataset.sentId ?? firstSent.dataset.sentIdx ?? firstSent.id) : null;

      // 权威时间戳映射：优先从 state.activeSentences 对齐精确起止时间
      if (firstSent && state.activeSentences && state.activeSentences.length > 0) {
        const rawIdx = firstSent.dataset.sentIdx !== undefined ? parseInt(firstSent.dataset.sentIdx, 10) : NaN;
        const rawId = firstSent.dataset.sentId || firstSent.id;
        const matchedFirst = state.activeSentences.find(s => (!isNaN(rawIdx) && (s.idx === rawIdx || s.id === rawIdx)) || (rawId && (String(s.id) === String(rawId) || String(s.domId) === String(rawId))));
        if (matchedFirst && typeof matchedFirst.start === 'number' && !isNaN(matchedFirst.start)) {
          start = matchedFirst.start;
          sentId = matchedFirst.idx !== undefined ? matchedFirst.idx : (matchedFirst.id || sentId);
        }
      }
      if (lastSent && state.activeSentences && state.activeSentences.length > 0) {
        const rawIdx = lastSent.dataset.sentIdx !== undefined ? parseInt(lastSent.dataset.sentIdx, 10) : NaN;
        const rawId = lastSent.dataset.sentId || lastSent.id;
        const matchedLast = state.activeSentences.find(s => (!isNaN(rawIdx) && (s.idx === rawIdx || s.id === rawIdx)) || (rawId && (String(s.id) === String(rawId) || String(s.domId) === String(rawId))));
        if (matchedLast && typeof matchedLast.end === 'number' && !isNaN(matchedLast.end)) {
          end = matchedLast.end;
        }
      }

      // 英语写作书信类：若首段前有称呼(salutation)，尾段后有落款(signoff)，自动吸纳进对应段落范围
      if (state.currentSubject === 'en' && card.classList.contains('en-essay-para')) {
        if (idx === 0) {
          const salutation = el.paperContent.querySelector('.en-letter-salutation-wrap .recite-sent');
          if (salutation && state.activeSentences) {
            const mSal = state.activeSentences.find(s => String(s.id) === String(salutation.dataset.sentId));
            if (mSal) {
              start = Math.min(start, mSal.start);
              sentId = mSal.id || sentId;
            }
          }
        }
        if (idx === cards.length - 1) {
          const signoff = el.paperContent.querySelector('.en-letter-signoff-wrap .recite-sent');
          if (signoff && state.activeSentences) {
            const mSign = state.activeSentences.find(s => String(s.id) === String(signoff.dataset.sentId));
            if (mSign) {
              end = Math.max(end, mSign.end);
            }
          }
        }
      }

      if (card.classList.contains('xt-day-point-card')) {
        const pId = card.dataset.pointId;
        const matchedPt = state.activeSentences ? state.activeSentences.find(s => String(s.id) === String(pId)) : null;
        if (matchedPt) {
          start = matchedPt.start;
          end = matchedPt.end;
          sentId = pId;
        }
      }

      let badge = '';
      let desc = '';
      
      const secBadgeEl = card.querySelector('.sec-badge');
      const secDescEl = card.querySelector('.sec-desc');
      const logicTitleEl = card.querySelector('.logic-block-title h3, h3');
      const qaBadgeEl = card.querySelector('.qa-badge');

      if (state.currentSubject === 'en' && card.classList.contains('en-essay-para')) {
        badge = `第 ${idx + 1} 自然段 · ${idx === 0 ? '首段破题' : (idx === cards.length - 1 ? '尾段升华' : '正文主体')}`;
        desc = '高分范文论述段落';
      } else if (card.classList.contains('xt-part-box')) {
        const isRecitePart = card.classList.contains('xt-part-recite');
        const badgeEl = card.querySelector('.xt-part-badge');
        badge = badgeEl ? badgeEl.textContent.trim() : (isRecitePart ? '一、背诵部分' : '二、深度理解');
        const hintEl = card.querySelector('.xt-part-hint');
        desc = hintEl ? hintEl.textContent.trim() : (isRecitePart ? '分析大题采分骨架' : '真题考点因果深解');
      } else if (card.classList.contains('stream-card')) {
        const labelEl = card.querySelector('.stream-card-label span, .stream-card-label');
        const tipBadge = card.querySelector('.stream-tip-badge, .stream-takeaway-tag, .pitfall-title');
        if (labelEl) {
          badge = labelEl.textContent.trim().replace(/^[^一-龥A-Za-z0-9]+/, '');
        } else if (tipBadge) {
          badge = tipBadge.textContent.trim().replace(/^[^一-龥A-Za-z0-9]+|[^一-龥A-Za-z0-9]+$/g, '');
        } else {
          badge = `微考点论述 ${idx + 1}`;
        }
        const titleEl = card.querySelector('.stream-card-title, h4, h3');
        desc = titleEl ? titleEl.textContent.trim() : '';
      } else if (card.classList.contains('xt-day-point-card')) {
        const tagEl = card.querySelector('.xt-point-num-tag');
        badge = tagEl ? tagEl.textContent.trim() : `考点 ${idx + 1}`;
        desc = '选择题核心题眼';
      } else if (card.classList.contains('xt-section') || card.classList.contains('tj-handbook-card')) {
        const titleEl = card.querySelector('.tj-card-title, h3');
        const tagEl = card.querySelector('.tj-card-tag');
        badge = tagEl ? tagEl.textContent.trim() : (titleEl ? titleEl.textContent.trim() : `讲义 ${idx + 1}`);
        desc = titleEl ? titleEl.textContent.trim() : '';
      } else if (secBadgeEl) {
        badge = secBadgeEl.textContent.trim().replace(/^【|】$/g, '');
        desc = secDescEl ? secDescEl.textContent.trim() : '';
      } else if (logicTitleEl) {
        badge = logicTitleEl.textContent.trim();
        desc = qaBadgeEl ? qaBadgeEl.textContent.trim() : '';
      } else {
        badge = `第 ${idx + 1} 论述板块`;
      }

      // 识别节点类型，全面支持审题定标规程、立论破题、论述分论点与结语升华
      let secType = 'point';
      if (/审题|规程/.test(badge)) {
        secType = 'spec';
      } else if (/引论|立论|首段/.test(badge)) {
        secType = 'intro';
      } else if (/结语|总结|尾段/.test(badge)) {
        secType = 'conclusion';
      }

      const thesisSentEl = card.querySelector('.thesis-sent, .teacher-explain-row .recite-sent, .recite-sent[data-sent-id], .recite-sent[data-sent-idx], .recite-sent');
      const thesisText = thesisSentEl ? thesisSentEl.textContent.replace(/【[^】]+】/g, '').trim() : '';

      currentFrameworkSections.push({
        index: currentFrameworkSections.length,
        type: secType,
        badge: badge,
        desc: desc,
        start: start,
        end: end,
        sentId: sentId,
        cardEl: card,
        thesisSnippet: thesisText.slice(0, 65) + (thesisText.length > 65 ? '...' : '')
      });
    });

    if (currentFrameworkSections.length === 0 && state.activeSentences && state.activeSentences.length > 0) {
      const lastGlobal = state.activeSentences[state.activeSentences.length - 1];
      currentFrameworkSections.push({
        index: 0,
        badge: '全文答题展开',
        desc: '核心论述',
        start: 0,
        end: lastGlobal ? parseFloat(lastGlobal.end || 0) : 0,
        sentId: state.activeSentences[0].id,
        cardEl: null,
        thesisSnippet: state.activeSentences[0].text
      });
    }

    const lastGlobalSent = (state.activeSentences && state.activeSentences.length > 0)
      ? state.activeSentences[state.activeSentences.length - 1]
      : null;
    const fallbackTotalEnd = (lastGlobalSent && lastGlobalSent.end) ? parseFloat(lastGlobalSent.end) : (audio.duration || 9999);
    for (let i = 0; i < currentFrameworkSections.length; i++) {
      const sec = currentFrameworkSections[i];
      const nextSec = (i < currentFrameworkSections.length - 1) ? currentFrameworkSections[i + 1] : null;
      if (!sec.end || isNaN(sec.end) || sec.end <= sec.start) {
        sec.end = (nextSec && nextSec.start > sec.start)
          ? nextSec.start
          : fallbackTotalEnd;
      }
      if (nextSec && typeof nextSec.start === 'number' && sec.end > nextSec.start) {
        sec.end = nextSec.start;
      }
    }

    updateHUDDisplay(audio.currentTime || 0);
    renderOutlineDrawer();
    renderProgressTicks();
  }

  function updateHUDDisplay(curTime = 0) {
    if (!state.activeItem) return;
    const item = state.activeItem;
    const isT1 = state.currentTrack === 1;

    // 1. 轨道徽章与可点击切换样式
    if (el.hudTrackBadge && el.hudTrackText) {
      el.hudTrackBadge.className = isT1 ? 'hud-track-badge track1-mode' : 'hud-track-badge track2-mode';
      if (state.currentSubject === 'pol') {
        if (state.polSubMode === 'recite47') {
          el.hudTrackText.textContent = isT1 ? '轨一 · 原书背诵版' : '轨二 · 微考点伴读';
        } else if (state.polSubMode === 'xutao16') {
          el.hudTrackText.textContent = state.polXtVoice === 'anlang' ? '龙安朗 · AI干货' : '徐涛 · 原声带背';
        } else {
          el.hudTrackText.textContent = '腿姐 · 冲刺讲义';
        }
      } else if (state.currentSubject === 'en') {
        el.hudTrackText.textContent = isT1 ? '轨一 · 中英磨耳版' : '轨二 · 仿写拓展版';
      } else {
        el.hudTrackText.textContent = isT1 ? '轨一 · 考场答题版' : '轨二 · 逻辑精解版';
      }
    }

    // 2. 考题标题与分值
    if (el.hudTitleText) {
      const subjPrefix = state.currentSubject === 'pol' ? '政治' : (state.currentSubject === '807' ? '807' : (state.currentSubject === '706' ? '706' : '英语'));
      const scoreBadge = item.score ? ` (${item.score})` : '';
      el.hudTitleText.textContent = `${subjPrefix} · ${item.title}${scoreBadge}`;
    }

    // 3. 动态框架层级与正文吸顶/高亮联动
    if (currentFrameworkSections.length > 0) {
      let activeSecIdx = 0;
      // 第一性原理：若处于单段循环模式，目标段落绝对锁定为 currentActiveSectionIndex，杜绝播放时间抖动篡改段落！
      if (state.playMode === 'section' && currentActiveSectionIndex >= 0 && currentActiveSectionIndex < currentFrameworkSections.length) {
        activeSecIdx = currentActiveSectionIndex;
      } else {
        for (let i = 0; i < currentFrameworkSections.length; i++) {
          if (curTime >= currentFrameworkSections[i].start - 0.1) {
            activeSecIdx = i;
          } else {
            break;
          }
        }
      }

      const sec = currentFrameworkSections[activeSecIdx];
      const total = currentFrameworkSections.length;

      let modePrefix = '';
      if (state.playMode === 'section') modePrefix = '[单段循环] ';
      else if (state.playMode === 'sentence') modePrefix = '[单句循环] ';
      else if (state.playMode === 'item') modePrefix = '[完全循环] ';

      if (el.hudFrameworkText) {
        el.hudFrameworkText.textContent = `大纲 [${sec.index + 1}/${total}]`;
      }

      currentFrameworkSections.forEach((s, idx) => {
        if (s.cardEl) {
          s.cardEl.classList.toggle('loop-sec-active', idx === activeSecIdx && state.playMode === 'section');
        }
      });

      const hudSecKey = `${item.id}_${state.currentTrack}_${state.playMode}_${activeSecIdx}`;
      if (state.playMode !== 'section') {
        if (activeSecIdx !== currentActiveSectionIndex || hudSecKey !== lastHudSectionKey) {
          currentActiveSectionIndex = activeSecIdx;
          lastHudSectionKey = hudSecKey;
          currentFrameworkSections.forEach((s, idx) => {
            if (s.cardEl) s.cardEl.classList.toggle('active-section-card', idx === activeSecIdx);
          });
          updateOutlineDrawerActive(activeSecIdx);
          updateSystemMediaSession(sec, total);
        }
      } else if (hudSecKey !== lastHudSectionKey) {
        lastHudSectionKey = hudSecKey;
        // 单段循环下仅在状态变化时刷新 DOM 焦点与锁屏元数据，杜绝 60fps 重复分配
        currentFrameworkSections.forEach((s, idx) => {
          if (s.cardEl) s.cardEl.classList.toggle('active-section-card', idx === currentActiveSectionIndex);
        });
        updateOutlineDrawerActive(currentActiveSectionIndex);
        updateSystemMediaSession(sec, total);
      }
    } else {
      if (el.hudFrameworkText) {
        let modePrefix = '';
        if (state.playMode === 'section') modePrefix = '[单段循环] ';
        else if (state.playMode === 'sentence') modePrefix = '[单句循环] ';
        else if (state.playMode === 'item') modePrefix = '[完全循环] ';
        el.hudFrameworkText.textContent = `大纲`;
      }
    }
  }

  function updateSystemMediaSession(currentSec, totalSec) {
    if (!('mediaSession' in navigator) || !state.activeItem) return;

    const item = state.activeItem;
    const isT1 = state.currentTrack === 1;
    let trackLabel = isT1 ? '轨一·考场答题' : '轨二·逻辑精解';
    if (state.currentSubject === 'pol') {
      if (state.polSubMode === 'recite47') trackLabel = isT1 ? '轨一·原书背诵' : '轨二·微考点伴读';
      else if (state.polSubMode === 'xutao16') trackLabel = state.polXtVoice === 'anlang' ? '龙安朗·AI干货' : '徐涛·原声带背';
      else trackLabel = '腿姐·冲刺讲义';
    } else if (state.currentSubject === 'en') {
      trackLabel = isT1 ? '轨一·磨耳版' : '轨二·拓展版';
    }

    const secTitle = currentSec ? `[${currentSec.index + 1}/${totalSec} ${currentSec.badge}] ` : '';
    const subjName = state.currentSubject === 'pol' ? '考研政治' : (state.currentSubject === '807' ? '807 现代文学' : (state.currentSubject === '706' ? '706 古代文学' : '考研英语写作'));

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `[${trackLabel}] ${item.title}`,
        artist: `${secTitle}${subjName} · ${item.score || ''}`,
        album: '2027 考研全科双轨随身背诵手卷 (龙安立师资朗读)',
        artwork: [
          { src: 'icon-256.png', sizes: '256x256', type: 'image/png' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' }
        ]
      });
    } catch (e) {
      // Ignore mediaSession metadata errors in unsupported environments
    }
  }

  function setupMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;

    try {
      navigator.mediaSession.setActionHandler('play', () => {
        audio.play().catch(e => console.log(e));
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        audio.pause();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        playPrevItem();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        playNextItem();
      });
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        const nextT = Math.max(0, audio.currentTime - (details.seekOffset || 5));
        audio.currentTime = nextT;
        syncManualSeekPointers(nextT);
      });
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        const dur = audio.duration;
        const nextT = (dur && isFinite(dur)) ? Math.min(dur, audio.currentTime + (details.seekOffset || 5)) : (audio.currentTime + (details.seekOffset || 5));
        audio.currentTime = nextT;
        syncManualSeekPointers(nextT);
      });
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== null && details.seekTime !== undefined) {
          audio.currentTime = details.seekTime;
          syncManualSeekPointers(details.seekTime);
        }
      });
    } catch (e) {
      console.warn('MediaSession handler error:', e);
    }
  }

  function renderOutlineDrawer() {
    if (!el.outlineDrawerBody) return;
    el.outlineDrawerBody.innerHTML = '';

    if (el.drawerTrackBadge) {
      const isT1 = state.currentTrack === 1;
      el.drawerTrackBadge.className = isT1 ? 'outline-drawer-track-badge track1-mode' : 'outline-drawer-track-badge track2-mode';
      if (state.currentSubject === 'pol') {
        if (state.polSubMode === 'recite47') {
          el.drawerTrackBadge.textContent = isT1 ? '47章 · 原书背诵版' : '47章 · 微考点伴读';
        } else if (state.polSubMode === 'xutao16') {
          el.drawerTrackBadge.textContent = state.polXtVoice === 'anlang' ? '徐涛16天 · AI干货' : '徐涛16天 · 原声带背';
        } else {
          el.drawerTrackBadge.textContent = '腿姐11天 · 冲刺讲义';
        }
      } else if (state.currentSubject === 'en') {
        el.drawerTrackBadge.textContent = isT1 ? '轨道一 · 中英磨耳版' : '轨道二 · 仿写拓展版';
      } else {
        el.drawerTrackBadge.textContent = isT1 ? '轨道一 · 考场答题版' : '轨道二 · 逻辑精解版';
      }
    }

    if (el.drawerTopicSub && state.activeItem) {
      const item = state.activeItem;
      const subj = state.currentSubject === 'pol' ? '考研政治' : (state.currentSubject === '807' ? '807 综合' : (state.currentSubject === '706' ? '706 综合' : '考研英语'));
      el.drawerTopicSub.textContent = `${subj} · ${item.title}${item.score ? ` (${item.score})` : ''}`;
    }

    if (!currentFrameworkSections || currentFrameworkSections.length === 0) {
      el.outlineDrawerBody.innerHTML = '<div style="padding:24px;text-align:center;color:var(--ink-muted);font-size:13px;">暂无大纲节点</div>';
      return;
    }

    const total = currentFrameworkSections.length;
    currentFrameworkSections.forEach((sec, idx) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'outline-node-item' + (idx === currentActiveSectionIndex ? ' active-node' : '');
      itemEl.dataset.idx = idx;

      itemEl.innerHTML = `
        <div class="outline-node-num">[${idx + 1}/${total}]</div>
        <div class="outline-node-info">
          <div class="outline-node-header">
            <span class="outline-node-badge badge-type-${sec.type || 'point'}">${sec.badge}</span>
            ${sec.desc ? `<span class="outline-node-desc">${sec.desc}</span>` : ''}
          </div>
          ${sec.thesisSnippet ? `<div class="outline-node-snippet">${sec.thesisSnippet}</div>` : ''}
        </div>
        <div class="outline-node-action">
          <span class="outline-node-time">${formatTime(sec.start)}</span>
          <svg class="outline-jump-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
        </div>
      `;

      itemEl.addEventListener('click', () => {
        if (sec.sentId !== null && !isNaN(sec.start)) {
          seekToSentence(sec.sentId, sec.start);
          if (sec.cardEl) {
            sec.cardEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
        closeOutlineDrawer();
      });

      el.outlineDrawerBody.appendChild(itemEl);
    });
  }

  function updateOutlineDrawerActive(activeIdx) {
    if (!el.outlineDrawerBody) return;
    const nodes = el.outlineDrawerBody.querySelectorAll('.outline-node-item');
    nodes.forEach(n => {
      n.classList.toggle('active-node', parseInt(n.dataset.idx, 10) === activeIdx);
    });
  }

  function openOutlineDrawer() {
    renderOutlineDrawer();
    if (el.outlineDrawer) {
      el.outlineDrawer.classList.add('open');
      setPlayerDockReceded(true);
      el.outlineDrawer.setAttribute('aria-hidden', 'false');
    }
    if (el.outlineDrawerBackdrop) {
      el.outlineDrawerBackdrop.style.display = 'block';
    }
    lockBodyScroll('outlineDrawer');
  }

  function closeOutlineDrawer() {
    if (el.outlineDrawer) {
      el.outlineDrawer.classList.remove('open');
      setPlayerDockReceded(false);
      el.outlineDrawer.setAttribute('aria-hidden', 'true');
    }
    if (el.outlineDrawerBackdrop) {
      el.outlineDrawerBackdrop.style.display = 'none';
    }
    unlockBodyScroll('outlineDrawer');
  }

  function renderProgressTicks() {
    if (!el.progressBar) return;
    const barBg = el.progressBar.querySelector('.progress-bar-bg');
    if (!barBg) return;

    barBg.querySelectorAll('.progress-sec-tick').forEach(t => t.remove());

    const dur = audio.duration || 0;
    if (dur > 0 && currentFrameworkSections.length > 1) {
      currentFrameworkSections.forEach((sec, idx) => {
        if (idx > 0 && sec.start > 0 && sec.start < dur) {
          const tick = document.createElement('span');
          tick.className = 'progress-sec-tick';
          tick.style.left = `${(sec.start / dur) * 100}%`;
          tick.title = sec.badge;
          barBg.appendChild(tick);
        }
      });
    }
  }

  let lastTimeSaveTs = 0;

  function syncManualSeekPointers(targetTime) {
    state.loopCount = 0;
    if (state.activeSentences && state.activeSentences.length > 0) {
      const idx = findActiveSentenceIndex(targetTime);
      if (idx !== -1) {
        state.currentSentIndex = idx;
        highlightSentence(idx);
      }
    }
    if (state.playMode !== 'section' && currentFrameworkSections.length > 0) {
      const secIdx = findSectionIndexAtTime(targetTime);
      if (secIdx !== -1) currentActiveSectionIndex = secIdx;
    }
    updateHUDDisplay(targetTime);
  }

  function toggleAudioPlayback() {
    const hasSrc = Boolean(audio.getAttribute('src') || audio.currentSrc);
    if (hasSrc) {
      expandPlayerDock();
    }
    if (audio.paused) {
      if (!hasSrc) {
        if (state.currentSubject === 'pol' && state.polSubMode === 'recite47' && state.currentTrack === 2) {
          showToast('当前为纯图表速览卡片，无伴读音频，可点击后续考点卡片播放', 2200);
        } else {
          loadTrackData(state.currentTrack, true);
        }
      } else {
        audio.play().catch(e => console.log('Play failed:', e));
      }
    } else {
      audio.pause();
    }
  }
  const togglePlay = toggleAudioPlayback;

  function setupAudioEngine() {
    syncRafId = null;

    // 60fps 高频毫秒级聚光同步引擎 (彻底消除 timeupdate 的 300ms 滞后与 1s 句子迟滞)
    function runSyncLoop() {
      if (state.isPlaying && !audio.paused && state.activeSentences && state.activeSentences.length > 0) {
        const cur = audio.currentTime;

        // 寻音着陆守卫：音频未实际跳转到位前锁定目标句高亮与时间戳，必要时二次补跳，彻底杜绝跳回第 0 句
        if (pendingSeekTarget && pendingSeekTarget.token === seekToken) {
          const drift = Math.abs(cur - pendingSeekTarget.time);
          if (drift <= 0.45 && audio.readyState >= 2 && !audio.seeking) {
            clearPendingSeek(true);
            isLoopSeeking = false;
            if (loopSeekTimer) { clearTimeout(loopSeekTimer); loopSeekTimer = null; }
          } else if (Date.now() - pendingSeekTarget.startedAt < 3800) {
            if (audio.readyState >= 1 && !audio.seeking && drift > 0.5) {
              try { audio.currentTime = pendingSeekTarget.time; } catch (e) {}
            }
            if (pendingSeekTarget.idx !== -1) {
              state.currentSentIndex = pendingSeekTarget.idx;
              highlightSentence(pendingSeekTarget.idx);
            }
            updateHUDDisplay(pendingSeekTarget.time);
            syncRafId = requestAnimationFrame(runSyncLoop);
            return;
          } else {
            clearPendingSeek(true);
            isLoopSeeking = false;
          }
        }

        // 政治徐涛16天带背原声前奏导言区自动跳过 (若从开头播放且 cur < firstPoint.start - 0.3)
        if (state.currentSubject === 'pol' && state.polSubMode === 'xutao16') {
          const firstPoint = state.activeSentences[0];
          if (firstPoint && typeof firstPoint.start === 'number' && firstPoint.start > 0.5 && cur < firstPoint.start - 0.3) {
            audio.currentTime = firstPoint.start;
            syncRafId = requestAnimationFrame(runSyncLoop);
            return;
          }
        }

        // 1. 单句循环模式 (严格第一性原理闭环：目标句子只能由用户显式指定，绝对锁定不可篡改)
        if (state.playMode === 'sentence' && state.activeSentences && state.activeSentences.length > 0) {
          if (state.currentSentIndex < 0 || state.currentSentIndex >= state.activeSentences.length) {
            const initialIdx = findActiveSentenceIndex(cur);
            state.currentSentIndex = initialIdx !== -1 ? initialIdx : 0;
            state.loopCount = 0;
          }

          const sent = state.activeSentences[state.currentSentIndex];
          const nextSent = (state.currentSentIndex + 1 < state.activeSentences.length) ? state.activeSentences[state.currentSentIndex + 1] : null;
          const sStart = typeof sent.start === 'number' ? sent.start : parseFloat(sent.start || 0);
          const sEnd = typeof sent.end === 'number' ? sent.end : parseFloat(sent.end || (nextSent ? nextSent.start : Infinity));
          const nextStart = nextSent ? (typeof nextSent.start === 'number' ? nextSent.start : parseFloat(nextSent.start)) : Infinity;

          // 严格闭环截断边界：在下一句发声前精确截断，严禁穿透至下一句语音起始
          const loopCutoff = getLoopCutoff(sStart, sEnd, nextStart);

          if (isLoopSeeking && (Date.now() - lastSeekTs < 150)) {
            updateHUDDisplay(cur);
            syncRafId = requestAnimationFrame(runSyncLoop);
            return;
          }

          // 当 cur >= loopCutoff 或 cur > sEnd 时，无条件强制倒回当前句开头 sStart！
          // 目标句子 state.currentSentIndex 绝对锁定不可篡改，彻底铲除任何篡改指针漂移至下一句的逻辑！
          if (cur >= loopCutoff || cur > sEnd) {
            triggerLoopSeek(sStart);
            if (audio.paused) audio.play().catch(e => console.log(e));
            syncRafId = requestAnimationFrame(runSyncLoop);
            return;
          } else {
            // 若 cur < sStart - 0.3（倒带稍微过多或刚 seek 落地），保持当前句不变，静待其播放至 sStart
            highlightSentence(state.currentSentIndex);
            updateHUDDisplay(cur);
            syncRafId = requestAnimationFrame(runSyncLoop);
            return;
          }
        }
        // 2. 单句3遍模式 (满3遍后精准推移至下一句，单句循环期间目标句子绝对锁定不可篡改)
        else if (state.playMode === 'loop3' && state.activeSentences && state.activeSentences.length > 0) {
          if (state.currentSentIndex < 0 || state.currentSentIndex >= state.activeSentences.length) {
            const initialIdx = findActiveSentenceIndex(cur);
            state.currentSentIndex = initialIdx !== -1 ? initialIdx : 0;
            state.loopCount = 0;
          }

          const sent = state.activeSentences[state.currentSentIndex];
          const nextSent = (state.currentSentIndex + 1 < state.activeSentences.length) ? state.activeSentences[state.currentSentIndex + 1] : null;
          const sStart = typeof sent.start === 'number' ? sent.start : parseFloat(sent.start || 0);
          const sEnd = typeof sent.end === 'number' ? sent.end : parseFloat(sent.end || (nextSent ? nextSent.start : Infinity));
          const nextStart = nextSent ? (typeof nextSent.start === 'number' ? nextSent.start : parseFloat(nextSent.start)) : Infinity;
          const loopCutoff = getLoopCutoff(sStart, sEnd, nextStart);

          if (isLoopSeeking && (Date.now() - lastSeekTs < 150)) {
            updateHUDDisplay(cur);
            syncRafId = requestAnimationFrame(runSyncLoop);
            return;
          }

          if (cur >= loopCutoff || cur > sEnd) {
            if (state.loopCount < 2) {
              state.loopCount++;
              triggerLoopSeek(sStart);
              if (audio.paused) audio.play().catch(e => console.log(e));
              syncRafId = requestAnimationFrame(runSyncLoop);
              return;
            } else {
              state.loopCount = 0;
              if (nextSent) {
                state.currentSentIndex++;
                triggerLoopSeek(nextStart);
                highlightSentence(state.currentSentIndex);
                updateHUDDisplay(nextStart);
                syncRafId = requestAnimationFrame(runSyncLoop);
                return;
              } else {
                state.isPlaying = false;
                audio.pause();
                updatePlayBtnUI();
                playNextItem();
                return;
              }
            }
          } else {
            highlightSentence(state.currentSentIndex);
            updateHUDDisplay(cur);
            syncRafId = requestAnimationFrame(runSyncLoop);
            return;
          }
        }
        // 3. 单段循环模式 (严格在当前段落 [curSec.start, curSec.end] 内部无缝闭环回跳，绝对不允许篡改 currentActiveSectionIndex)
        else if (state.playMode === 'section' && currentFrameworkSections.length > 0) {
          if (currentActiveSectionIndex < 0 || currentActiveSectionIndex >= currentFrameworkSections.length) {
            const matchedSecIdx = findSectionIndexAtTime(cur);
            currentActiveSectionIndex = matchedSecIdx !== -1 ? matchedSecIdx : 0;
          }

          const curSec = currentFrameworkSections[currentActiveSectionIndex];
          const nextSec = (currentActiveSectionIndex + 1 < currentFrameworkSections.length) ? currentFrameworkSections[currentActiveSectionIndex + 1] : null;
          if (curSec && typeof curSec.start === 'number' && typeof curSec.end === 'number' && curSec.end > curSec.start) {
            const nextSecStart = nextSec && typeof nextSec.start === 'number' ? nextSec.start : Infinity;
            const secCutoff = getLoopCutoff(curSec.start, curSec.end, nextSecStart);

            if (isLoopSeeking && (Date.now() - lastSeekTs < 150)) {
              updateHUDDisplay(cur);
              syncRafId = requestAnimationFrame(runSyncLoop);
              return;
            }

            // 当到达段尾截断点或滑过段尾时，无条件强制倒回当前段开头 curSec.start！
            // currentActiveSectionIndex 绝对锁定不可被时间篡改！
            if (cur >= secCutoff || cur > curSec.end) {
              const secUpper = isFinite(nextSecStart) ? (nextSecStart - 0.02) : (curSec.end + 0.05);
              const firstSentIdx = state.activeSentences.findIndex(s => s.start >= curSec.start - 0.02 && s.start < secUpper);
              const fallbackIdx = findActiveSentenceIndex(curSec.start);
              const targetIdx = firstSentIdx !== -1 ? firstSentIdx : (fallbackIdx !== -1 ? fallbackIdx : null);
              triggerLoopSeek(curSec.start, targetIdx);
              if (audio.paused) audio.play().catch(e => console.log(e));
              syncRafId = requestAnimationFrame(runSyncLoop);
              return;
            } else {
              updateHUDDisplay(cur);
              const activeIdx = findActiveSentenceIndex(cur);
              if (activeIdx !== -1 && activeIdx !== state.currentSentIndex) {
                const s = state.activeSentences[activeIdx];
                const secUpper = isFinite(nextSecStart) ? (nextSecStart - 0.02) : (curSec.end + 0.05);
                // 仅当句子属于当前段落半开区间时高亮，防止越界至下一段首句
                if (s && s.start >= curSec.start - 0.05 && s.start < secUpper) {
                  state.currentSentIndex = activeIdx;
                  highlightSentence(activeIdx);
                }
              }
              syncRafId = requestAnimationFrame(runSyncLoop);
              return;
            }
          }
        }

        // 4. 常规高光追踪 (寻音跳转锁保护：寻音期间绝不回退至第0句)
        if (!isLoopSeeking) {
          const activeIdx = findActiveSentenceIndex(cur);
          if (activeIdx !== -1 && activeIdx !== state.currentSentIndex) {
            if (lastClickedSentGuard && Date.now() < lastClickedSentGuard.until && cur < lastClickedSentGuard.time + 0.12 && activeIdx !== lastClickedSentGuard.idx) {
              syncRafId = requestAnimationFrame(runSyncLoop);
              return;
            }
            state.currentSentIndex = activeIdx;
            state.loopCount = 0;
            highlightSentence(activeIdx);
            updateHUDDisplay(cur);
          }
        }
      }
      if (state.isPlaying) {
        syncRafId = requestAnimationFrame(runSyncLoop);
      }
    }

    audio.addEventListener('play', () => {
      state.isPlaying = true;
      audio.playbackRate = state.speed;

      // 政治徐涛16天带背原声前奏导言区自动跳过（若用户刚主动点选过句子且在寻求目标时刻，不覆盖）
      if ((!pendingSeekTarget || pendingSeekTarget.token !== seekToken) && state.currentSubject === 'pol' && state.polSubMode === 'xutao16' && state.activeSentences && state.activeSentences.length > 0) {
        const firstPoint = state.activeSentences[0];
        if (firstPoint && typeof firstPoint.start === 'number' && firstPoint.start > 0.5 && audio.currentTime < firstPoint.start - 0.3) {
          audio.currentTime = firstPoint.start;
        }
      }
      if (pendingSeekTarget && pendingSeekTarget.token === seekToken && audio.readyState >= 1 && Math.abs(audio.currentTime - pendingSeekTarget.time) > 0.35) {
        try { audio.currentTime = pendingSeekTarget.time; } catch (e) {}
      }

      updatePlayBtnUI();
      expandPlayerDock();
      if (syncRafId) cancelAnimationFrame(syncRafId);
      syncRafId = requestAnimationFrame(runSyncLoop);
    });

    audio.addEventListener('pause', () => {
      clearPendingSeek(true);
      state.isPlaying = false;
      if (syncRafId) {
        cancelAnimationFrame(syncRafId);
        syncRafId = null;
      }
      updatePlayBtnUI();
      collapsePlayerDock(); // 暂停即自动收起为底栏
    });

    audio.addEventListener('seeked', () => {
      if (pendingSeekTarget && pendingSeekTarget.token === seekToken) {
        if (Math.abs(audio.currentTime - pendingSeekTarget.time) <= 0.45 && audio.readyState >= 2 && !audio.seeking) {
          clearPendingSeek(true);
          isLoopSeeking = false;
          if (loopSeekTimer) { clearTimeout(loopSeekTimer); loopSeekTimer = null; }
        } else if (audio.readyState >= 1 && Date.now() - pendingSeekTarget.startedAt < 3500) {
          try { audio.currentTime = pendingSeekTarget.time; } catch (e) {}
        }
        return;
      }
      if (isLoopSeeking && Date.now() - lastSeekTs >= 25) {
        isLoopSeeking = false;
        if (loopSeekTimer) {
          clearTimeout(loopSeekTimer);
          loopSeekTimer = null;
        }
      }
    });

    audio.addEventListener('canplay', () => {
      if (pendingSeekTarget && pendingSeekTarget.token === seekToken) {
        if (Math.abs(audio.currentTime - pendingSeekTarget.time) > 0.35 && !audio.seeking && Date.now() - pendingSeekTarget.startedAt < 3500) {
          try { audio.currentTime = pendingSeekTarget.time; } catch (e) {}
        } else if (Math.abs(audio.currentTime - pendingSeekTarget.time) <= 0.45 && audio.readyState >= 2) {
          clearPendingSeek(true);
          isLoopSeeking = false;
          if (loopSeekTimer) { clearTimeout(loopSeekTimer); loopSeekTimer = null; }
        }
      }
    });

    audio.addEventListener('timeupdate', () => {
      const cur = audio.currentTime;
      const dur = audio.duration || 0;

      if (cur > 1 && Date.now() - lastTimeSaveTs > 2000) {
        lastTimeSaveTs = Date.now();
        localStorage.setItem('kaoyan_last_time', String(cur));
        localStorage.setItem('kaoyan_last_time_key', `${state.currentSubject}_${state.activeItemId}_${state.currentTrack}`);
      }

      if (dur > 0 && el.progressFill) {
        const pct = Math.min(100, (cur / dur) * 100);
        el.progressFill.style.width = pct + '%';
      }
      if (el.timeCurrent) el.timeCurrent.textContent = formatTime(cur);
      if (el.timeTotal && dur > 0) el.timeTotal.textContent = formatTime(dur);

      updateHUDDisplay(cur);

      // 仅当未运行 60fps RAF 引擎（例如暂停或降级情况）时才由 timeupdate 补位判断边界，避免 loop3 双重累加
      if (state.isPlaying && !audio.paused && syncRafId) {
        return;
      }

      if (state.activeSentences && state.activeSentences.length > 0) {
        // 徐涛16天带背原声前奏导言区自动跳至第一考点
        if (state.currentSubject === 'pol' && state.polSubMode === 'xutao16') {
          const firstPoint = state.activeSentences[0];
          if (firstPoint && typeof firstPoint.start === 'number' && firstPoint.start > 0.5 && cur < firstPoint.start - 0.3) {
            audio.currentTime = firstPoint.start;
            return;
          }
        }

        // 1. 单句循环模式 (绝对锁定，强制闭环回跳)
        if (state.playMode === 'sentence' && state.activeSentences && state.activeSentences.length > 0) {
          if (state.currentSentIndex < 0 || state.currentSentIndex >= state.activeSentences.length) {
            const initialIdx = findActiveSentenceIndex(cur);
            state.currentSentIndex = initialIdx !== -1 ? initialIdx : 0;
            state.loopCount = 0;
          }
          if (isLoopSeeking && (Date.now() - lastSeekTs < 150)) {
            return;
          }
          const sent = state.activeSentences[state.currentSentIndex];
          const nextSent = (state.currentSentIndex + 1 < state.activeSentences.length) ? state.activeSentences[state.currentSentIndex + 1] : null;
          const sStart = typeof sent.start === 'number' ? sent.start : parseFloat(sent.start || 0);
          const sEnd = typeof sent.end === 'number' ? sent.end : parseFloat(sent.end || (nextSent ? nextSent.start : Infinity));
          const nextStart = nextSent ? (typeof nextSent.start === 'number' ? nextSent.start : parseFloat(nextSent.start)) : Infinity;
          const loopCutoff = getLoopCutoff(sStart, sEnd, nextStart);

          if (cur >= loopCutoff || cur > sEnd) {
            triggerLoopSeek(sStart);
            if (audio.paused) audio.play().catch(e => console.log(e));
          }
          return;
        }
        // 2. 单句3遍模式 (满3遍后推移，期间目标句子绝对锁定)
        else if (state.playMode === 'loop3' && state.activeSentences && state.activeSentences.length > 0) {
          if (state.currentSentIndex < 0 || state.currentSentIndex >= state.activeSentences.length) {
            const initialIdx = findActiveSentenceIndex(cur);
            state.currentSentIndex = initialIdx !== -1 ? initialIdx : 0;
            state.loopCount = 0;
          }
          if (isLoopSeeking && (Date.now() - lastSeekTs < 150)) {
            return;
          }
          const sent = state.activeSentences[state.currentSentIndex];
          const nextSent = (state.currentSentIndex + 1 < state.activeSentences.length) ? state.activeSentences[state.currentSentIndex + 1] : null;
          const sStart = typeof sent.start === 'number' ? sent.start : parseFloat(sent.start || 0);
          const sEnd = typeof sent.end === 'number' ? sent.end : parseFloat(sent.end || (nextSent ? nextSent.start : Infinity));
          const nextStart = nextSent ? (typeof nextSent.start === 'number' ? nextSent.start : parseFloat(nextSent.start)) : Infinity;
          const loopCutoff = getLoopCutoff(sStart, sEnd, nextStart);

          if (cur >= loopCutoff || cur > sEnd) {
            if (state.loopCount < 2) {
              state.loopCount++;
              triggerLoopSeek(sStart);
              if (audio.paused) audio.play().catch(e => console.log(e));
              return;
            } else {
              state.loopCount = 0;
              if (nextSent) {
                state.currentSentIndex++;
                triggerLoopSeek(nextStart);
                highlightSentence(state.currentSentIndex);
                updateHUDDisplay(nextStart);
                return;
              } else {
                triggerLoopSeek(sStart);
                if (audio.paused) audio.play().catch(e => console.log(e));
                return;
              }
            }
          }
          return;
        }
        // 3. 单段循环模式 (绝对锁定，强制闭环回跳)
        else if (state.playMode === 'section' && currentFrameworkSections.length > 0) {
          if (currentActiveSectionIndex < 0 || currentActiveSectionIndex >= currentFrameworkSections.length) {
            const matchedSecIdx = findSectionIndexAtTime(cur);
            currentActiveSectionIndex = matchedSecIdx !== -1 ? matchedSecIdx : 0;
          }
          if (isLoopSeeking && (Date.now() - lastSeekTs < 150)) {
            return;
          }
          const curSec = currentFrameworkSections[currentActiveSectionIndex];
          const nextSec = (currentActiveSectionIndex + 1 < currentFrameworkSections.length) ? currentFrameworkSections[currentActiveSectionIndex + 1] : null;
          if (curSec && typeof curSec.start === 'number' && typeof curSec.end === 'number' && curSec.end > curSec.start) {
            const nextSecStart = nextSec && typeof nextSec.start === 'number' ? nextSec.start : Infinity;
            const secCutoff = getLoopCutoff(curSec.start, curSec.end, nextSecStart);
            if (cur >= secCutoff || cur > curSec.end) {
              const secUpper = isFinite(nextSecStart) ? (nextSecStart - 0.02) : (curSec.end + 0.05);
              const firstSentIdx = state.activeSentences.findIndex(s => s.start >= curSec.start - 0.02 && s.start < secUpper);
              const fallbackIdx = findActiveSentenceIndex(curSec.start);
              const targetIdx = firstSentIdx !== -1 ? firstSentIdx : (fallbackIdx !== -1 ? fallbackIdx : null);
              triggerLoopSeek(curSec.start, targetIdx);
              if (audio.paused) audio.play().catch(e => console.log(e));
              return;
            }
          }
          return;
        }

        if (!isLoopSeeking) {
          const activeIdx = findActiveSentenceIndex(cur);
          if (activeIdx !== -1 && activeIdx !== state.currentSentIndex) {
            state.currentSentIndex = activeIdx;
            state.loopCount = 0;
            highlightSentence(activeIdx);
          }
        }
      }
    });

    audio.addEventListener('ended', () => {
      // 1. 完全循环（整个知识点循环）
      if (state.playMode === 'item') {
        triggerLoopSeek(0);
        audio.play().catch(e => console.log(e));
        return;
      }
      // 2. 单句循环
      if (state.playMode === 'sentence' && state.currentSentIndex !== -1 && state.activeSentences && state.activeSentences[state.currentSentIndex]) {
        triggerLoopSeek(state.activeSentences[state.currentSentIndex].start);
        audio.play().catch(e => console.log(e));
        return;
      }
      // 3. 单句3遍模式
      if (state.playMode === 'loop3' && state.currentSentIndex !== -1 && state.activeSentences && state.activeSentences[state.currentSentIndex]) {
        if (state.loopCount < 2) {
          state.loopCount++;
          triggerLoopSeek(state.activeSentences[state.currentSentIndex].start);
          audio.play().catch(e => console.log(e));
          return;
        } else {
          state.loopCount = 0;
        }
      }
      // 4. 单段循环
      if (state.playMode === 'section' && currentActiveSectionIndex >= 0 && currentActiveSectionIndex < currentFrameworkSections.length) {
        triggerLoopSeek(currentFrameworkSections[currentActiveSectionIndex].start);
        audio.play().catch(e => console.log(e));
        return;
      }
      // 5. 按顺序依次播放
      state.isPlaying = false;
      updatePlayBtnUI();
      playNextItem();
    });

    audio.addEventListener('loadedmetadata', () => {
      audio.playbackRate = state.speed;
      if (el.timeTotal) el.timeTotal.textContent = formatTime(audio.duration || 0);
      renderProgressTicks();
    });
  }

  function updatePlayBtnUI() {
    const centerPlaySvg = document.getElementById('centerIconPlay');
    const centerPauseSvg = document.getElementById('centerIconPause');
    const centerPlayLabel = document.getElementById('centerPlayLabel');
    if (state.isPlaying) {
      if (centerPlaySvg) centerPlaySvg.style.display = 'none';
      if (centerPauseSvg) centerPauseSvg.style.display = 'block';
      if (centerPlayLabel) centerPlayLabel.textContent = '暂停';
    } else {
      if (centerPlaySvg) centerPlaySvg.style.display = 'block';
      if (centerPauseSvg) centerPauseSvg.style.display = 'none';
      if (centerPlayLabel) centerPlayLabel.textContent = '播放';
    }

    if (el.paperContent) {
      el.paperContent.querySelectorAll('.recite-chapter-play-btn').forEach(btn => {
        btn.classList.toggle('playing', state.isPlaying);
        const textEl = btn.querySelector('.play-btn-text');
        if (textEl) {
          textEl.textContent = state.isPlaying ? '暂停背诵' : '整章背诵音频';
        }
      });
      el.paperContent.querySelectorAll('.card-audio-btn').forEach(btn => {
        btn.classList.toggle('playing', state.isPlaying);
        const textEl = btn.querySelector('.audio-btn-text');
        if (textEl) {
          textEl.textContent = state.isPlaying ? '暂停伴读' : '试听伴读';
        }
      });
    }

    if (!el.playBtn) return;
    if (state.isPlaying) {
      el.playBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <rect x="6" y="4" width="4" height="16" rx="1"></rect>
          <rect x="14" y="4" width="4" height="16" rx="1"></rect>
        </svg>`;
      el.playBtn.title = "暂停播放";
    } else {
      el.playBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <polygon points="6 4 20 12 6 20 6 4"></polygon>
        </svg>`;
      el.playBtn.title = "播放音频";
    }
  }

  function formatTime(sec) {
    if (isNaN(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  function playNextItem() {
    if (state.currentSubject === 'pol' && state.polSubMode === 'recite47' && state.currentTrack === 2 && state.activeItem?.track2?.subCards?.length > 1) {
      const subCards = state.activeItem.track2.subCards;
      const curIdx = subCards.findIndex(c => c.cardId === state.polSubCardId);
      if (curIdx >= 0 && curIdx < subCards.length - 1) {
        const nextCard = subCards[curIdx + 1];
        state.polSubCardId = nextCard.cardId;
        localStorage.setItem('kaoyan_pol_subcard_id', nextCard.cardId);
        document.querySelectorAll('#polSubcardPills .playlist-chip-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.cardId === nextCard.cardId);
        });
        const bodyEl = document.getElementById('polSubcardBody');
        if (bodyEl) {
          bodyEl.innerHTML = nextCard.lectureHtml || '';
          activateSubCardAudio(nextCard, true);
          enhanceClozeKeywords();
          buildFrameworkIndex();
        }
        return;
      }
    }
    const list = getCurrentItemsList();
    const currIdx = list.findIndex(x => x.id === state.activeItemId);
    if (currIdx !== -1 && currIdx < list.length - 1) {
      selectItem(list[currIdx + 1].id, true);
    }
  }

  function playPrevItem() {
    if (state.currentSubject === 'pol' && state.polSubMode === 'recite47' && state.currentTrack === 2 && state.activeItem?.track2?.subCards?.length > 1) {
      const subCards = state.activeItem.track2.subCards;
      const curIdx = subCards.findIndex(c => c.cardId === state.polSubCardId);
      if (curIdx > 0) {
        const prevCard = subCards[curIdx - 1];
        state.polSubCardId = prevCard.cardId;
        localStorage.setItem('kaoyan_pol_subcard_id', prevCard.cardId);
        document.querySelectorAll('#polSubcardPills .playlist-chip-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.cardId === prevCard.cardId);
        });
        const bodyEl = document.getElementById('polSubcardBody');
        if (bodyEl) {
          bodyEl.innerHTML = prevCard.lectureHtml || '';
          activateSubCardAudio(prevCard, true);
          enhanceClozeKeywords();
          buildFrameworkIndex();
        }
        return;
      }
    }
    const list = getCurrentItemsList();
    const currIdx = list.findIndex(x => x.id === state.activeItemId);
    if (currIdx > 0) {
      selectItem(list[currIdx - 1].id, true);
    }
  }

  function setupEventListeners() {
    // HUD 轨道点击快速切换
    if (el.hudTrackBadge) {
      el.hudTrackBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.currentSubject === 'pol') {
          if (state.polSubMode === 'xutao16') {
            const nextVoice = state.polXtVoice === 'anlang' ? 'voice' : 'anlang';
            state.polXtVoice = nextVoice;
            localStorage.setItem('kaoyan_pol_xt_voice', nextVoice);
            setXutao16Audio(state.activeItem, nextVoice, !audio.paused);
            document.querySelectorAll('.xt-voice-btn').forEach(b => {
              b.classList.toggle('active', b.dataset.voice === nextVoice);
            });
            showToast(`已切换至【${nextVoice === 'anlang' ? '龙安朗 AI 干货版' : '徐涛原声带背版'}】`, 2000);
            return;
          } else if (state.polSubMode === 'tuijie11') {
            showToast('当前为腿姐冲刺讲义伴读模式', 2000);
            return;
          }
        }
        const nextTrack = state.currentTrack === 1 ? 2 : 1;
        loadTrackData(nextTrack, state.isPlaying);
      });
    }

    // HUD 答题骨架点击展开大纲抽屉
    if (el.hudFrameworkTrigger) {
      el.hudFrameworkTrigger.addEventListener('click', openOutlineDrawer);
    }
    if (el.btnOpenOutline) {
      el.btnOpenOutline.addEventListener('click', (e) => {
        e.stopPropagation();
        openOutlineDrawer();
      });
    }
    if (el.outlineDrawerClose) {
      el.outlineDrawerClose.addEventListener('click', closeOutlineDrawer);
    }
        if (el.playModeClose) {
      el.playModeClose.addEventListener('click', closePlayModeDrawer);
    }
    if (el.playModeBackdrop) {
      el.playModeBackdrop.addEventListener('click', closePlayModeDrawer);
    }
    if (el.outlineDrawerBackdrop) {
      el.outlineDrawerBackdrop.addEventListener('click', closeOutlineDrawer);
    }
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (el.sidebar && el.sidebar.classList.contains('open')) closeSidebar();
        if (el.outlineDrawer && el.outlineDrawer.classList.contains('open')) closeOutlineDrawer();
        if (el.playModeDrawer && el.playModeDrawer.classList.contains('open')) closePlayModeDrawer();
        if (el.studyDashboardDrawer && el.studyDashboardDrawer.classList.contains('open')) closeStudyDashboard();
        const settingsDrawer = document.getElementById('settingsDrawer');
        if (settingsDrawer && settingsDrawer.classList.contains('open')) {
          const settingsClose = document.getElementById('settingsClose');
          if (settingsClose) settingsClose.click();
        }
        syncBodyScrollLock();
      }
    });

    // 掌握度印章切换与研学看板
    if (el.btnMasteryToggle) {
      el.btnMasteryToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        cycleCurrentItemMastery();
      });
    }

    // 正文顶部 stage-tier (如 T0/T1/题眼 胶囊) 点击交互增强：聚焦分级筛选并联动弹出题库抽屉
    if (el.stageTier) {
      el.stageTier.setAttribute('role', 'button');
      el.stageTier.setAttribute('tabindex', '0');
      el.stageTier.setAttribute('title', '点击按此分级筛选题库 · 打开考点抽屉');

      const handleStageTierClick = (e) => {
        if (e) e.stopPropagation();
        
        const sub = state.currentSubject;
        if (sub === '807' || sub === '706') {
          const itemLevel = state.activeItem?.level || el.stageTier.textContent.trim() || 'T0';
          // 若当前未以此分级筛选，则聚焦该级别；若已在此级别，则轮换回全部考点 (all)
          if (state.tierFilter !== itemLevel) {
            state.tierFilter = itemLevel;
            showToast(`已聚焦【${itemLevel}】级别考点`, 1800);
          } else {
            state.tierFilter = 'all';
            showToast('已重置为【全部考点】', 1800);
          }

          // 同步更新题库顶部筛选 pills
          if (el.filterPillsWrap) {
            el.filterPillsWrap.querySelectorAll('.filter-pill').forEach(b => {
              const pId = b.dataset.tier || b.dataset.filter;
              b.classList.toggle('active', pId === state.tierFilter);
            });
          }
          renderSidebarList();
        } else if (sub === 'en') {
          const itemType = state.activeItem?.category_id || state.activeItem?.type || 'all';
          if (state.tierFilter !== itemType && itemType !== 'all') {
            state.tierFilter = itemType;
            showToast(`已聚焦【${state.activeItem?.level || itemType}】类范文`, 1800);
          } else {
            state.tierFilter = 'all';
            showToast('已重置为【全部范文】', 1800);
          }
          if (el.filterPillsWrap) {
            el.filterPillsWrap.querySelectorAll('.filter-pill').forEach(b => {
              const pId = b.dataset.tier || b.dataset.filter;
              b.classList.toggle('active', pId === state.tierFilter);
            });
          }
          renderSidebarList();
        } else if (sub === 'pol') {
          if (state.polSubMode === 'recite47' && state.activeItem?.category) {
            const itemCat = state.activeItem.category;
            if (state.polCategory !== itemCat) {
              state.polCategory = itemCat;
              localStorage.setItem('kaoyan_pol_cat', itemCat);
              document.querySelectorAll('[data-pol-cat]').forEach(b => {
                b.classList.toggle('active', b.dataset.polCat === itemCat);
              });
              renderSidebarList();
              showToast(`已聚焦【${state.activeItem.categoryName || itemCat}】模块`, 1800);
            }
          }
        }

        // 打开题库抽屉 (移动端弹出侧边抽屉，桌面端若折叠则展开)
        if (isSidebarDrawerMode()) {
          openSidebar();
        } else {
          const appBody = document.querySelector('.app-body');
          if (appBody && appBody.classList.contains('sidebar-collapsed')) {
            appBody.classList.remove('sidebar-collapsed');
            localStorage.setItem('kaoyan_sidebar_collapsed', '0');
          }
        }

        // 平滑滚入当前考点卡片
        setTimeout(() => {
          if (el.itemList) {
            const activeCard = el.itemList.querySelector('.question-card-item.active') || el.itemList.querySelector('.question-card-item');
            if (activeCard) {
              activeCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
          }
        }, 80);
      };

      el.stageTier.addEventListener('click', handleStageTierClick);
      el.stageTier.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleStageTierClick(e);
        }
      });
    }

    if (el.masteryPillsWrap) {
      const mPills = el.masteryPillsWrap.querySelectorAll('.filter-pill');
      mPills.forEach(pill => {
        pill.addEventListener('click', () => {
          state.masteryFilter = pill.dataset.mastery || 'all';
          mPills.forEach(p => p.classList.toggle('active', p === pill));
          renderSidebarList();

          const matchingList = getCurrentItemsList();
          if (matchingList.length > 0) {
            const currentStillMatches = matchingList.some(it => it.id === state.activeItemId);
            if (!currentStillMatches) {
              selectItem(matchingList[0].id, false);
            }
          }
        });
      });
    }

    if (el.btnStudyDashboard) {
      el.btnStudyDashboard.addEventListener('click', openStudyDashboard);
    }
    if (el.studyDashboardClose) {
      el.studyDashboardClose.addEventListener('click', closeStudyDashboard);
    }
    if (el.studyDashboardBackdrop) {
      el.studyDashboardBackdrop.addEventListener('click', closeStudyDashboard);
    }
    if (el.btnDashPunchToday) {
      el.btnDashPunchToday.addEventListener('click', () => {
        recordStudyPunch();
        showToast('今日研学打卡成功！日拱一卒，功不唐捐！', 2500);
      });
    }
    if (el.btnDashRandomPick) {
      el.btnDashRandomPick.addEventListener('click', () => {
        randomPickUnmasteredT0T1();
      });
    }

    setupMediaSessionHandlers();

    if (el.subject807Btn) {
      el.subject807Btn.addEventListener('click', () => switchSubject('807'));
    }

    if (el.subject706Btn) {
      el.subject706Btn.addEventListener('click', () => switchSubject('706'));
    }

    if (el.subjectEnBtn) {
      el.subjectEnBtn.addEventListener('click', () => switchSubject('en'));
    }

    if (el.subjectPolBtn) {
      el.subjectPolBtn.addEventListener('click', () => switchSubject('pol'));
    }

    // 政治子模块切换事件（主舞台与侧边栏全域双向同步）
    document.querySelectorAll('.pol-submode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.polSubmode;
        if (mode && mode !== state.polSubMode) {
          state.polSubMode = mode;
          localStorage.setItem('kaoyan_pol_submode', mode);
          document.querySelectorAll('.pol-submode-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.polSubmode === mode);
          });
          const showCats = mode === 'recite47' ? 'flex' : 'none';
          if (el.polCategoryPills) el.polCategoryPills.style.display = showCats;
          if (el.stagePolCategoryPills) el.stagePolCategoryPills.style.display = showCats;
          renderSidebarList();
          const list = getCurrentItemsList();
          if (list.length > 0) selectItem(list[0].id, false);
        }
      });
    });

    // 政治五大分类胶囊事件（主舞台与侧边栏全域双向同步）
    document.querySelectorAll('[data-pol-cat]').forEach(btn => {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.polCat;
        if (cat) {
          state.polCategory = cat;
          localStorage.setItem('kaoyan_pol_cat', cat);
          document.querySelectorAll('[data-pol-cat]').forEach(b => {
            b.classList.toggle('active', b.dataset.polCat === cat);
          });
          renderSidebarList();
          const list = getCurrentItemsList();
          if (list.length > 0) selectItem(list[0].id, false);
        }
      });
    });

    if (el.searchInput) {
      let searchDebounceTimer = null;
      const clearSearchBtn = document.getElementById('btn-clear-search');
      const applySearchFilter = (qVal) => {
        state.searchQuery = qVal;
        renderSidebarList();
        const matchingList = getCurrentItemsList();
        if (matchingList.length > 0) {
          const currentStillMatches = matchingList.some(it => it.id === state.activeItemId);
          if (!currentStillMatches) {
            selectItem(matchingList[0].id, false);
          }
        }
      };
      el.searchInput.addEventListener('input', (e) => {
        const val = e.target.value;
        if (clearSearchBtn) clearSearchBtn.style.display = val.length > 0 ? 'inline-flex' : 'none';
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => applySearchFilter(val.trim()), 180);
      });
      if (clearSearchBtn) {
        clearSearchBtn.addEventListener('click', () => {
          if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
          el.searchInput.value = '';
          clearSearchBtn.style.display = 'none';
          applySearchFilter('');
          el.searchInput.focus();
        });
      }
    }

    if (el.tabTrack1) {
      el.tabTrack1.addEventListener('click', () => {
        if (state.currentTrack === 1) return;
        loadTrackData(1, state.isPlaying);
      });
    }

    if (el.tabTrack2) {
      el.tabTrack2.addEventListener('click', () => {
        if (state.currentTrack === 2) return;
        loadTrackData(2, state.isPlaying);
      });
    }

    if (el.playBtn) {
      el.playBtn.addEventListener('click', () => {
        toggleAudioPlayback();
      });
    }

    if (el.prevBtn) {
      el.prevBtn.addEventListener('click', () => playPrevItem());
    }

    if (el.nextBtn) {
      el.nextBtn.addEventListener('click', () => playNextItem());
    }

    if (el.rewindBtn) {
      el.rewindBtn.addEventListener('click', () => {
        const nextT = Math.max(0, (audio.currentTime || 0) - 5);
        audio.currentTime = nextT;
        syncManualSeekPointers(nextT);
      });
    }

    if (el.forwardBtn) {
      el.forwardBtn.addEventListener('click', () => {
        const dur = audio.duration;
        const nextT = (dur && isFinite(dur)) ? Math.min(dur, (audio.currentTime || 0) + 5) : ((audio.currentTime || 0) + 5);
        audio.currentTime = nextT;
        syncManualSeekPointers(nextT);
      });
    }

    // 进度条拖拽与点击
    if (el.progressBar) {
      let isDragging = false;
      const handleSeek = (e) => {
        const rect = el.progressBar.getBoundingClientRect();
        if (!rect.width) return;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        if (audio.duration && isFinite(audio.duration)) {
          const nextT = pos * audio.duration;
          audio.currentTime = nextT;
          if (el.progressFill) {
            el.progressFill.style.width = (pos * 100) + '%';
          }
          if (el.timeCurrent) {
            el.timeCurrent.textContent = formatTime(nextT);
          }
          syncManualSeekPointers(nextT);
        }
      };

      el.progressBar.addEventListener('click', handleSeek);

      el.progressBar.addEventListener('mousedown', (e) => {
        isDragging = true;
        handleSeek(e);
      });
      window.addEventListener('mousemove', (e) => {
        if (isDragging) {
          e.preventDefault();
          handleSeek(e);
        }
      });
      window.addEventListener('mouseup', () => {
        if (isDragging) isDragging = false;
      });

      el.progressBar.addEventListener('touchstart', (e) => {
        isDragging = true;
        handleSeek(e);
      }, { passive: true });
      window.addEventListener('touchmove', (e) => {
        if (isDragging) {
          handleSeek(e);
        }
      }, { passive: true });
      window.addEventListener('touchend', () => {
        if (isDragging) isDragging = false;
      });
    }

    // 8档倍速选项：0.8、0.9、1.0、1.1、1.2、1.4、1.5、2.0
    const SPEED_OPTIONS = [0.8, 0.9, 1.0, 1.1, 1.2, 1.4, 1.5, 2.0];

    function openSpeedModal() {
      const modal = document.getElementById('speedModal');
      const backdrop = document.getElementById('speedModalBackdrop');
      if (!modal || !backdrop) return;
      if (speedModalCloseTimer) {
        clearTimeout(speedModalCloseTimer);
        speedModalCloseTimer = null;
      }

      const grid = document.getElementById('speedModalGrid');
      if (grid) {
        grid.innerHTML = SPEED_OPTIONS.map(spd => {
          const isActive = Math.abs(state.speed - spd) < 0.01;
          const isNormal = Math.abs(spd - 1.0) < 0.01;
          return `<button type="button" class="speed-option-btn ${isActive ? 'active' : ''}" data-speed="${spd}">
            <span class="speed-opt-val">${spd.toFixed(1)}x</span>
            ${isNormal ? '<span class="speed-opt-tag">原速</span>' : ''}
          </button>`;
        }).join('');

        grid.querySelectorAll('.speed-option-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const spd = parseFloat(btn.dataset.speed);
            if (!isNaN(spd)) {
              state.speed = spd;
              audio.playbackRate = state.speed;
              localStorage.setItem('kaoyan_speed', String(state.speed));
              if (el.speedBtn && el.speedBtn.querySelector('span')) {
                el.speedBtn.querySelector('span').textContent = `${state.speed.toFixed(1)}x`;
              }
              closeSpeedModal();
              showToast(`切换语速为 ${spd.toFixed(1)}x`, 1200);
            }
          });
        });
      }

      setPlayerDockReceded(true);
      lockBodyScroll('speedModal');
      backdrop.style.display = 'block';
      modal.style.display = 'block';
      requestAnimationFrame(() => {
        backdrop.classList.add('open');
        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');
      });
    }

    function closeSpeedModal() {
      const modal = document.getElementById('speedModal');
      const backdrop = document.getElementById('speedModalBackdrop');
      if (!modal || !backdrop) return;
      if (speedModalCloseTimer) clearTimeout(speedModalCloseTimer);

      backdrop.classList.remove('open');
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      unlockBodyScroll('speedModal');
      setPlayerDockReceded(false);
      speedModalCloseTimer = setTimeout(() => {
        if (!modal.classList.contains('open')) {
          backdrop.style.display = 'none';
          modal.style.display = 'none';
        }
        speedModalCloseTimer = null;
      }, 240);
    }
    window.__closeSpeedModal = closeSpeedModal;

    // 倍速按钮点击：唤起精美倍速直选弹窗
    if (el.speedBtn) {
      el.speedBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSpeedModal();
      });
    }

    const speedCloseBtn = document.getElementById('speedModalClose');
    if (speedCloseBtn) {
      speedCloseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSpeedModal();
      });
    }
    const speedBackdropEl = document.getElementById('speedModalBackdrop');
    if (speedBackdropEl) {
      speedBackdropEl.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSpeedModal();
      });
    }


    // 背诵遮罩自测模式 (正常研读 / 采分词挖空 / 看纲默背) 全端同步
    if (el.clozeModeBtn) {
      el.clozeModeBtn.addEventListener('click', () => {
        const nextMode = state.clozeMode === 'off' ? 'keyword' : (state.clozeMode === 'keyword' ? 'body' : 'off');
        applyClozeModeState(nextMode, true);
      });
    }

    // 听读背诵循环模式选择抽屉
    if (el.loopModeBtn) {
      el.loopModeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPlayModeDrawer();
      });
    }

    // 主题切换（顶栏与设置抽屉双向同步）
    if (el.themeToggleBtn) {
      el.themeToggleBtn.addEventListener('click', () => {
        const nextTheme = state.theme === 'parchment' ? 'dark' : 'parchment';
        applyThemeState(nextTheme);
      });
    }

    // 字号调节（顶栏与设置抽屉共享基准状态）
    if (el.fontDecBtn) {
      el.fontDecBtn.addEventListener('click', () => {
        applyFontSizeState(state.fontSize - 1);
      });
    }

    if (el.fontIncBtn) {
      el.fontIncBtn.addEventListener('click', () => {
        applyFontSizeState(state.fontSize + 1);
      });
    }

    // 字体切换（使用全局统一的 fontFamilies，同步顶栏与设置抽屉）
    const fontSwitchBtn = document.getElementById('btn-font-switch');
    const savedFont = localStorage.getItem('kaoyan_font_family');
    const initialFont = fontFamilies.find(f => f.id === savedFont || (savedFont === 'hei' && f.id === 'sans')) || fontFamilies[0];
    applyFontGlobal(initialFont);

    if (fontSwitchBtn) {
      fontSwitchBtn.addEventListener('click', () => {
        const curId = document.documentElement.getAttribute('data-font') || 'song';
        const curIdx = fontFamilies.findIndex(f => f.id === curId);
        const nextFont = fontFamilies[(Math.max(0, curIdx) + 1) % fontFamilies.length];
        applyFontGlobal(nextFont);
        localStorage.setItem('kaoyan_font_family', nextFont.id);
        if (typeof window.__syncSettingsUI === 'function') window.__syncSettingsUI();
      });
    }

    // 侧边栏折叠 (iPad & 桌面) 与移动端抽屉
    const appBody = document.querySelector('.app-body');
    const sidebarCollapseBtn = document.getElementById('btn-sidebar-collapse');

    // 恢复本地存储的侧边栏折叠状态 (大屏/iPad)
    if (!isSidebarDrawerMode() && localStorage.getItem('kaoyan_sidebar_collapsed') === '1') {
      if (appBody) appBody.classList.add('sidebar-collapsed');
    }

    if (el.mobileMenuBtn && el.sidebar) {
      el.mobileMenuBtn.addEventListener('click', () => {
        if (isSidebarDrawerMode()) {
          toggleSidebar();
        } else {
          if (appBody) {
            const isCollapsed = appBody.classList.toggle('sidebar-collapsed');
            localStorage.setItem('kaoyan_sidebar_collapsed', isCollapsed ? '1' : '0');
          }
        }
      });
    }

    if (sidebarCollapseBtn) {
      sidebarCollapseBtn.addEventListener('click', () => {
        if (isSidebarDrawerMode()) {
          closeSidebar();
        } else {
          if (appBody) {
            appBody.classList.add('sidebar-collapsed');
            localStorage.setItem('kaoyan_sidebar_collapsed', '1');
          }
        }
      });
    }

    if (el.backdrop && el.sidebar) {
      el.backdrop.addEventListener('click', () => {
        closeSidebar();
      });
    }

    // 监听正文区域及全局主舞台用户手动滚动/滑动/触控，防打架 (Bug Fix 4)
    isProgrammaticScrolling = false;
    const markUserScroll = (e) => {
      if (isBodyScrollLocked() || isProgrammaticScrolling) return;
      state.lastUserScrollTime = Date.now();
    };

    const mainStageEl = document.querySelector('.main-stage');
    // 仅用户真实触控或滚轮手势才抑制自动聚焦，程序化 smooth scroll 绝不自锁！
    if (mainStageEl) {
      mainStageEl.addEventListener('wheel', markUserScroll, { passive: true });
      mainStageEl.addEventListener('touchstart', markUserScroll, { passive: true });
      mainStageEl.addEventListener('touchmove', markUserScroll, { passive: true });
    }
    window.addEventListener('wheel', markUserScroll, { passive: true });
    window.addEventListener('touchstart', markUserScroll, { passive: true });
    window.addEventListener('touchmove', markUserScroll, { passive: true });
    if (el.paperContent) {
      el.paperContent.addEventListener('wheel', markUserScroll, { passive: true });
      el.paperContent.addEventListener('touchstart', markUserScroll, { passive: true });
      el.paperContent.addEventListener('touchmove', markUserScroll, { passive: true });
    }


    // 浮动圆形播放驻留键与收起按钮
    const fabPlayBtn = document.getElementById('dock-fab-play');
    if (fabPlayBtn) {
      fabPlayBtn.addEventListener('click', () => {
        toggleAudioPlayback();
      });
    }


    // 播放坞下滑手势与全宽收起控制 (随时轻松收起)
    const playerDockEl = document.getElementById('playerDock') || document.querySelector('.player-dock');
    if (playerDockEl) {
      let touchStartY = 0;
      let touchStartX = 0;
      playerDockEl.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches.length === 1) {
          touchStartY = e.touches[0].clientY;
          touchStartX = e.touches[0].clientX;
        }
      }, { passive: true });

      playerDockEl.addEventListener('touchend', (e) => {
        if (e.changedTouches && e.changedTouches.length === 1) {
          const deltaY = e.changedTouches[0].clientY - touchStartY;
          const deltaX = Math.abs(e.changedTouches[0].clientX - touchStartX);
          if (deltaY > 32 && deltaY > deltaX) {
            collapsePlayerDock();
          }
        }
      }, { passive: true });
    }

    const dragHandle = document.getElementById('dockDragHandle');
    if (dragHandle) {
      dragHandle.addEventListener('click', () => {
        collapsePlayerDock();
      });
    }

    const collapseDockBtn = document.getElementById('btnCollapseDock');
    if (collapseDockBtn) {
      collapseDockBtn.addEventListener('click', () => {
        collapsePlayerDock();
      });
    }

    // 默认未播放时收起播放坞，仅驻留精致圆形播放键
    collapsePlayerDock();

    // 恢复本地存储配置并全端同步 UI
    const savedTheme = localStorage.getItem('kaoyan_theme');
    applyThemeState(savedTheme === 'dark' ? 'dark' : 'parchment');

    const savedFontSize = parseInt(localStorage.getItem('kaoyan_font_size') || '', 10);
    if (!isNaN(savedFontSize)) {
      applyFontSizeState(savedFontSize);
    } else {
      applyFontSizeState(state.fontSize || 17);
    }

    const savedPlayMode = localStorage.getItem('kaoyan_play_mode');
    if (savedPlayMode && PLAY_MODES.some(m => m.id === savedPlayMode)) {
      state.playMode = savedPlayMode;
    }
    updatePlayModeUI(false);

    const savedSpeed = parseFloat(localStorage.getItem('kaoyan_speed'));
    if (!isNaN(savedSpeed) && SPEED_OPTIONS.includes(savedSpeed)) {
      state.speed = savedSpeed;
      audio.playbackRate = state.speed;
      if (el.speedBtn && el.speedBtn.querySelector('span')) {
        el.speedBtn.querySelector('span').textContent = `${state.speed.toFixed(1)}x`;
      }
    }
  }



  // ==========================================
  // 方案 C：播放控制坞与底部 5-Tab 导航栏互斥吸附替换机制 (v1.9.6)
  // ==========================================
  state.dockExpanded = true;

  function isDesktopDockPermanent() {
    const nav = document.getElementById('app-bottom-nav');
    return !nav || window.getComputedStyle(nav).display === 'none';
  }

  function applyThemeState(themeName) {
    const safeTheme = themeName === 'dark' ? 'dark' : 'parchment';
    state.theme = safeTheme;
    document.documentElement.setAttribute('data-theme', safeTheme);
    localStorage.setItem('kaoyan_theme', safeTheme);
    if (el.themeToggleBtn) {
      const textEl = el.themeToggleBtn.querySelector('.theme-text');
      const svgEl = el.themeToggleBtn.querySelector('svg');
      if (textEl) textEl.textContent = safeTheme === 'dark' ? '夜读' : '纸境';
      if (svgEl) {
        svgEl.innerHTML = safeTheme === 'dark'
          ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>'
          : '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
      }
    }
    if (typeof window.__syncSettingsUI === 'function') window.__syncSettingsUI();
  }

  function applyFontSizeState(nextSize) {
    const clamped = Math.max(14, Math.min(24, parseInt(nextSize, 10) || 17));
    state.fontSize = clamped;
    document.documentElement.style.setProperty('--font-base', `${clamped}px`);
    localStorage.setItem('kaoyan_font_size', String(clamped));
    if (typeof window.__syncSettingsUI === 'function') window.__syncSettingsUI();
  }

  function applyClozeModeState(mode, showToastNotice = false) {
    const safeMode = (mode === 'keyword' || mode === 'body') ? mode : 'off';
    state.clozeMode = safeMode;
    if (el.clozeModeBtn) el.clozeModeBtn.classList.toggle('active', safeMode !== 'off');
    if (el.clozeModeName) {
      el.clozeModeName.textContent = safeMode === 'off' ? '自测' : (safeMode === 'keyword' ? '挖空' : '默背');
    }
    const tabTest = document.getElementById('nav-tab-test');
    const tabTestLabel = document.getElementById('label-tab-test');
    if (tabTest) tabTest.classList.toggle('active', safeMode !== 'off');
    if (tabTestLabel) {
      tabTestLabel.textContent = safeMode === 'off' ? '自测' : (safeMode === 'keyword' ? '挖空' : '默背');
    }
    applyClozeClassToPaper();
    if (showToastNotice) {
      if (safeMode === 'keyword') {
        showToast('已开启【采分词挖空自测】· 核心术语已遮罩，播到或点击即显', 2500);
      } else if (safeMode === 'body') {
        showToast('已开启【看纲默背自测】· 仅留骨架，点击或播到该句自动显现', 2500);
      } else {
        showToast('已切换为【正常研读模式】· 全文清晰呈现', 2000);
      }
    }
  }

  function expandPlayerDock() {
    state.dockExpanded = true;
    document.body.classList.add('dock-expanded');
    const dock = document.querySelector('.player-dock');
    if (dock) dock.classList.remove('dock-collapsed');
    setBottomNavActiveTab('');
  }

  function collapsePlayerDock() {
    if (isDesktopDockPermanent()) {
      state.dockExpanded = true;
      const dock = document.querySelector('.player-dock');
      if (dock) dock.classList.remove('dock-collapsed');
      return;
    }
    state.dockExpanded = false;
    document.body.classList.remove('dock-expanded');
    const dock = document.querySelector('.player-dock');
    if (dock) dock.classList.add('dock-collapsed');
  }

  // 抽屉展开时，播放坞与底栏全部自动平滑滑出退下
  function setPlayerDockReceded(receded) {
    const dock = document.querySelector('.player-dock');
    const nav = document.getElementById('app-bottom-nav');
    if (receded) {
      if (dock) dock.classList.add('dock-receded');
      if (nav) nav.classList.add('dock-receded');
    } else {
      const hasOpenDrawer = hasAnyOpenDrawer();
      if (!hasOpenDrawer) {
        if (dock) dock.classList.remove('dock-receded');
        if (nav) nav.classList.remove('dock-receded');
      }
    }
  }

  const fontFamilies = [
    { id: 'song', name: '雅宋', value: '"Songti SC", "STSongti-SC-Regular", "Noto Serif SC", "Source Han Serif SC", SimSun, serif' },
    { id: 'kai', name: '温楷', value: '"Kaiti SC", "STKaiti", "LXGW WenKai Screen", "LXGWWenKaiScreen", KaiTi, serif' },
    { id: 'sans', name: '精黑', value: '-apple-system, BlinkMacSystemFont, "PingFang SC", "SF Pro Text", "Hiragino Sans GB", "Microsoft YaHei", sans-serif' },
    { id: 'fangsong', name: '仿宋', value: '"STFangsong", "FangSong", "FangSong SC", "仿宋", "STSongti-SC-Regular", serif' }
  ];

  function applyFontGlobal(fontObj) {
    if (!fontObj) return;
    document.documentElement.setAttribute('data-font', fontObj.id);
    document.documentElement.style.setProperty('--font-current', fontObj.value);
    document.documentElement.style.setProperty('--font-content', fontObj.value);
    const fontNameLabel = document.getElementById('font-current-name');
    if (fontNameLabel) fontNameLabel.textContent = fontObj.name;
  }

  function setBottomNavActiveTab(activeName) {
    const tabs = {
      syllabus: document.getElementById('nav-tab-syllabus'),
      dashboard: document.getElementById('nav-tab-dashboard'),
      settings: document.getElementById('nav-tab-settings')
    };
    Object.keys(tabs).forEach(name => {
      const btn = tabs[name];
      if (btn) btn.classList.toggle('active', name === activeName);
    });
    const testTab = document.getElementById('nav-tab-test');
    if (testTab) {
      testTab.classList.toggle('active', state.clozeMode !== 'off');
    }
  }

  function setupKubaiNavigation() {
    // 设置中心抽屉元素
    const settingsDrawer = document.getElementById('settingsDrawer');
    const settingsBackdrop = document.getElementById('settingsModalBackdrop');
    const settingsClose = document.getElementById('settingsClose');

    function openSettings() {
      if (!settingsDrawer) return;
      settingsDrawer.classList.add('open');
      setPlayerDockReceded(true);
      if (settingsBackdrop) {
        settingsBackdrop.style.display = 'block';
        setTimeout(() => settingsBackdrop.classList.add('open'), 10);
      }
      updateSettingsSheetUI();
      setBottomNavActiveTab('settings');
      lockBodyScroll('settingsDrawer');
    }

    function closeSettings() {
      if (!settingsDrawer) return;
      settingsDrawer.classList.remove('open');
      if (settingsBackdrop) {
        settingsBackdrop.classList.remove('open');
        setTimeout(() => {
          if (!settingsDrawer.classList.contains('open')) settingsBackdrop.style.display = 'none';
        }, 280);
      }
      setPlayerDockReceded(false);
      setBottomNavActiveTab('');
      unlockBodyScroll('settingsDrawer');
    }

    function updateSettingsSheetUI() {
      const themeP = document.getElementById('sheetThemeParchment');
      const themeD = document.getElementById('sheetThemeDark');
      if (themeP && themeD) {
        themeP.classList.toggle('active', state.theme === 'parchment');
        themeD.classList.toggle('active', state.theme === 'dark');
      }
      const curFontId = document.documentElement.getAttribute('data-font') || 'song';
      document.querySelectorAll('.font-card-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.fontId === curFontId);
      });
      const sizeValLabel = document.getElementById('sheetFontSizeVal');
      if (sizeValLabel) {
        const percent = Math.round((state.fontSize / 17) * 100);
        sizeValLabel.textContent = `${percent}% (字号 ${state.fontSize}px)`;
      }
      const syncValLabel = document.getElementById('sheetSyncVal');
      if (syncValLabel) {
        const curOff = (typeof state.syncOffset === 'number') ? state.syncOffset : 0.15;
        if (Math.abs(curOff) < 0.01) {
          syncValLabel.textContent = '原速直读 (0.00s · 原生声学)';
        } else if (Math.abs(curOff - 0.15) < 0.02 || Math.abs(curOff - 0.18) < 0.02) {
          syncValLabel.textContent = `极速前瞻 (+${curOff.toFixed(2)}s · 灵敏跟随)`;
        } else if (curOff > 0) {
          syncValLabel.textContent = `灵敏前置 (+${curOff.toFixed(2)}s)`;
        } else {
          syncValLabel.textContent = `舒缓微调 (${curOff.toFixed(2)}s)`;
        }
      }
      document.querySelectorAll('.sync-card-btn').forEach(b => {
        const val = parseFloat(b.dataset.offset);
        const curOff = (typeof state.syncOffset === 'number') ? state.syncOffset : 0.15;
        b.classList.toggle('active', Math.abs(val - curOff) < 0.015);
      });
    }
    window.__syncSettingsUI = updateSettingsSheetUI;
    updateSettingsSheetUI();

    if (settingsClose) settingsClose.addEventListener('click', closeSettings);
    if (settingsBackdrop) settingsBackdrop.addEventListener('click', closeSettings);

    // 主题切换卡片
    const themeP = document.getElementById('sheetThemeParchment');
    const themeD = document.getElementById('sheetThemeDark');
    if (themeP) {
      themeP.addEventListener('click', () => applyThemeState('parchment'));
    }
    if (themeD) {
      themeD.addEventListener('click', () => applyThemeState('dark'));
    }

    // 字体切换卡片
    document.querySelectorAll('.font-card-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.fontId;
        const fontObj = fontFamilies.find(f => f.id === targetId);
        if (fontObj) {
          applyFontGlobal(fontObj);
          localStorage.setItem('kaoyan_font_family', fontObj.id);
          updateSettingsSheetUI();
        }
      });
    });

    // 跟读聚光同频校准调节
    document.querySelectorAll('.sync-card-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const offset = parseFloat(btn.dataset.offset);
        if (!isNaN(offset)) {
          state.syncOffset = offset;
          localStorage.setItem('kaoyan_sync_offset', String(offset));
          updateSettingsSheetUI();
          showToast(`跟读聚光同频已校准为 ${offset > 0 ? '+' : ''}${offset.toFixed(2)}s`);
        }
      });
    });

    // 字号调节
    const decBtn = document.getElementById('sheetFontDec');
    const incBtn = document.getElementById('sheetFontInc');
    const resetBtn = document.getElementById('sheetFontReset');

    if (decBtn) decBtn.addEventListener('click', () => applyFontSizeState(state.fontSize - 1));
    if (incBtn) incBtn.addEventListener('click', () => applyFontSizeState(state.fontSize + 1));
    if (resetBtn) resetBtn.addEventListener('click', () => applyFontSizeState(17));

    // 1. 题库 Tab (考题目录抽屉)
    const tabSyllabus = document.getElementById('nav-tab-syllabus');
    if (tabSyllabus) {
      tabSyllabus.addEventListener('click', () => {
        if (settingsDrawer && settingsDrawer.classList.contains('open')) closeSettings();
        if (el.studyDashboardDrawer && el.studyDashboardDrawer.classList.contains('open')) closeStudyDashboard();

        if (isSidebarDrawerMode()) {
          toggleSidebar();
        } else {
          const appBody = document.querySelector('.app-body');
          if (appBody) {
            const isCollapsed = appBody.classList.toggle('sidebar-collapsed');
            localStorage.setItem('kaoyan_sidebar_collapsed', isCollapsed ? '1' : '0');
            setBottomNavActiveTab(isCollapsed ? '' : 'syllabus');
          }
        }
      });
    }

    // 2. 自测 Tab (循环切换 正常 -> 挖空 -> 默背，与顶栏完全同频)
    const tabTest = document.getElementById('nav-tab-test');
    if (tabTest) {
      tabTest.addEventListener('click', () => {
        const nextMode = state.clozeMode === 'off' ? 'keyword' : (state.clozeMode === 'keyword' ? 'body' : 'off');
        applyClozeModeState(nextMode, true);
      });
    }

    // 桌面快捷键与全局 Esc 关闭弹窗
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const speedModal = document.getElementById('speedModal');
        if (speedModal && speedModal.classList.contains('open') && typeof window.__closeSpeedModal === 'function') {
          window.__closeSpeedModal();
          return;
        }
        if (el.playModeDrawer && el.playModeDrawer.classList.contains('open')) {
          closePlayModeDrawer();
          return;
        }
        if (el.outlineDrawer && el.outlineDrawer.classList.contains('open')) {
          closeOutlineDrawer();
          return;
        }
        if (settingsDrawer && settingsDrawer.classList.contains('open')) {
          closeSettings();
          return;
        }
        if (el.studyDashboardDrawer && el.studyDashboardDrawer.classList.contains('open')) {
          closeStudyDashboard();
          return;
        }
        return;
      }
      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      const isTyping = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT' || (document.activeElement && document.activeElement.isContentEditable);
      if (isTyping || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        toggleAudioPlayback();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const nextT = Math.max(0, (audio.currentTime || 0) - 5);
        audio.currentTime = nextT;
        syncManualSeekPointers(nextT);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const dur = audio.duration;
        const nextT = (dur && isFinite(dur)) ? Math.min(dur, (audio.currentTime || 0) + 5) : ((audio.currentTime || 0) + 5);
        audio.currentTime = nextT;
        syncManualSeekPointers(nextT);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        playPrevItem();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        playNextItem();
      }
    });

    // 3. 【方案 C 核心中枢】底栏正中播放主按键
    const centerPlayBtn = document.getElementById('nav-tab-center-play');
    if (centerPlayBtn) {
      centerPlayBtn.addEventListener('click', () => {
        toggleAudioPlayback();
      });
    }

    // 4. 播放坞收起键 (滑下播放坞，无缝恢复 5-Tab 底栏)

    // 5. 看板 Tab (研学进度看板)
    const tabDashboard = document.getElementById('nav-tab-dashboard');
    if (tabDashboard) {
      tabDashboard.addEventListener('click', () => {
        if (settingsDrawer && settingsDrawer.classList.contains('open')) closeSettings();
        if (el.sidebar && el.sidebar.classList.contains('open')) {
          closeSidebar();
        }
        if (el.studyDashboardDrawer) {
          if (el.studyDashboardDrawer.classList.contains('open')) {
            closeStudyDashboard();
            setBottomNavActiveTab('');
          } else {
            openStudyDashboard();
            setBottomNavActiveTab('dashboard');
          }
        }
      });
    }

    // 6. 设置 Tab (打开功能与设置中心)
    const tabSettings = document.getElementById('nav-tab-settings');
    if (tabSettings) {
      tabSettings.addEventListener('click', () => {
        if (el.sidebar && el.sidebar.classList.contains('open')) {
          closeSidebar();
        }
        if (el.studyDashboardDrawer && el.studyDashboardDrawer.classList.contains('open')) closeStudyDashboard();

        if (settingsDrawer && settingsDrawer.classList.contains('open')) {
          closeSettings();
        } else {
          openSettings();
        }
      });
    }

    // 默认收起播放坞，呈现 5-Tab 底栏
    collapsePlayerDock();
  }

  // ==========================================
  // PWA 自动热更新与版本检视服务
  // ==========================================
  const APP_BUILD_ID = '3.2.6';
  let latestUpdatePayload = null;

  function showToast(msg, duration = 2500) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.querySelector('.toast-container');
    }
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    // 清理任何残留的历史游离 toastPrompt 节点
    const oldPrompt = document.getElementById('toastPrompt');
    if (oldPrompt) oldPrompt.remove();

    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.textContent = msg;
    const fadeOutDelay = Math.max(0.1, (duration - 300) / 1000);
    toast.style.animation = `toastFadeIn 0.25s ease, toastFadeOut 0.25s ease ${fadeOutDelay}s forwards`;

    container.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) {
        toast.remove();
      }
    }, duration);
  }

  function compareVersions(v1, v2) {
    const p1 = (v1 || '').replace(/^v/, '').split('.').map(Number);
    const p2 = (v2 || '').replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const num1 = p1[i] || 0;
      const num2 = p2[i] || 0;
      if (num1 > num2) return 1;
      if (num1 < num2) return -1;
    }
    return 0;
  }

    // 全流程可视化更新引擎 (Visual Progress Flow)
  let isUpdatingApp = false;

  function triggerSilentSeamlessUpdate(targetVer) {
    window.__manualSwUpdateRequested = true;
    return performVisualUpdateFlow(targetVer);
  }

  async function performVisualUpdateFlow(targetVer) {
    if (isUpdatingApp) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      showToast('当前处于离线状态，已完整保留本地离线题库与音频缓存', 2800);
      return;
    }
    window.__manualSwUpdateRequested = true;
    isUpdatingApp = true;

    const banner = document.getElementById('updateBannerPill');
    if (banner) banner.style.display = 'none';

    const backdrop = document.getElementById('updateModalBackdrop');
    const modal = document.getElementById('updateModal');
    const oldVerEl = document.getElementById('updateModalOldVer');
    const newVerEl = document.getElementById('updateModalNewVer');
    const statusEl = document.getElementById('updateModalStatus');
    const fillEl = document.getElementById('updateProgressFill');
    const stepEl = document.getElementById('updateStepLabel');
    const pctEl = document.getElementById('updatePercentVal');

    if (oldVerEl) oldVerEl.textContent = `v${APP_BUILD_ID}`;
    if (newVerEl) newVerEl.textContent = `v${targetVer || '最新'}`;

    const setStep = (pct, stepText, statusText) => {
      if (fillEl) fillEl.style.width = pct + '%';
      if (pctEl) pctEl.textContent = pct + '%';
      if (stepEl) stepEl.textContent = stepText;
      if (statusEl) statusEl.textContent = statusText;
    };

    let openRafId = 0;
    if (backdrop && modal) {
      backdrop.style.display = 'block';
      modal.style.display = 'block';
      openRafId = requestAnimationFrame(() => {
        backdrop.classList.add('open');
        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');
      });
    }

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    try {
      // 步骤 1: 先验联网可达性，绝不在离线状态下盲清缓存
      setStep(20, '步骤 1/4 · 节点握手', '正在校验云端节点可达性（离线时保留本地缓存）...');
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error('OFFLINE_ABORT');
      }
      const probeRes = await fetch(`version.json?_t=${Date.now()}`, { cache: 'no-store' });
      if (!probeRes.ok) throw new Error('PROBE_FAILED');
      await sleep(260);

      // 步骤 2: 验证在线可达后安全清理历史离线缓存 (50%)
      setStep(50, '步骤 2/4 · 净化缓存', '正在清理过期离线数据并重置 Service Worker...');
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      sessionStorage.clear();
      await sleep(400);

      // 步骤 3: 预载最新核心资产 (85%)
      setStep(85, '步骤 3/4 · 载入新版', '正在全量预加载最新全科背诵数据与核心组件...');
      try {
        await Promise.all([
          fetch(`index.html?_t=${Date.now()}`, { cache: 'no-store' }),
          fetch(`version.json?_t=${Date.now()}`, { cache: 'no-store' }),
          fetch(`app.js?v=${targetVer}&_t=${Date.now()}`, { cache: 'no-store' }),
          fetch(`app.css?v=${targetVer}&_t=${Date.now()}`, { cache: 'no-store' })
        ]);
      } catch (e) {
        console.warn('Preload partial error:', e);
      }
      await sleep(350);

      // 步骤 4: 完成并重载 (100%)
      setStep(100, '步骤 4/4 · 同步就绪', '同步完成！背诵手卷正在重新启封...');
      await sleep(380);

      if (targetVer) {
        try {
          sessionStorage.setItem('just_updated_v' + targetVer, '1');
        } catch (e) {}
      }

      const cleanUrl = window.location.origin + window.location.pathname + '?v=' + encodeURIComponent(targetVer) + '&t=' + Date.now();
      window.location.replace(cleanUrl);
    } catch (err) {
      console.warn('Update flow aborted safely:', err);
      if (openRafId) cancelAnimationFrame(openRafId);
      if (backdrop && modal) {
        backdrop.classList.remove('open');
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
        backdrop.style.display = 'none';
        modal.style.display = 'none';
      }
      isUpdatingApp = false;
      window.__manualSwUpdateRequested = false;
      showToast('当前处于离线或节点不可达状态，已完整保留本地离线题库与音频缓存', 2800);
    }
  }

  async function checkAppUpdate(isManual = false) {
    const badge = document.getElementById('appVersionBadge');
    const versionText = document.getElementById('versionText');
    const banner = document.getElementById('updateBannerPill');
    const bannerText = document.getElementById('updateBannerText');

    if (isManual) {
      showToast('正在检查云端最新版本...', 1500);
      if (versionText) versionText.textContent = '检查中...';
    }

    try {
      const res = await fetch(`version.json?_t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('fetch version.json failed');
      const payload = await res.json();
      latestUpdatePayload = payload;

      const remoteVer = String(payload.version || '');
      const isJustUpdated = sessionStorage.getItem('just_updated_v' + remoteVer) === '1';
      const isDismissed = sessionStorage.getItem('dismiss_update_v' + remoteVer) === '1';
      const isNewer = compareVersions(remoteVer, APP_BUILD_ID) > 0;

      // 如果已是最新版本，或刚完成更新(isJustUpdated 且 remoteVer == targetVer)，严格隐藏横幅并抑制更新提示
      if (remoteVer === APP_BUILD_ID || isJustUpdated || !isNewer) {
        // 当前已是最新版本，彻底消除横幅与红点
        if (banner) banner.style.display = 'none';
        if (badge) badge.classList.remove('has-update');
        if (versionText) {
          versionText.textContent = `已是最新版 v${APP_BUILD_ID} · 162节全科真题`;
        }
        if (isManual) {
          showToast(`当前已是最新版本 v${APP_BUILD_ID}`, 2000);
        }
      } else {
        if (banner && !isDismissed) {
          if (bannerText) bannerText.textContent = `发现新版本 v${remoteVer} · 点击同步更新`;
          banner.style.display = 'flex';
        }
        if (versionText) {
          versionText.textContent = `有新版 v${remoteVer} · 点击同步`;
        }
        if (badge) {
          badge.classList.add('has-update');
        }
        if (isManual) {
          showToast(`发现新版本 v${remoteVer}，准备同步`, 2000);
          performVisualUpdateFlow(remoteVer);
        }
      }
    } catch (err) {
      console.warn('Update check failed:', err);
      if (versionText) versionText.textContent = `手卷版本 v${APP_BUILD_ID}`;
      if (isManual) showToast('网络连接超时，未发现云端新版', 2000);
    }
  }

  function setupVersionHandlers() {
    const badge = document.getElementById('appVersionBadge');
    const refreshBtn = document.getElementById('btn-force-refresh');
    const bannerBody = document.getElementById('updateBannerBody');
    const bannerClose = document.getElementById('updateBannerClose');
    const banner = document.getElementById('updateBannerPill');

    if (badge) {
      badge.addEventListener('click', () => {
        if (badge.classList.contains('has-update')) {
          performVisualUpdateFlow((latestUpdatePayload && latestUpdatePayload.version) || APP_BUILD_ID);
        } else {
          checkAppUpdate(true);
        }
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        performVisualUpdateFlow((latestUpdatePayload && latestUpdatePayload.version) || APP_BUILD_ID);
      });
    }

    if (bannerBody) {
      bannerBody.addEventListener('click', () => {
        performVisualUpdateFlow((latestUpdatePayload && latestUpdatePayload.version) || APP_BUILD_ID);
      });
    }

    if (bannerClose && banner) {
      bannerClose.addEventListener('click', (e) => {
        e.stopPropagation();
        banner.style.display = 'none';
        if (latestUpdatePayload && latestUpdatePayload.version) {
          sessionStorage.setItem('dismiss_update_v' + latestUpdatePayload.version, '1');
        }
      });
    }

    setTimeout(() => {
      checkAppUpdate(false);
    }, 1500);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        checkAppUpdate(false);
      }
    });
  }

  // 初始化入口
  // PWA Service Worker 隔离注册与热重载
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then((reg) => {
        setInterval(() => {
          reg.update().catch(() => {});
        }, 60 * 1000);

        reg.onupdatefound = () => {
          const installingWorker = reg.installing;
          if (installingWorker) {
            installingWorker.onstatechange = () => {
              if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                console.log('[PWA] 发现新版本 Service Worker，等待更新触发');
                if (window.__manualSwUpdateRequested) {
                  window.location.reload();
                }
              }
            };
          }
        };
      }).catch(err => {
        console.warn('SW registration warning:', err);
      });
    });

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (window.__manualSwUpdateRequested && !refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  }

  // ==========================================
  // 触摸手势隔离与遮罩层滚动锁初始化 (Touch Isolation Setup)
  // ==========================================
  function initTouchIsolation() {
    const backdropSelectors = [
      '#sidebar-backdrop',
      '.sidebar-backdrop',
      '#outlineDrawerBackdrop',
      '.outline-drawer-backdrop',
      '#playModeBackdrop',
      '.mode-drawer-backdrop',
      '#studyDashboardBackdrop',
      '.dashboard-drawer-backdrop',
      '#settingsModalBackdrop',
      '.settings-backdrop',
      '#speedModalBackdrop',
      '.speed-modal-backdrop',
      '#updateModalBackdrop',
      '.update-modal-backdrop',
      '.drawer-backdrop'
    ];

    const preventBackdropTouch = (e) => {
      e.preventDefault();
    };

    backdropSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(backdrop => {
        backdrop.addEventListener('touchmove', preventBackdropTouch, { passive: false });
      });
    });

    // 移动端全局手势隔离：当任意抽屉开启且锁定滚动时，阻止背景层或非滚动容器的 touchmove 逃逸到根页面
    document.addEventListener('touchmove', (e) => {
      if (!isBodyScrollLocked()) return;

      // 1. 遮罩层直接阻止滚动
      if (e.target && (
        e.target.matches?.('.sidebar-backdrop, .outline-drawer-backdrop, .mode-drawer-backdrop, .dashboard-drawer-backdrop, .settings-backdrop, .speed-modal-backdrop, .update-modal-backdrop, .drawer-backdrop') ||
        e.target.closest?.('.sidebar-backdrop, .outline-drawer-backdrop, .mode-drawer-backdrop, .dashboard-drawer-backdrop, .settings-backdrop, .speed-modal-backdrop, .update-modal-backdrop, .drawer-backdrop')
      )) {
        e.preventDefault();
        return;
      }

      // 2. 底层主舞台与底栏直接阻止滚动
      if (e.target && e.target.closest?.('.main-stage, #mainStage, .player-dock, .app-bottom-nav')) {
        e.preventDefault();
        return;
      }

      // 3. 检查是否在允许滚动的抽屉容器内
      const scrollable = e.target.closest?.('.item-list-container, #item-list, .outline-drawer-body, .mode-drawer-body, #playModeList, .play-mode-list, .dashboard-drawer-body, #studyDashboardBody, .settings-body, .appearance-drawer, .filter-pills, .pol-submode-bar');
      if (!scrollable) {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
          return;
        }
        e.preventDefault();
      }
    }, { passive: false });

    // 窗口尺寸自适应：若从移动端横屏/小屏放大到桌面大屏，自动解除移动抽屉并同步滚动穿透锁
    const handleViewportChange = () => {
      if (!isSidebarDrawerMode() && el.sidebar && el.sidebar.classList.contains('open')) {
        closeSidebar();
      }
      syncBodyScrollLock();
    };

    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('orientationchange', handleViewportChange);
  }

  function startApp() {
    window.switchSubject = switchSubject;
    window.selectItem = selectItem;
    window.seekToSentence = seekToSentence;
    window.getCurrentItemsList = getCurrentItemsList;
    initElements();
    setupAudioEngine();
    setupEventListeners();
    setupKubaiNavigation();
    loadManifestData();
    setupVersionHandlers();
    initTouchIsolation();
    syncBodyScrollLock();
  }


  // ==========================================
  // 考研政治模块扩展引擎 (PolEngine V3.0)
  // ==========================================


  function ensurePolDataLoaded(options = {}) {
    const silent = !!(options && options.silent);
    if (window.KAOYAN_POL_DATA) {
      state.polData = window.KAOYAN_POL_DATA;
      return Promise.resolve(window.KAOYAN_POL_DATA);
    }
    if (polDataLoadPromise) {
      return polDataLoadPromise;
    }

    isPolDataLoading = true;
    if (!silent) showToast('正在加载考研政治背诵手卷...', 2000);
    polDataLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `data/kaoyan_data_pol.js?v=${APP_BUILD_ID}`;
      script.onload = () => {
        isPolDataLoading = false;
        state.polData = window.KAOYAN_POL_DATA;
        updateBadgeCounts();
        if (el.studyDashboardDrawer && el.studyDashboardDrawer.classList.contains('open')) {
          updateStudyDashboardUI();
        }
        resolve(window.KAOYAN_POL_DATA);
      };
      script.onerror = (err) => {
        isPolDataLoading = false;
        polDataLoadPromise = null;
        if (!silent) showToast('政治题库数据加载失败，请检查文件路径', 3000);
        reject(err);
      };
      document.head.appendChild(script);
    });
    return polDataLoadPromise;
  }

  function getPolItemList() {
    if (!state.polData && window.KAOYAN_POL_DATA) {
      state.polData = window.KAOYAN_POL_DATA;
    }
    if (!state.polData) return [];

    const mode = state.polSubMode || 'recite47';
    if (mode === 'recite47') {
      let list = state.polData.chapters47 || [];
      if (state.polCategory && state.polCategory !== 'all') {
        list = list.filter(ch => ch.category === state.polCategory);
      }
      if (state.masteryFilter !== 'all') {
        list = list.filter(ch => getMasteryStatus(ch.id) === state.masteryFilter);
      }
      if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        list = list.filter(ch => 
          (ch.title && ch.title.toLowerCase().includes(q)) ||
          (ch.chapterNum && ch.chapterNum.toLowerCase().includes(q)) ||
          (ch.categoryName && ch.categoryName.toLowerCase().includes(q)) ||
          (ch.track2 && ch.track2.subCards && ch.track2.subCards.some(sc => sc.chipLabel.toLowerCase().includes(q) || sc.title.toLowerCase().includes(q)))
        );
      }
      return list;
    } else if (mode === 'xutao16') {
      let list = state.polData.xutao16 || [];
      if (state.masteryFilter !== 'all') {
        list = list.filter(xt => getMasteryStatus(xt.id) === state.masteryFilter);
      }
      if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        list = list.filter(xt =>
          (xt.title && xt.title.toLowerCase().includes(q)) ||
          (xt.subtitle && xt.subtitle.toLowerCase().includes(q)) ||
          (xt.points && xt.points.some(p => p.html && p.html.toLowerCase().includes(q)))
        );
      }
      return list;
    } else if (mode === 'tuijie11') {
      let list = state.polData.tuijie11 || [];
      if (state.masteryFilter !== 'all') {
        list = list.filter(tj => getMasteryStatus(tj.id) === state.masteryFilter);
      }
      if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        list = list.filter(tj =>
          (tj.title && tj.title.toLowerCase().includes(q)) ||
          (tj.sections && tj.sections.some(sec => (sec.title && sec.title.toLowerCase().includes(q)) || (sec.points && sec.points.some(p => (p.title || p.text || '').toLowerCase().includes(q)))))
        );
      }
      return list;
    }
    return [];
  }

  function selectPolItem(item, autoPlay = false, restoreTime = false) {
    state.activeItemId = item.id;
    state.activeItem = item;
    state.currentSentIndex = -1;
    state.loopCount = 0;

    localStorage.setItem(`kaoyan_last_item_${state.currentSubject}`, item.id);
    localStorage.setItem('kaoyan_last_item_id', item.id);
    localStorage.setItem('kaoyan_last_subject', 'pol');
    localStorage.setItem('kaoyan_last_track', String(state.currentTrack));

    document.querySelectorAll('.question-card-item').forEach(card => {
      card.classList.toggle('active', card.dataset.id === item.id);
    });

    el.questionTitle.textContent = item.title;
    el.stageSubject.textContent = '考研政治';
    if (state.polSubMode === 'recite47') {
      el.stageTopic.textContent = item.categoryName || '核心背诵笔记';
      el.stageScore.textContent = `${item.chapterNum || ''}`;
      el.stageTier.textContent = item.importance || '必背';
      el.stageTier.className = 'tier-badge tier-T0';
    } else if (state.polSubMode === 'xutao16') {
      el.stageTopic.textContent = '徐涛16天选择题带背';
      el.stageScore.textContent = `Day ${item.day}`;
      el.stageTier.textContent = '题眼';
      el.stageTier.className = 'tier-badge tier-T1';
    } else {
      el.stageTopic.textContent = '腿姐11天冲刺带背';
      el.stageScore.textContent = `Day ${item.day}`;
      el.stageTier.textContent = '冲刺';
      el.stageTier.className = 'tier-badge tier-T0';
    }

    if (el.hudTitleText) {
      el.hudTitleText.textContent = `政治 · ${item.title}`;
    }
    if (el.dockTitle) el.dockTitle.textContent = item.title;

    updateHeaderMasteryUI();
    loadPolTrackData(state.currentTrack, autoPlay, restoreTime);
  }

  function loadPolTrackData(trackNum, autoPlay = false, restoreTime = false) {
    state.currentTrack = trackNum;
    state.currentSentIndex = -1;
    state.loopCount = 0;
    localStorage.setItem('kaoyan_last_track', String(trackNum));

    if (el.tabTrack1) el.tabTrack1.classList.toggle('active', trackNum === 1);
    if (el.tabTrack2) el.tabTrack2.classList.toggle('active', trackNum === 2);

    const mode = state.polSubMode || 'recite47';
    if (mode === 'recite47') {
      if (el.trackTabs) el.trackTabs.style.display = '';
      if (el.tab1TextFull) el.tab1TextFull.textContent = '【轨道一】原书背诵与理解';
      if (el.tab1TextShort) el.tab1TextShort.textContent = '轨道一 · 原书背诵';
      const subCardsCount = (state.activeItem.track2 && state.activeItem.track2.subCards) ? state.activeItem.track2.subCards.length : 0;
      if (el.tab2TextFull) el.tab2TextFull.textContent = `【轨道二】名师微考点伴读 (${subCardsCount}讲)`;
      if (el.tab2TextShort) el.tab2TextShort.textContent = `轨道二 · 微考点 (${subCardsCount}讲)`;
      if (el.trackVoicePill) el.trackVoicePill.textContent = trackNum === 1 ? '整章背诵' : '微考点精析';

      if (trackNum === 1) {
        renderPolChapterTrack1(state.activeItem, autoPlay, restoreTime);
      } else {
        renderPolChapterTrack2(state.activeItem, autoPlay, restoreTime);
      }
    } else if (mode === 'xutao16') {
      if (el.trackTabs) el.trackTabs.style.display = 'none';
      renderPolXutao16(state.activeItem, autoPlay, restoreTime);
    } else if (mode === 'tuijie11') {
      if (el.trackTabs) el.trackTabs.style.display = 'none';
      renderPolTuijie11(state.activeItem, autoPlay, restoreTime);
    }
  }

  function renderPolChapterTrack1(chapter, autoPlay = false, restoreTime = false) {
    if (!el.paperContent) return;
    resetAudioProgressUI();
    el.paperContent.classList.add('pol-scope');
    applyClozeClassToPaper();
    
    const isMastered = getMasteryStatus(chapter.id) === 'mastered';
    const sealHtml = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
        <button type="button" class="seal-btn ${isMastered ? 'sealed' : ''}" id="sealBtn_${chapter.id}" title="点击落印研毕 · 同步打卡掌握">
          <span class="seal-mark">研毕</span>
          <span>${isMastered ? '已落印研毕' : '落印研毕'}</span>
        </button>
      </div>`;

    el.paperContent.innerHTML = `
      ${sealHtml}
      ${chapter.track1 ? (chapter.track1.reciteHtml || '') : ''}
      ${chapter.track1 ? (chapter.track1.understandHtml || '') : ''}
      <div style="margin-top:24px;padding-top:16px;border-top:1px dashed var(--line-subtle, rgba(0,0,0,0.1));">
        ${sealHtml}
      </div>`;

    if (chapter.track1 && chapter.track1.audio) {
      audio.src = chapter.track1.audio;
      audio.load();
      audio.playbackRate = state.speed;
      tryRestoreAudioTime(restoreTime, `pol_${chapter.id}_1`);
      if (autoPlay) {
        audio.play().catch(e => console.log('Autoplay prevented:', e));
      }
    } else {
      clearAudioSource();
    }
    updatePlayBtnUI();

    const sentences = (chapter.track1 && chapter.track1.sentences) || [];
    state.activeSentences = sanitizeSentences(sentences.map((s, idx) => ({
      id: s.idx !== undefined ? s.idx : (s.id || idx),
      start: typeof s.start === 'number' ? s.start : parseFloat(s.start || 0),
      end: typeof s.end === 'number' ? s.end : parseFloat(s.end || 0),
      text: s.text,
      domId: s.domId || s.id,
      idx: s.idx !== undefined ? s.idx : idx
    })));

    normalizePoliticsSentenceDom();
    stampSentenceIndices();
    bindSentenceClickHandlers(el.paperContent);
    bindCardSectionClickHandlers(el.paperContent);

    attachSealButtonListeners(chapter.id);
    buildFrameworkIndex();
    enhanceClozeKeywords();
  }

  function renderPolChapterTrack2(chapter, autoPlay = false, restoreTime = false) {
    if (!el.paperContent) return;
    resetAudioProgressUI();
    el.paperContent.classList.add('pol-scope');
    applyClozeClassToPaper();

    const subCards = (chapter.track2 && chapter.track2.subCards) || [];
    if (subCards.length === 0) {
      el.paperContent.innerHTML = `<div style="padding:40px;text-align:center;color:var(--ink-muted);">本章暂无微考点音频</div>`;
      return;
    }

    let activeCard = subCards.find(c => c.cardId === state.polSubCardId) || subCards[0];
    state.polSubCardId = activeCard.cardId;

    const pillsHtml = `
      <div class="pol-subcard-pills" id="polSubcardPills">
        ${subCards.map(sc => `
          <button type="button" class="playlist-chip-btn ${sc.cardId === activeCard.cardId ? 'active' : ''}" data-card-id="${sc.cardId}" title="${sc.chipLabel}">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
            <span>${sc.chipLabel}</span>
          </button>
        `).join('')}
      </div>`;

    el.paperContent.innerHTML = `
      ${pillsHtml}
      <div id="polSubcardBody" class="pol-subcard-body">
        ${activeCard.lectureHtml || ''}
      </div>`;

    activateSubCardAudio(activeCard, autoPlay, restoreTime);

    const pillBtns = el.paperContent.querySelectorAll('#polSubcardPills .playlist-chip-btn');
    pillBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const cid = btn.dataset.cardId;
        const targetCard = subCards.find(c => c.cardId === cid);
        if (targetCard) {
          state.polSubCardId = cid;
          localStorage.setItem('kaoyan_pol_subcard_id', cid);
          pillBtns.forEach(b => b.classList.toggle('active', b === btn));
          const bodyEl = document.getElementById('polSubcardBody');
          if (bodyEl) {
            bodyEl.innerHTML = targetCard.lectureHtml || '';
            activateSubCardAudio(targetCard, true);
            enhanceClozeKeywords();
          }
        }
      });
    });

    enhanceClozeKeywords();
  }

  function activateSubCardAudio(card, autoPlay = false, restoreTime = false) {
    resetAudioProgressUI();
    if (card.audio) {
      audio.src = card.audio;
      audio.load();
      audio.playbackRate = state.speed;
      if (state.activeItem) {
        tryRestoreAudioTime(restoreTime, `pol_${state.activeItem.id}_2`);
      }
      if (autoPlay) {
        audio.play().catch(e => console.log('Autoplay prevented:', e));
      }
      if (el.dockTitle) el.dockTitle.textContent = `${state.activeItem.title} · ${card.chipLabel}`;
    } else {
      clearAudioSource();
      if (el.dockTitle) el.dockTitle.textContent = `${card.chipLabel} (纯图表速览无伴读)`;
      showToast('本导论考点为纯图表速览，无伴读音频', 2500);
    }
    updatePlayBtnUI();

    const sentences = card.sentences || [];
    state.activeSentences = sanitizeSentences(sentences.map((s, idx) => ({
      id: s.idx !== undefined ? s.idx : idx,
      start: typeof s.start === 'number' ? s.start : parseFloat(s.start || 0),
      end: typeof s.end === 'number' ? s.end : parseFloat(s.end || 0),
      text: s.text,
      idx: s.idx !== undefined ? s.idx : idx
    })));

    stampSentenceIndices();

    const bodyEl = document.getElementById('polSubcardBody');
    if (bodyEl) {
      bodyEl.querySelectorAll('.card-audio-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const firstSent = (state.activeSentences && state.activeSentences.length > 0) ? state.activeSentences[0] : null;
          const firstSentEl = bodyEl.querySelector('.recite-sentence, .recite-sent, [data-sent-idx]');
          const targetIdx = firstSent ? firstSent.idx : 0;
          const targetStart = firstSent ? firstSent.start : (firstSentEl ? parseFloat(firstSentEl.dataset.start) : 0);

          if (state.isPlaying) {
            toggleAudioPlayback();
          } else {
            seekToSentence(targetIdx, targetStart);
            if (audio.paused) {
              audio.play().catch(err => console.log('Subcard audio play failed:', err));
            }
          }
        });
      });
      bindSentenceClickHandlers(bodyEl);
      bindCardSectionClickHandlers(bodyEl);
    }

    buildFrameworkIndex();
  }

  function renderPolXutao16(dayItem, autoPlay = false, restoreTime = false) {
    resetAudioProgressUI();
    if (!el.paperContent) return;
    el.paperContent.classList.add('pol-scope');
    applyClozeClassToPaper();

    state.polXtVoice = state.polXtVoice || 'anlang';

    const isMastered = getMasteryStatus(dayItem.id) === 'mastered';
    const topBarHtml = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--line-subtle, rgba(0,0,0,0.08));">
        <div class="xt-voice-switcher" id="xtVoiceSwitcher">
          <button type="button" class="xt-voice-btn ${state.polXtVoice === 'anlang' ? 'active' : ''}" data-voice="anlang">
            <svg class="pol-btn-svg" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg> 龙安朗 AI 干货版
          </button>
          <button type="button" class="xt-voice-btn ${state.polXtVoice === 'voice' ? 'active' : ''}" data-voice="voice">
            <svg class="pol-btn-svg" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg> 徐涛原声带背版
          </button>
        </div>
        <button type="button" class="seal-btn ${isMastered ? 'sealed' : ''}" id="sealBtn_${dayItem.id}">
          <span class="seal-mark">研毕</span>
          <span>${isMastered ? '已完成带背' : '打卡研毕'}</span>
        </button>
      </div>`;

    const points = dayItem.points || [];
    const pointsHtml = `
      <div class="xt-day-points-grid" id="xtDayPointsGrid">
        ${points.map((p, idx) => `
          <div class="xt-day-point-card" data-point-id="${p.id}" data-point-idx="${idx}">
            <div class="xt-day-point-header">
              <span class="xt-point-num-tag">考点 ${p.num || (idx+1)} · ${p.tag || '核心题眼'}</span>
              <span style="font-size:11px;color:var(--ink-muted);">点击跳播</span>
            </div>
            <div class="xt-point-content">
              ${p.html}
            </div>
          </div>
        `).join('')}
      </div>`;

    el.paperContent.innerHTML = `${topBarHtml}${pointsHtml}`;

    setXutao16Audio(dayItem, state.polXtVoice, autoPlay, -1, restoreTime);

    const voiceBtns = el.paperContent.querySelectorAll('#xtVoiceSwitcher .xt-voice-btn');
    voiceBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.voice;
        if (v !== state.polXtVoice) {
          state.polXtVoice = v;
          localStorage.setItem('kaoyan_pol_xt_voice', v);
          voiceBtns.forEach(b => b.classList.toggle('active', b === btn));
          const currentPointIdx = Math.max(0, state.currentSentIndex);
          setXutao16Audio(dayItem, v, state.isPlaying, currentPointIdx);
          showToast(`已切换至【${v === 'anlang' ? '龙安朗 AI 干货版' : '徐涛原声带背版'}】`, 2000);
        }
      });
    });

    el.paperContent.querySelectorAll('.xt-day-point-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (state.clozeMode === 'keyword' && (e.target.closest('.cloze') || e.target.closest('.kw-red') || e.target.closest('.stream-kw'))) return;
        if (state.clozeMode === 'body') {
          card.classList.toggle('cloze-revealed');
          return;
        }
        const pIdx = parseInt(card.dataset.pointIdx, 10);
        let matched = null;
        if (state.activeSentences && !isNaN(pIdx) && pIdx >= 0 && pIdx < state.activeSentences.length) {
          matched = state.activeSentences[pIdx];
        }
        if (matched && typeof matched.start === 'number' && !isNaN(matched.start)) {
          seekToSentence(matched.idx, matched.start);
        } else {
          const p = points[pIdx];
          if (p) {
            const startTime = state.polXtVoice === 'anlang' ? p.anlang_start : p.voice_start;
            seekToSentence(pIdx, startTime);
          }
        }
      });
    });

    stampSentenceIndices();
    bindCardSectionClickHandlers(el.paperContent);
    attachSealButtonListeners(dayItem.id);
    buildFrameworkIndex();
    enhanceClozeKeywords();
  }

  function setXutao16Audio(dayItem, voiceType, autoPlay = false, startPointIdx = -1, restoreTime = false) {
    const audioSrc = voiceType === 'anlang' ? dayItem.anlang_audio : dayItem.voice_audio;
    if (audioSrc) {
      audio.src = audioSrc;
      audio.load();
      audio.playbackRate = state.speed;
    } else {
      clearAudioSource();
    }

    const points = dayItem.points || [];
    state.activeSentences = sanitizeSentences(points.map(p => ({
      id: p.id,
      start: voiceType === 'anlang' ? p.anlang_start : p.voice_start,
      end: voiceType === 'anlang' ? p.anlang_end : p.voice_end,
      text: p.tag
    })));
    stampSentenceIndices();

    let playedViaSeek = false;
    if (startPointIdx >= 0 && startPointIdx < points.length) {
      const p = points[startPointIdx];
      const t = voiceType === 'anlang' ? p.anlang_start : p.voice_start;
      if (autoPlay) {
        seekToSentence(startPointIdx, t);
        playedViaSeek = true;
      } else {
        const xtEpoch = ++manualSeekEpoch;
        const setTime = () => {
          if (xtEpoch !== manualSeekEpoch) return;
          audio.currentTime = Math.max(0, t);
          highlightSentence(startPointIdx);
        };
        if (audio.readyState >= 1) {
          setTime();
        } else {
          audio.addEventListener('loadedmetadata', setTime, { once: true });
        }
      }
    } else if (restoreTime) {
      tryRestoreAudioTime(true, `pol_${dayItem.id}_${state.currentTrack}`);
    } else if (points.length > 0) {
      // 若用户未指定特定考点且从开头播放，若首考点前有原声前奏导言区，自动就位至第一考点起始点
      const p0 = points[0];
      const t0 = voiceType === 'anlang' ? p0.anlang_start : p0.voice_start;
      if (t0 > 0.5) {
        if (autoPlay) {
          seekToSentence(0, t0);
          playedViaSeek = true;
        } else {
          const xtEpoch = ++manualSeekEpoch;
          const setFirst = () => {
            if (xtEpoch !== manualSeekEpoch || (pendingSeekTarget && Date.now() - pendingSeekTarget.startedAt < 5000)) return;
            if (audio.currentTime < t0 - 0.3) {
              audio.currentTime = t0;
              highlightSentence(0);
            }
          };
          if (audio.readyState >= 1) {
            setFirst();
          } else {
            audio.addEventListener('loadedmetadata', setFirst, { once: true });
          }
        }
      }
    }

    if (autoPlay && !playedViaSeek) {
      audio.play().catch(e => console.log('Autoplay prevented:', e));
    }
    updatePlayBtnUI();
    buildFrameworkIndex();
  }

  function renderPolTuijie11(dayItem, autoPlay = false, restoreTime = false) {
    resetAudioProgressUI();
    if (!el.paperContent) return;
    el.paperContent.classList.add('pol-scope');
    applyClozeClassToPaper();

    const isMastered = getMasteryStatus(dayItem.id) === 'mastered';
    const topBarHtml = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--line-subtle, rgba(0,0,0,0.08));">
        <div>
          <span style="font-weight:700;color:var(--vermilion, #b91c1c);font-size:16px;"><svg class="pol-btn-svg" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg> 腿姐带背 · Day ${dayItem.day} 冲刺讲义</span>
          ${dayItem.subtitle ? `<div style="font-size:12.5px;color:var(--ink-muted);margin-top:2px;">${dayItem.subtitle}</div>` : ''}
        </div>
        <button type="button" class="seal-btn ${isMastered ? 'sealed' : ''}" id="sealBtn_${dayItem.id}">
          <span class="seal-mark">研毕</span>
          <span>${isMastered ? '已完成带背' : '打卡研毕'}</span>
        </button>
      </div>`;

    const sections = dayItem.sections || [];
    let secHtml = '';
    const allSentences = [];

    sections.forEach((sec, sIdx) => {
      const isIntro = sec.type === 'intro';
      const isCallout = sec.type === 'callout';
      const badgeType = isIntro ? 'intro' : (isCallout ? 'callout' : 'point');

      const sents = sec.resolved_sentences || [];
      const sentsHtml = sents.map(s => {
        allSentences.push({ id: `tj_s_${s.idx}`, start: s.start, end: s.end, text: s.text, idx: s.idx });
        return `<span class="recite-sent tj-sent-span" data-sent-id="tj_s_${s.idx}" data-sent-idx="${s.idx}" data-start="${s.start}" data-end="${s.end}">${s.text}</span>`;
      }).join(' ');

      secHtml += `
        <article class="tj-handbook-card xt-section ${badgeType}" style="margin-bottom:20px;padding:16px;background:var(--bg-card);border-radius:12px;border:1px solid var(--line-main);">
          <div class="tj-card-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <span class="tj-card-tag badge-type-${badgeType}" style="font-size:12px;font-weight:700;padding:2px 8px;border-radius:4px;background:var(--badge-bg, rgba(185,28,28,0.1));color:var(--vermilion, #b91c1c);">${sec.tag || `讲义 ${sIdx+1}`}</span>
            <span class="tj-card-status" style="font-size:11.5px;color:var(--ink-muted);">${sec.badge || '重点掌握'}</span>
          </div>
          <h3 class="tj-card-title" style="font-size:15.5px;font-weight:700;margin-bottom:12px;color:var(--ink-primary);">${sec.title || ''}</h3>
          <div class="tj-sentence-flow">${sentsHtml}</div>
        </article>
      `;
    });

    let pointsHtml = '';
    if (dayItem.points && dayItem.points.length > 0) {
      pointsHtml = `
        <div class="tj-points-box" style="margin-top:24px;padding:18px;background:var(--paper-subtle, var(--bg-card));border-radius:12px;border:1.5px dashed var(--vermilion, #b91c1c);">
          <div class="tj-points-title" style="font-size:15px;font-weight:800;color:var(--vermilion, #b91c1c);margin-bottom:12px;display:flex;align-items:center;gap:6px;">
            <span style="display:inline-flex;align-items:center;gap:6px;"><svg class="pol-btn-svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg> 高频命题与辨析考点</span>
          </div>
          <div class="tj-points-list" style="display:flex;flex-direction:column;gap:10px;">
            ${dayItem.points.map(p => `
              <div class="tj-point-card" style="padding:10px 14px;background:var(--bg-card);border-radius:8px;border:1px solid var(--line-subtle, rgba(0,0,0,0.08));">
                <span class="tj-point-label" style="font-weight:700;color:var(--vermilion, #b91c1c);margin-right:6px;">【${p.label}】</span>
                <span class="tj-point-text">${p.text}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    el.paperContent.innerHTML = `${topBarHtml}${secHtml}${pointsHtml}`;

    if (dayItem.audio) {
      audio.src = dayItem.audio;
      audio.load();
      audio.playbackRate = state.speed;
      tryRestoreAudioTime(restoreTime, `pol_${dayItem.id}_${state.currentTrack}`);
      if (autoPlay) audio.play().catch(e => console.log(e));
    } else {
      clearAudioSource();
    }
    updatePlayBtnUI();

    state.activeSentences = sanitizeSentences(allSentences);
    stampSentenceIndices();
    bindSentenceClickHandlers(el.paperContent);
    bindCardSectionClickHandlers(el.paperContent);

    attachSealButtonListeners(dayItem.id);
    buildFrameworkIndex();
    enhanceClozeKeywords();
  }

  function applyClozeClassToPaper() {
    if (!el.paperContent) return;
    if (state.clozeMode === 'keyword') {
      el.paperContent.classList.remove('cloze-body');
      el.paperContent.classList.add('cloze-keyword', 'cloze-keyword-active');
    } else if (state.clozeMode === 'body') {
      el.paperContent.classList.remove('cloze-keyword', 'cloze-keyword-active');
      el.paperContent.classList.add('cloze-body');
    } else {
      el.paperContent.classList.remove('cloze-keyword', 'cloze-keyword-active', 'cloze-body');
    }
  }
  function enhanceClozeKeywords() {
    if (!el.paperContent) return;

    // 0. 政治作用域自动关键词标记识别
    if (el.paperContent.classList.contains('pol-scope')) {
      // 轨二微考点关键词
      el.paperContent.querySelectorAll('.stream-kw:not(.cloze)').forEach(elKw => {
        elKw.classList.add('cloze');
      });
      // 徐涛 16 天考点重点
      el.paperContent.querySelectorAll('.xt-point-content strong:not(.cloze)').forEach(st => {
        st.classList.add('cloze');
      });
      // 腿姐 11 天核心考点与重点加粗短语
      el.paperContent.querySelectorAll('.tj-point-text').forEach(pText => {
        if (!pText.querySelector('strong, .cloze')) {
          const raw = pText.innerHTML;
          let enhanced = raw.replace(/([“《][^”》]+[”》])/g, '<span class="cloze pol-auto-cloze">$1</span>');
          if (enhanced === raw) {
            // 若无引号书名号，提取冒号、是、在于或括号内的核心题眼
            const m = raw.match(/(：|在于|是)([^，。；！？\n<]{2,28})/);
            if (m) {
              const marker = m[1];
              const phrase = m[2];
              enhanced = raw.replace(m[0], `${marker}<span class="cloze pol-auto-cloze">${phrase}</span>`);
            } else if (/[（(][^）)]+[）)]/.test(raw)) {
              enhanced = raw.replace(/([（(][^）)]+[）)])/, '<span class="cloze pol-auto-cloze">$1</span>');
            } else if (raw.includes('，')) {
              const parts = raw.split('，');
              if (parts.length >= 2 && parts[1].trim().length >= 3) {
                const clause = parts[1].replace(/[。；！？\n].*$/, '').trim();
                if (clause.length >= 3 && !clause.includes('<')) {
                  enhanced = raw.replace(clause, `<span class="cloze pol-auto-cloze">${clause}</span>`);
                }
              }
            } else if (raw.trim().length >= 4 && !raw.includes('<')) {
              const phrase = raw.trim();
              enhanced = `<span class="cloze pol-auto-cloze">${phrase}</span>`;
            }
          }
          if (enhanced !== raw) {
            pText.innerHTML = enhanced;
          }
        }
      });
      el.paperContent.querySelectorAll('.tj-point-text strong:not(.cloze)').forEach(st => {
        st.classList.add('cloze');
      });

      // 轨二微考点 (#polSubcardBody / .lecture-structured-wrap) 自动关键词补全
      const polSubcardBody = el.paperContent.querySelector('#polSubcardBody') || el.paperContent.querySelector('.lecture-structured-wrap');
      if (polSubcardBody) {
        const sents = polSubcardBody.querySelectorAll('.recite-sentence, .stream-takeaway-text .recite-sentence, .stream-outline-row .recite-sentence, .stream-intro-row .recite-sentence');
        sents.forEach(sent => {
          if (sent.querySelector('.cloze, .stream-kw')) return;
          const raw = sent.innerHTML;
          if (raw.includes('<span class="cloze') || raw.includes('<span class="stream-kw')) return;

          let enhanced = raw;
          if (/[“《][^”》]+[”》]/.test(raw)) {
            enhanced = raw.replace(/([“《][^”》]+[”》])/g, '<span class="cloze pol-auto-cloze">$1</span>');
          } else {
            const m = raw.match(/(：|在于|是)([^，。；！？\n<]{2,28})/);
            if (m) {
              const marker = m[1];
              const phrase = m[2];
              enhanced = raw.replace(m[0], `${marker}<span class="cloze pol-auto-cloze">${phrase}</span>`);
            } else if (raw.includes('，')) {
              const parts = raw.split('，');
              if (parts.length >= 2) {
                const second = parts[1].replace(/[，。；！？\n].*$/, '').trim();
                if (second.length >= 3 && !second.includes('<')) {
                  enhanced = raw.replace(second, `<span class="cloze pol-auto-cloze">${second}</span>`);
                }
              }
            } else {
              const clean = raw.replace(/[。；！？\n]+$/, '').trim();
              if (clean.length >= 6 && !clean.includes('<')) {
                const core = clean.length > 10 ? clean.substring(2, clean.length - 2) : clean.substring(1);
                enhanced = raw.replace(core, `<span class="cloze pol-auto-cloze">${core}</span>`);
              }
            }
          }
          if (enhanced !== raw) {
            sent.innerHTML = enhanced;
          }
        });
      }

      // 兜底保障：若腿姐或其它政治页面中仍未产生 .cloze，则在正文首批句子中自动构建挖空
      if (el.paperContent.querySelectorAll('.cloze').length === 0) {
        el.paperContent.querySelectorAll('.recite-sent, .recite-sent-item').forEach(sent => {
          if (sent.querySelector('.cloze')) return;
          const raw = sent.innerHTML;
          if (raw.includes('<span class="cloze')) return;
          if (/[“《][^”》]+[”》]/.test(raw)) {
            sent.innerHTML = raw.replace(/([“《][^”》]+[”》])/, '<span class="cloze pol-auto-cloze">$1</span>');
          } else {
            const m = raw.match(/(：|在于|是)([^，。；！？\n<]{2,28})/);
            if (m) {
              sent.innerHTML = raw.replace(m[0], `${m[1]}<span class="cloze pol-auto-cloze">${m[2]}</span>`);
            }
          }
        });
      }
    }

    // 1. 全科通用首字弱提示 (Ghost Hint)：为 .kw-red 与 .cloze:not([data-ghost]) 自动补充 data-ghost="首字···"
    const needGhosts = el.paperContent.querySelectorAll('.kw-red:not([data-ghost]), .cloze:not([data-ghost]), .stream-kw:not([data-ghost])');
    needGhosts.forEach(kw => {
      let text = kw.textContent.trim().replace(/^[“《(\[{【（]+/, '');
      if (text.length > 0) {
        const firstChar = text.charAt(0);
        kw.setAttribute('data-ghost', `${firstChar}···`);
      }
    });

    // 2. 为所有 .cloze 与 .kw-red 绑定独立单点揭晓/遮蔽事件，并阻止冒泡
    const allClozes = el.paperContent.querySelectorAll('.cloze, .kw-red, .stream-kw');
    allClozes.forEach(kw => {
      if (kw.dataset.clozeBound) return;
      kw.dataset.clozeBound = '1';
      kw.addEventListener('click', (e) => {
        if (state.clozeMode === 'keyword') {
          e.stopPropagation();
          e.preventDefault();
          kw.classList.toggle('revealed');
        }
      });
    });
  }

  function attachSealButtonListeners(itemId) {
    const sealBtns = el.paperContent.querySelectorAll(`[id^="sealBtn_${itemId}"]`);
    sealBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const current = getMasteryStatus(itemId);
        const next = current === 'mastered' ? 'unlearned' : 'mastered';
        setMasteryStatus(itemId, next);
      });
    });
  }


  // 全局安全兜底垫片函数 (Global Shims)
  window.seekChapterReciteSentence = function(chId, start, idx) {
    if (idx !== undefined) {
      const parsedIdx = parseInt(idx, 10);
      if (!isNaN(parsedIdx) && state.activeSentences && parsedIdx >= 0 && parsedIdx < state.activeSentences.length) {
        seekToSentence(parsedIdx, state.activeSentences[parsedIdx].start);
        return;
      }
    }
    seekToSentence(idx !== undefined ? idx : chId, start);
  };
  window.seekReciteSentence = function(cardId, start, idx) {
    if (idx !== undefined) {
      const parsedIdx = parseInt(idx, 10);
      if (!isNaN(parsedIdx) && state.activeSentences && parsedIdx >= 0 && parsedIdx < state.activeSentences.length) {
        seekToSentence(parsedIdx, state.activeSentences[parsedIdx].start);
        return;
      }
    }
    seekToSentence(idx !== undefined ? idx : cardId, start);
  };
  window.toggleChapterReciteAudio = function(chId, ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    toggleAudioPlayback();
  };
  window.togglePlayCardAudio = function(cardId, title, chId, ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    const firstSent = (state.activeSentences && state.activeSentences.length > 0) ? state.activeSentences[0] : null;
    if (!state.isPlaying && firstSent) {
      seekToSentence(firstSent.idx, firstSent.start);
      if (audio.paused) {
        audio.play().catch(e => console.log(e));
      }
    } else {
      toggleAudioPlayback();
    }
  };

  // 确保 IIFE 内部所有变量、函数与垫片完全初始化后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
  } else {
    startApp();
  }

})();
