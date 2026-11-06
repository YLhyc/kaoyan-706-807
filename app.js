/**
 * 2027 考研全科双轨随身背诵手卷 · 核心交互引擎 (全科金石朱墨专研版)
 * 深度集成 807 专业课、706 专业课 与 考研英语写作听力磨耳库
 * 支持纯本地离线 (ZERO-CORS) 瞬时加载与全量 176 音轨毫秒级点读对齐
 */

(function () {
  'use strict';

  const state = {
    allData: null,
    currentSubject: '807', // '807' | '706' | 'en'
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

    lastUserScrollTime: 0
  };

  const audio = new Audio();
  audio.preload = 'metadata';

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
      id: 'sentence',
      label: '单句',
      name: '单句循环',
      badge: '逐句循环',
      desc: '在当前单句内循环跟读背诵，点击任意句子即可循环该句',
      toast: '已开启【单句循环】· 点击任意句子即无限循环朗读',
      iconSvg: '<polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path><text x="12" y="16" font-size="8" font-weight="900" text-anchor="middle" fill="currentColor">1</text>'
    }
  ];

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
    if (state.currentSentIndex !== -1 && state.activeSentences && state.activeSentences[state.currentSentIndex]) {
      highlightSentence(state.activeSentences[state.currentSentIndex].id);
    }
  }

  function openPlayModeDrawer() {
    if (!el.playModeDrawer || !el.playModeList) return;
    renderPlayModeList();
    setPlayerDockReceded(true);
    if (el.playModeBackdrop) el.playModeBackdrop.style.display = 'block';
    setTimeout(() => {
      el.playModeDrawer.classList.add('open');
      el.playModeDrawer.setAttribute('aria-hidden', 'false');
    }, 10);
  }

  function closePlayModeDrawer() {
    if (!el.playModeDrawer) return;
    el.playModeDrawer.classList.remove('open');
    el.playModeDrawer.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
      if (el.playModeBackdrop) el.playModeBackdrop.style.display = 'none';
    }, 280);
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
      if (el.itemList) {
        el.itemList.innerHTML = `<div style="padding:40px 16px;text-align:center;color:red;font-size:13px;">数据加载失败，请检查 kaoyan_data.js 是否就绪</div>`;
      }
      return;
    }

    // 恢复上次背诵的科目与音轨
    const savedSubject = localStorage.getItem('kaoyan_last_subject');
    if (savedSubject && ['807', '706', 'en'].includes(savedSubject)) {
      state.currentSubject = savedSubject;
      if (el.subject807Btn) el.subject807Btn.classList.toggle('active', savedSubject === '807');
      if (el.subject706Btn) el.subject706Btn.classList.toggle('active', savedSubject === '706');
      if (el.subjectEnBtn) el.subjectEnBtn.classList.toggle('active', savedSubject === 'en');
      updateSubjectUI(savedSubject);
    }

    const savedTrack = localStorage.getItem('kaoyan_last_track');
    if (savedTrack && (savedTrack === '1' || savedTrack === '2')) {
      state.currentTrack = parseInt(savedTrack, 10);
      if (el.tabTrack1) el.tabTrack1.classList.toggle('active', state.currentTrack === 1);
      if (el.tabTrack2) el.tabTrack2.classList.toggle('active', state.currentTrack === 2);
    }

    updateBadgeCounts();
    renderFilterPills();
    renderSidebarList();
    
    // 恢复上次听到的知识点，不再每次进入都回到最开始的第一题
    const defaultList = getCurrentItemsList();
    const savedItemId = localStorage.getItem(`kaoyan_last_item_${state.currentSubject}`) || localStorage.getItem('kaoyan_last_item_id');
    const targetItem = (savedItemId && defaultList.find(x => x.id === savedItemId)) || defaultList[0];
    if (targetItem) {
      selectItem(targetItem.id, false, true);
    }
  }

  function getCurrentItemsList() {
    if (!state.allData) return [];
    let rawList;
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
        btn.className = `filter-pill ${state.tierFilter === p.id ? 'active' : ''}`;
        btn.dataset.filter = p.id;
        btn.textContent = p.label;
        btn.addEventListener('click', () => {
          state.tierFilter = p.id;
          el.filterPillsWrap.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          renderSidebarList();
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
        btn.className = `filter-pill ${state.tierFilter === p.id ? 'active' : ''}`;
        btn.dataset.filter = p.id;
        btn.textContent = p.label;
        btn.addEventListener('click', () => {
          state.tierFilter = p.id;
          el.filterPillsWrap.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          renderSidebarList();
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
    
    el.subject807Btn.classList.toggle('active', sub === '807');
    el.subject706Btn.classList.toggle('active', sub === '706');
    if (el.subjectEnBtn) el.subjectEnBtn.classList.toggle('active', sub === 'en');
    
    updateSubjectUI(sub);
    
    state.tierFilter = 'all';
    renderFilterPills();
    
    localStorage.setItem('kaoyan_last_subject', sub);
    renderSidebarList();
    const list = getCurrentItemsList();
    const savedForSub = localStorage.getItem(`kaoyan_last_item_${sub}`);
    const targetItem = (savedForSub && list.find(x => x.id === savedForSub)) || list[0];
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
          未检索到符合条件的考点题目
        </div>`;
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

      const hasAudio = item.track1 && item.track1.has_audio;
      const audioStatusHtml = hasAudio 
        ? `<span class="card-audio-status has-audio" title="通读音频已就绪">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
               <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
               <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
             </svg>
             ${state.currentSubject === 'en' ? '范文' : '通读'}
           </span>`
        : `<span class="card-audio-status" title="文本已就绪">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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

      card.addEventListener('click', () => {
        selectItem(item.id);
        const studyTab = document.getElementById('nav-tab-study');
        if (studyTab) studyTab.click();
        if (window.innerWidth <= 900 && el.sidebar) {
          el.sidebar.classList.remove('open');
          setPlayerDockReceded(false);
          if (el.backdrop) el.backdrop.classList.remove('open');
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
    } catch (e) {
      console.warn('Failed to parse kaoyan_mastery_state:', e);
      state.masteryState = {};
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
      state.studyLogs.totalCardsCompleted = (state.studyLogs.totalCardsCompleted || 0) + 1;
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
  }

  function openStudyDashboard() {
    if (!el.studyDashboardDrawer) return;
    updateStudyDashboardUI();
    el.studyDashboardDrawer.classList.add('open');
    setPlayerDockReceded(true);
    if (el.studyDashboardBackdrop) el.studyDashboardBackdrop.style.display = 'block';
  }

  function closeStudyDashboard() {
    if (!el.studyDashboardDrawer) return;
    el.studyDashboardDrawer.classList.remove('open');
    setPlayerDockReceded(false);
    if (el.studyDashboardBackdrop) el.studyDashboardBackdrop.style.display = 'none';
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
    const allItems = [...items807, ...items706, ...itemsEn];

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

    // 英语
    if (el.dashRatioEn) el.dashRatioEn.textContent = `${sEn.m} / ${sEn.total} 篇 · ${sEn.percent}%`;
    if (el.dashBarEnMastered) el.dashBarEnMastered.style.width = `${sEn.percent}%`;
    if (el.dashBarEnFamiliar) el.dashBarEnFamiliar.style.width = `${sEn.total ? (sEn.f / sEn.total) * 100 : 0}%`;
    if (el.dashDetailEn) el.dashDetailEn.textContent = `已掌握 ${sEn.m} · 磨耳 ${sEn.f} · 待背 ${sEn.u}`;

    // 3. T0 & T1 核心攻克率
    const t0Items = allItems.filter(x => x.level === 'T0' || (x.category_id && !x.level && (x.title.includes('书信') || x.title.includes('图画'))));
    const t1Items = allItems.filter(x => x.level === 'T1' || (x.category_id && !x.level && !t0Items.includes(x)));

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

  function randomPickUnmasteredT0T1() {
    if (!state.allData) return;
    const items807 = state.allData.items_807 || [];
    const items706 = state.allData.items_706 || [];
    const itemsEn = state.allData.items_en || [];
    const allItems = [
      ...items807.map(it => ({ ...it, subj: '807' })),
      ...items706.map(it => ({ ...it, subj: '706' })),
      ...itemsEn.map(it => ({ ...it, subj: 'en' }))
    ];

    let candidates = allItems.filter(x => {
      const isHighPriority = x.level === 'T0' || x.level === 'T1' || x.category_id;
      const isNotMastered = getMasteryStatus(x.id) !== 'mastered';
      return isHighPriority && isNotMastered;
    });

    if (candidates.length === 0) {
      candidates = allItems.filter(x => getMasteryStatus(x.id) !== 'mastered');
    }

    if (candidates.length === 0) {
      showToast('大圆满！全科 82 道考题已全部背熟掌握！正在随机抽查一道进行复习...', 2500);
      candidates = allItems;
    }

    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    closeStudyDashboard();

    if (state.currentSubject !== picked.subj) {
      switchSubject(picked.subj);
    }
    selectItem(picked.id, true);
    showToast(`已为你抽查【${picked.level || '必背'}】${picked.title}，立即开始磨耳背诵！`, 3000);
  }

  // DOM 兜底解析机制：离线或 file:/// 协议无 JSON 缓存时，从当前 DOM 提取
  function extractSentencesFromDOM() {
    if (!el.paperContent) return [];
    const nodes = el.paperContent.querySelectorAll('.recite-sent[data-start][data-end]');
    const list = [];
    nodes.forEach((node, idx) => {
      const start = parseFloat(node.dataset.start);
      const end = parseFloat(node.dataset.end);
      if (!isNaN(start) && !isNaN(end)) {
        const id = node.dataset.sentId || node.dataset.id || node.id || `sent_${idx}`;
        const text = (node.innerText || node.textContent || '').trim();
        list.push({ id, start, end, text });
      }
    });
    list.sort((a, b) => a.start - b.start);
    return list;
  }

  function selectItem(itemId, autoPlay = false, restoreTime = false) {
    const list = getCurrentItemsList();
    const item = list.find(x => x.id === itemId);
    if (!item) return;

    state.activeItemId = itemId;
    state.activeItem = item;
    state.currentSentIndex = -1;
    state.loopCount = 0;

    localStorage.setItem(`kaoyan_last_item_${state.currentSubject}`, itemId);
    localStorage.setItem('kaoyan_last_item_id', itemId);
    localStorage.setItem('kaoyan_last_subject', state.currentSubject);
    localStorage.setItem('kaoyan_last_track', String(state.currentTrack));

    document.querySelectorAll('.question-card-item').forEach(card => {
      card.classList.toggle('active', card.dataset.id === itemId);
    });

    el.questionTitle.textContent = item.title;
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
      const subjPrefix = state.currentSubject === '807' ? '807' : (state.currentSubject === '706' ? '706' : '英语');
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

    // 1. 同步第一时间挂载音频并处理自动播放（保护 iOS Safari WebKit 用户手势与后台连播上下文）
    if (trackObj && trackObj.audio) {
      audio.src = trackObj.audio;
      audio.load();
      audio.playbackRate = state.speed;

      if (restoreTime && localStorage.getItem('kaoyan_last_time_key') === `${state.currentSubject}_${state.activeItemId}_${trackNum}`) {
        const savedTime = parseFloat(localStorage.getItem('kaoyan_last_time') || '0');
        if (savedTime > 1) {
          const applyRestoredTime = () => {
            audio.currentTime = savedTime;
            audio.playbackRate = state.speed;
            if (el.timeCurrent) el.timeCurrent.textContent = formatTime(savedTime);
            if (audio.duration > 0 && el.progressFill) {
              el.progressFill.style.width = Math.min(100, (savedTime / audio.duration) * 100) + '%';
            }
            updateHUDDisplay(savedTime);
            if (state.activeSentences && state.activeSentences.length > 0) {
              const matchedSent = state.activeSentences.find(s => savedTime >= s.start && savedTime < s.end);
              if (matchedSent) {
                state.currentSentIndex = state.activeSentences.indexOf(matchedSent);
                highlightSentence(matchedSent.id);
              }
            }
          };

          if (audio.readyState >= 1) {
            applyRestoredTime();
          } else {
            audio.addEventListener('loadedmetadata', applyRestoredTime, { once: true });
          }
        }
      }

      if (autoPlay) {
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.catch(e => console.log('Autoplay prevented:', e));
        }
      }
    } else {
      audio.src = '';
    }
    updatePlayBtnUI();

    // 2. 同步渲染正文 HTML（使得 DOM 节点到位）
    renderPaperContent(trackObj, []);

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

    state.activeSentences = sentences || [];
    buildFrameworkIndex();

    // 若未命中内置包且有 sFile，发起异步非阻塞 fetch 进行补充校准
    if (sFile && (!window.KAOYAN_SENTENCES || !window.KAOYAN_SENTENCES[sFile])) {
      fetch(sFile + '?t=' + Date.now())
        .then(res => res.ok ? res.json() : null)
        .then(fetchedSents => {
          if (fetchedSents && fetchedSents.length > 0 && state.currentTrack === trackNum && state.activeItemId === item.id) {
            state.activeSentences = fetchedSents;
            buildFrameworkIndex();
          }
        })
        .catch(e => {
          console.warn('Sentence timestamps fallback failed:', e);
          if (!state.activeSentences || state.activeSentences.length === 0) {
            state.activeSentences = extractSentencesFromDOM();
            buildFrameworkIndex();
          }
        });
    }
  }

  function renderPaperContent(trackObj, sentences) {
    if (!el.paperContent) return;
    el.paperContent.innerHTML = '';

    if (!trackObj) {
      el.paperContent.innerHTML = `<p class="paper-paragraph" style="color: var(--ink-muted);">暂无内容</p>`;
      return;
    }

    if (trackObj.html) {
      el.paperContent.innerHTML = trackObj.html;
      // Attach click events to all recite-sent spans
      const sents = el.paperContent.querySelectorAll('.recite-sent');
      sents.forEach(s => {
        s.addEventListener('click', () => {
          const sentId = s.dataset.sentId;
          const start = parseFloat(s.dataset.start);
          if (!isNaN(start)) {
            seekToSentence(sentId, start);
          }
        });
      });
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

  function seekToSentence(sentId, startTime) {
    audio.currentTime = startTime;
    if (audio.paused) {
      audio.play().catch(e => console.log(e));
    }
    const sentIdx = state.activeSentences.findIndex(s => String(s.id) === String(sentId));
    if (sentIdx !== -1) {
      state.currentSentIndex = sentIdx;
      state.loopCount = 0;
    }
    if (currentFrameworkSections.length > 0) {
      const matchedSecIdx = currentFrameworkSections.findIndex(s => startTime >= s.start - 0.1 && startTime <= s.end + 0.1);
      if (matchedSecIdx !== -1) {
        currentActiveSectionIndex = matchedSecIdx;
      }
    }
    highlightSentence(sentId);
    updateHUDDisplay(startTime);
  }

  function highlightSentence(sentId) {
    const sents = document.querySelectorAll('.recite-sent');
    sents.forEach(s => {
      const match = String(s.dataset.sentId) === String(sentId);
      s.classList.toggle('active-spotlight', match);
      s.classList.toggle('loop-sent-active', match && state.playMode === 'sentence');
      if (match) {
        const now = Date.now();
        if (now - state.lastUserScrollTime > 2500) {
          s.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    });

    if (currentFrameworkSections.length > 0 && currentActiveSectionIndex >= 0) {
      currentFrameworkSections.forEach((s, idx) => {
        if (s.cardEl) {
          s.cardEl.classList.toggle('loop-sec-active', idx === currentActiveSectionIndex && state.playMode === 'section');
        }
      });
    }
  }


  // ==========================================
  // 全息感知条 (Now-Playing HUD) 与骨架大纲核心引擎
  // ==========================================
  let currentFrameworkSections = [];
  let currentActiveSectionIndex = -1;

  function buildFrameworkIndex() {
    currentFrameworkSections = [];
    currentActiveSectionIndex = -1;

    if (!el.paperContent) return;

    const cards = el.paperContent.querySelectorAll('.exam-section-card, .logic-block-card, section.exam-section-card');
    
    cards.forEach((card, idx) => {
      const cardSents = card.querySelectorAll('.recite-sent');
      const firstSent = cardSents.length > 0 ? cardSents[0] : null;
      const lastSent = cardSents.length > 0 ? cardSents[cardSents.length - 1] : null;
      const start = firstSent ? parseFloat(firstSent.dataset.start || 0) : 0;
      let end = lastSent ? parseFloat(lastSent.dataset.end || 0) : 0;
      const sentId = firstSent ? firstSent.dataset.sentId : null;

      let badge = '';
      let desc = '';
      
      const secBadgeEl = card.querySelector('.sec-badge');
      const secDescEl = card.querySelector('.sec-desc');
      const logicTitleEl = card.querySelector('.logic-block-title h3, h3');
      const qaBadgeEl = card.querySelector('.qa-badge');

      if (secBadgeEl) {
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
      } else if (/引论|立论/.test(badge)) {
        secType = 'intro';
      } else if (/结语|总结/.test(badge)) {
        secType = 'conclusion';
      }

      const thesisSentEl = card.querySelector('.thesis-sent, .teacher-explain-row .recite-sent, .recite-sent');
      const thesisText = thesisSentEl ? thesisSentEl.textContent.replace(/【[^】]+】/g, '').trim() : '';

      currentFrameworkSections.push({
        index: idx,
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
      if (!sec.end || isNaN(sec.end) || sec.end <= sec.start) {
        sec.end = (i < currentFrameworkSections.length - 1 && currentFrameworkSections[i + 1].start > sec.start)
          ? currentFrameworkSections[i + 1].start
          : fallbackTotalEnd;
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
      if (state.currentSubject === 'en') {
        el.hudTrackText.textContent = isT1 ? '轨一 · 中英磨耳版' : '轨二 · 仿写拓展版';
      } else {
        el.hudTrackText.textContent = isT1 ? '轨一 · 考场答题版' : '轨二 · 逻辑精解版';
      }
    }

    // 2. 考题标题与分值
    if (el.hudTitleText) {
      const subjPrefix = state.currentSubject === '807' ? '807' : (state.currentSubject === '706' ? '706' : '英语');
      const scoreBadge = item.score ? ` (${item.score})` : '';
      el.hudTitleText.textContent = `${subjPrefix} · ${item.title}${scoreBadge}`;
    }

    // 3. 动态框架层级与正文吸顶/高亮联动
    if (currentFrameworkSections.length > 0) {
      let activeSecIdx = 0;
      for (let i = 0; i < currentFrameworkSections.length; i++) {
        if (curTime >= currentFrameworkSections[i].start - 0.1) {
          activeSecIdx = i;
        } else {
          break;
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

      if (activeSecIdx !== currentActiveSectionIndex) {
        currentActiveSectionIndex = activeSecIdx;

        // 联动正文卡片当前焦点光晕
        currentFrameworkSections.forEach((s, idx) => {
          if (s.cardEl) {
            s.cardEl.classList.toggle('active-section-card', idx === activeSecIdx);
          }
        });

        // 联动大纲抽屉当前激活项
        updateOutlineDrawerActive(activeSecIdx);

        // 同步系统锁屏/通知栏 MediaSession 元数据
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
    if (state.currentSubject === 'en') {
      trackLabel = isT1 ? '轨一·磨耳版' : '轨二·拓展版';
    }

    const secTitle = currentSec ? `[${currentSec.index + 1}/${totalSec} ${currentSec.badge}] ` : '';
    const subjName = state.currentSubject === '807' ? '807 现代文学' : (state.currentSubject === '706' ? '706 古代文学' : '考研英语写作');

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
        audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 5));
      });
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (details.seekOffset || 5));
      });
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== null && details.seekTime !== undefined) {
          audio.currentTime = details.seekTime;
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
      el.drawerTrackBadge.textContent = isT1 ? '轨道一 · 考场答题版' : '轨道二 · 逻辑精解版';
    }

    if (el.drawerTopicSub && state.activeItem) {
      const item = state.activeItem;
      const subj = state.currentSubject === '807' ? '807 综合' : (state.currentSubject === '706' ? '706 综合' : '考研英语');
      el.drawerTopicSub.textContent = `${subj} · ${item.title} (${item.score || ''})`;
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

  function setupAudioEngine() {
    audio.addEventListener('play', () => {
      state.isPlaying = true;
      audio.playbackRate = state.speed;
      updatePlayBtnUI();
      expandPlayerDock();
    });

    audio.addEventListener('pause', () => {
      state.isPlaying = false;
      updatePlayBtnUI();
      collapsePlayerDock(); // 暂停即自动收起为底栏
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

      if (state.activeSentences && state.activeSentences.length > 0) {
        const activeIdx = state.activeSentences.findIndex(s => cur >= s.start && cur < s.end);
        
        if (activeIdx !== -1 && activeIdx !== state.currentSentIndex) {
          state.currentSentIndex = activeIdx;
          state.loopCount = 0;
          const sent = state.activeSentences[activeIdx];
          highlightSentence(sent.id);
        }

        // 1. 单句循环模式
        if (state.playMode === 'sentence' && state.currentSentIndex !== -1 && state.activeSentences && state.activeSentences[state.currentSentIndex]) {
          const sent = state.activeSentences[state.currentSentIndex];
          if (cur >= sent.end - 0.08) {
            audio.currentTime = sent.start;
            if (audio.paused) audio.play().catch(e => console.log(e));
          }
        }
        // 2. 单段循环模式
        else if (state.playMode === 'section' && currentActiveSectionIndex >= 0 && currentActiveSectionIndex < currentFrameworkSections.length) {
          const curSec = currentFrameworkSections[currentActiveSectionIndex];
          if (cur >= curSec.end - 0.08) {
            audio.currentTime = curSec.start;
            if (audio.paused) audio.play().catch(e => console.log(e));
          }
        }
        // 3. 单句3遍模式
        else if (state.playMode === 'loop3' && state.currentSentIndex !== -1 && state.activeSentences && state.activeSentences[state.currentSentIndex]) {
          const sent = state.activeSentences[state.currentSentIndex];
          if (cur >= sent.end - 0.08) {
            if (state.loopCount < 2) {
              state.loopCount++;
              audio.currentTime = sent.start;
              if (audio.paused) audio.play().catch(e => console.log(e));
            } else {
              state.loopCount = 0;
            }
          }
        }
      }
    });

    audio.addEventListener('ended', () => {
      // 1. 完全循环（整个知识点循环）
      if (state.playMode === 'item') {
        audio.currentTime = 0;
        audio.play().catch(e => console.log(e));
        return;
      }
      // 2. 单句循环
      if (state.playMode === 'sentence' && state.currentSentIndex !== -1 && state.activeSentences && state.activeSentences[state.currentSentIndex]) {
        audio.currentTime = state.activeSentences[state.currentSentIndex].start;
        audio.play().catch(e => console.log(e));
        return;
      }
      // 3. 单段循环
      if (state.playMode === 'section' && currentActiveSectionIndex >= 0 && currentActiveSectionIndex < currentFrameworkSections.length) {
        audio.currentTime = currentFrameworkSections[currentActiveSectionIndex].start;
        audio.play().catch(e => console.log(e));
        return;
      }
      // 4. 按顺序依次播放
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

    if (!el.playBtn) return;
    if (state.isPlaying) {
      el.playBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="4" width="4" height="16" rx="1"></rect>
          <rect x="14" y="4" width="4" height="16" rx="1"></rect>
        </svg>`;
      el.playBtn.title = "暂停播放";
    } else {
      el.playBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor">
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
    const list = getCurrentItemsList();
    const currIdx = list.findIndex(x => x.id === state.activeItemId);
    if (currIdx !== -1 && currIdx < list.length - 1) {
      selectItem(list[currIdx + 1].id, true);
    }
  }

  function playPrevItem() {
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
        if (el.outlineDrawer && el.outlineDrawer.classList.contains('open')) closeOutlineDrawer();
        if (el.playModeDrawer && el.playModeDrawer.classList.contains('open')) closePlayModeDrawer();
        if (el.studyDashboardDrawer && el.studyDashboardDrawer.classList.contains('open')) closeStudyDashboard();
      }
    });

    // 掌握度印章切换与研学看板
    if (el.btnMasteryToggle) {
      el.btnMasteryToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        cycleCurrentItemMastery();
      });
    }

    if (el.masteryPillsWrap) {
      const mPills = el.masteryPillsWrap.querySelectorAll('.filter-pill');
      mPills.forEach(pill => {
        pill.addEventListener('click', () => {
          state.masteryFilter = pill.dataset.mastery || 'all';
          mPills.forEach(p => p.classList.toggle('active', p === pill));
          renderSidebarList();
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

    if (el.searchInput) {
      el.searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value.trim();
        renderSidebarList();
      });
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
        if (audio.paused) {
          if (!audio.src) {
            loadTrackData(state.currentTrack, true);
          } else {
            audio.play().catch(e => console.log('Play failed:', e));
          }
        } else {
          audio.pause();
        }
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
        audio.currentTime = Math.max(0, audio.currentTime - 5);
      });
    }

    if (el.forwardBtn) {
      el.forwardBtn.addEventListener('click', () => {
        audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
      });
    }

    // 进度条拖拽与点击
    if (el.progressBar) {
      let isDragging = false;
      const handleSeek = (e) => {
        const rect = el.progressBar.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        if (audio.duration) {
          audio.currentTime = pos * audio.duration;
          if (el.progressFill) {
            el.progressFill.style.width = (pos * 100) + '%';
          }
          if (el.timeCurrent) {
            el.timeCurrent.textContent = formatTime(pos * audio.duration);
          }
          updateHUDDisplay(audio.currentTime);
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

    // 倍速调节
    const speeds = [1.0, 1.2, 1.5, 0.8];
    let speedIdx = 0;
    if (el.speedBtn) {
      el.speedBtn.addEventListener('click', () => {
        speedIdx = (speedIdx + 1) % speeds.length;
        state.speed = speeds[speedIdx];
        localStorage.setItem('kaoyan_speed', String(state.speed));
        audio.playbackRate = state.speed;
        el.speedBtn.querySelector('span').textContent = `${state.speed.toFixed(1)}x`;
      });
    }

    // 背诵遮罩自测模式 (正常研读 / 采分词挖空 / 看纲默背)
    if (el.clozeModeBtn) {
      el.clozeModeBtn.addEventListener('click', () => {
        if (state.clozeMode === 'off') {
          state.clozeMode = 'keyword';
          if (el.clozeModeName) el.clozeModeName.textContent = '挖空';
          el.clozeModeBtn.classList.add('active');
          if (el.paperContent) {
            el.paperContent.classList.remove('cloze-body');
            el.paperContent.classList.add('cloze-keyword');
          }
          showToast('已开启【采分词挖空自测】· 核心术语已遮罩，播到或点击即显', 2500);
        } else if (state.clozeMode === 'keyword') {
          state.clozeMode = 'body';
          if (el.clozeModeName) el.clozeModeName.textContent = '默背';
          el.clozeModeBtn.classList.add('active');
          if (el.paperContent) {
            el.paperContent.classList.remove('cloze-keyword');
            el.paperContent.classList.add('cloze-body');
          }
          showToast('已开启【看纲默背自测】· 仅留骨架，点击或播到该句自动显现', 2500);
        } else {
          state.clozeMode = 'off';
          if (el.clozeModeName) el.clozeModeName.textContent = '自测';
          el.clozeModeBtn.classList.remove('active');
          if (el.paperContent) {
            el.paperContent.classList.remove('cloze-keyword', 'cloze-body');
          }
          showToast('已切换为【正常研读模式】· 全文清晰呈现', 2000);
        }
      });
    }

    // 听读背诵循环模式选择抽屉
    if (el.loopModeBtn) {
      el.loopModeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPlayModeDrawer();
      });
    }

    // 主题切换
    if (el.themeToggleBtn) {
      el.themeToggleBtn.addEventListener('click', () => {
        state.theme = state.theme === 'parchment' ? 'dark' : 'parchment';
        document.documentElement.setAttribute('data-theme', state.theme);
        localStorage.setItem('kaoyan_theme', state.theme);
      });
    }

    // 字号调节
    if (el.fontDecBtn) {
      el.fontDecBtn.addEventListener('click', () => {
        state.fontSize = Math.max(14, state.fontSize - 1);
        document.documentElement.style.setProperty('--font-base', `${state.fontSize}px`);
        localStorage.setItem('kaoyan_font_size', state.fontSize);
      });
    }

    if (el.fontIncBtn) {
      el.fontIncBtn.addEventListener('click', () => {
        state.fontSize = Math.min(24, state.fontSize + 1);
        document.documentElement.style.setProperty('--font-base', `${state.fontSize}px`);
        localStorage.setItem('kaoyan_font_size', state.fontSize);
      });
    }

    // 字体切换体系 (四大学术字系全面覆盖，iOS原生高清字族精准映射)
    const fontFamilies = [
      { id: 'song', name: '雅宋', value: '"Songti SC", "STSongti-SC-Regular", "Noto Serif SC", "Source Han Serif SC", SimSun, serif' },
      { id: 'kai', name: '温楷', value: '"Kaiti SC", "STKaiti", "LXGW WenKai Screen", "LXGWWenKaiScreen", KaiTi, serif' },
      { id: 'sans', name: '精黑', value: '-apple-system, BlinkMacSystemFont, "PingFang SC", "SF Pro Text", "Hiragino Sans GB", "Microsoft YaHei", sans-serif' },
      { id: 'fangsong', name: '仿宋', value: '"STFangsong", "FangSong", "FangSong SC", "仿宋", "STSongti-SC-Regular", serif' }
    ];
    let fontIdx = 0;
    const fontSwitchBtn = document.getElementById('btn-font-switch');
    const fontNameLabel = document.getElementById('font-current-name');

    function applyFont(fontObj) {
      document.documentElement.setAttribute('data-font', fontObj.id);
      document.documentElement.style.setProperty('--font-current', fontObj.value);
      document.documentElement.style.setProperty('--font-content', fontObj.value);
      if (fontNameLabel) fontNameLabel.textContent = fontObj.name;
    }

    const savedFont = localStorage.getItem('kaoyan_font_family');
    if (savedFont) {
      const idx = fontFamilies.findIndex(f => f.id === savedFont || (savedFont === 'hei' && f.id === 'sans'));
      if (idx !== -1) {
        fontIdx = idx;
      }
    }
    applyFont(fontFamilies[fontIdx]);

    if (fontSwitchBtn) {
      fontSwitchBtn.addEventListener('click', () => {
        fontIdx = (fontIdx + 1) % fontFamilies.length;
        const curFont = fontFamilies[fontIdx];
        applyFont(curFont);
        localStorage.setItem('kaoyan_font_family', curFont.id);
      });
    }

    // 侧边栏折叠 (iPad & 桌面) 与移动端抽屉
    const appBody = document.querySelector('.app-body');
    const sidebarCollapseBtn = document.getElementById('btn-sidebar-collapse');

    // 恢复本地存储的侧边栏折叠状态 (大屏/iPad)
    if (window.innerWidth > 768 && localStorage.getItem('kaoyan_sidebar_collapsed') === '1') {
      if (appBody) appBody.classList.add('sidebar-collapsed');
    }

    if (el.mobileMenuBtn && el.sidebar) {
      el.mobileMenuBtn.addEventListener('click', () => {
        if (window.innerWidth > 768) {
          if (appBody) {
            const isCollapsed = appBody.classList.toggle('sidebar-collapsed');
            localStorage.setItem('kaoyan_sidebar_collapsed', isCollapsed ? '1' : '0');
          }
        } else {
          el.sidebar.classList.toggle('open');
          if (el.backdrop) el.backdrop.classList.toggle('open');
        }
      });
    }

    if (sidebarCollapseBtn) {
      sidebarCollapseBtn.addEventListener('click', () => {
        if (window.innerWidth > 768) {
          if (appBody) {
            appBody.classList.add('sidebar-collapsed');
            localStorage.setItem('kaoyan_sidebar_collapsed', '1');
          }
        } else {
          el.sidebar.classList.remove('open');
          setPlayerDockReceded(false);
          if (el.backdrop) el.backdrop.classList.remove('open');
        }
      });
    }

    if (el.backdrop && el.sidebar) {
      el.backdrop.addEventListener('click', () => {
        el.sidebar.classList.remove('open');
          setPlayerDockReceded(false);
        el.backdrop.classList.remove('open');
      });
    }

    // 监听正文区域用户手动滚动，短时间内不强制打断滚动视图
    if (el.paperContent) {
      el.paperContent.addEventListener('scroll', () => {
        state.lastUserScrollTime = Date.now();
      }, { passive: true });
    }


    // 浮动圆形播放驻留键与收起按钮
    const fabPlayBtn = document.getElementById('dock-fab-play');
    if (fabPlayBtn) {
      fabPlayBtn.addEventListener('click', () => {
        expandPlayerDock();
        if (audio.paused) {
          if (!audio.src) {
            loadTrackData(state.currentTrack, true);
          } else {
            audio.play().catch(e => console.log('Play failed:', e));
          }
        }
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

    // 恢复本地存储配置
    const savedTheme = localStorage.getItem('kaoyan_theme');
    if (savedTheme) {
      state.theme = savedTheme;
      document.documentElement.setAttribute('data-theme', savedTheme);
    }

    const savedFontSize = localStorage.getItem('kaoyan_font_size');
    if (savedFontSize) {
      state.fontSize = parseInt(savedFontSize, 10);
      document.documentElement.style.setProperty('--font-base', `${state.fontSize}px`);
    }

    const savedPlayMode = localStorage.getItem('kaoyan_play_mode');
    if (savedPlayMode && PLAY_MODES.some(m => m.id === savedPlayMode)) {
      state.playMode = savedPlayMode;
    }
    updatePlayModeUI(false);

    const savedSpeed = parseFloat(localStorage.getItem('kaoyan_speed'));
    if (!isNaN(savedSpeed) && speeds.includes(savedSpeed)) {
      state.speed = savedSpeed;
      speedIdx = speeds.indexOf(savedSpeed);
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

  function expandPlayerDock() {
    state.dockExpanded = true;
    document.body.classList.add('dock-expanded');
    const dock = document.querySelector('.player-dock');
    if (dock) dock.classList.remove('dock-collapsed');
    setBottomNavActiveTab('');
  }

  function collapsePlayerDock() {
    state.dockExpanded = true;
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
      const hasOpenDrawer = (
        (el.sidebar && el.sidebar.classList.contains('open') && window.innerWidth <= 768) ||
        (el.studyDashboardDrawer && el.studyDashboardDrawer.classList.contains('open')) ||
        (document.getElementById('settingsDrawer') && document.getElementById('settingsDrawer').classList.contains('open')) ||
        (document.getElementById('outlineDrawer') && document.getElementById('outlineDrawer').classList.contains('open'))
      );
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
      test: document.getElementById('nav-tab-test'),
      dashboard: document.getElementById('nav-tab-dashboard'),
      settings: document.getElementById('nav-tab-settings')
    };
    Object.keys(tabs).forEach(name => {
      const btn = tabs[name];
      if (btn) btn.classList.toggle('active', name === activeName);
    });
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
    }

    if (settingsClose) settingsClose.addEventListener('click', closeSettings);
    if (settingsBackdrop) settingsBackdrop.addEventListener('click', closeSettings);

    // 主题切换卡片
    const themeP = document.getElementById('sheetThemeParchment');
    const themeD = document.getElementById('sheetThemeDark');
    if (themeP) {
      themeP.addEventListener('click', () => {
        state.theme = 'parchment';
        document.documentElement.setAttribute('data-theme', 'parchment');
        localStorage.setItem('kaoyan_theme', 'parchment');
        updateSettingsSheetUI();
      });
    }
    if (themeD) {
      themeD.addEventListener('click', () => {
        state.theme = 'dark';
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('kaoyan_theme', 'dark');
        updateSettingsSheetUI();
      });
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

    // 字号调节
    const decBtn = document.getElementById('sheetFontDec');
    const incBtn = document.getElementById('sheetFontInc');
    const resetBtn = document.getElementById('sheetFontReset');

    if (decBtn) {
      decBtn.addEventListener('click', () => {
        state.fontSize = Math.max(14, state.fontSize - 1);
        document.documentElement.style.setProperty('--font-base', `${state.fontSize}px`);
        localStorage.setItem('kaoyan_font_size', state.fontSize);
        updateSettingsSheetUI();
      });
    }
    if (incBtn) {
      incBtn.addEventListener('click', () => {
        state.fontSize = Math.min(24, state.fontSize + 1);
        document.documentElement.style.setProperty('--font-base', `${state.fontSize}px`);
        localStorage.setItem('kaoyan_font_size', state.fontSize);
        updateSettingsSheetUI();
      });
    }
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        state.fontSize = 17;
        document.documentElement.style.setProperty('--font-base', '17px');
        localStorage.setItem('kaoyan_font_size', 17);
        updateSettingsSheetUI();
      });
    }

    // 1. 题库 Tab (考题目录抽屉)
    const tabSyllabus = document.getElementById('nav-tab-syllabus');
    if (tabSyllabus) {
      tabSyllabus.addEventListener('click', () => {
        if (settingsDrawer && settingsDrawer.classList.contains('open')) closeSettings();
        if (el.studyDashboardDrawer && el.studyDashboardDrawer.classList.contains('open')) closeStudyDashboard();

        if (window.innerWidth <= 768) {
          if (el.sidebar) {
            const willOpen = !el.sidebar.classList.contains('open');
            el.sidebar.classList.toggle('open', willOpen);
            if (el.backdrop) el.backdrop.classList.toggle('open', willOpen);
            setPlayerDockReceded(willOpen);
            setBottomNavActiveTab(willOpen ? 'syllabus' : '');
          }
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

    // 2. 自测 Tab (循环切换 正常 -> 挖空 -> 默背)
    const tabTest = document.getElementById('nav-tab-test');
    if (tabTest) {
      tabTest.addEventListener('click', () => {
        if (el.clozeModeBtn) {
          el.clozeModeBtn.click();
          const label = document.getElementById('label-tab-test');
          if (label) {
            label.textContent = state.clozeMode === 'off' ? '自测' : (state.clozeMode === 'keyword' ? '挖空' : '默背');
          }
          tabTest.classList.toggle('active', state.clozeMode !== 'off');
        }
      });
    }

    // 3. 【方案 C 核心中枢】底栏正中播放主按键
    const centerPlayBtn = document.getElementById('nav-tab-center-play');
    if (centerPlayBtn) {
      centerPlayBtn.addEventListener('click', () => {
        expandPlayerDock();
        if (audio.paused) {
          if (!audio.src) {
            loadTrackData(state.currentTrack, true);
          } else {
            audio.play().catch(e => console.log(e));
          }
        }
      });
    }

    // 4. 播放坞收起键 (滑下播放坞，无缝恢复 5-Tab 底栏)

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

    // 5. 看板 Tab (研学进度看板)
    const tabDashboard = document.getElementById('nav-tab-dashboard');
    if (tabDashboard) {
      tabDashboard.addEventListener('click', () => {
        if (settingsDrawer && settingsDrawer.classList.contains('open')) closeSettings();
        if (el.sidebar && el.sidebar.classList.contains('open')) {
          el.sidebar.classList.remove('open');
          if (el.backdrop) el.backdrop.classList.remove('open');
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
          el.sidebar.classList.remove('open');
          if (el.backdrop) el.backdrop.classList.remove('open');
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
  const APP_BUILD_ID = '2.0.5';
  let latestUpdatePayload = null;

  function showToast(msg, duration = 2500) {
    let t = document.getElementById('toastPrompt');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toastPrompt';
      t.className = 'toast-prompt';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('visible');
    setTimeout(() => {
      t.classList.remove('visible');
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

  async function checkAppUpdate(isManual = false) {
    const badge = document.getElementById('appVersionBadge');
    const versionText = document.getElementById('versionText');
    const banner = document.getElementById('updateBannerPill');
    const bannerText = document.getElementById('updateBannerText');

    if (isManual) {
      showToast('正在检查云端更新...');
      if (versionText) versionText.textContent = '检查中...';
    }

    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('fetch version.json failed');
      const payload = await res.json();
      latestUpdatePayload = payload;

      const remoteVer = String(payload.version || '');
      const isNewer = compareVersions(remoteVer, APP_BUILD_ID) > 0;
      const isDismissed = sessionStorage.getItem('dismiss_update_v' + remoteVer) === '1';

      if (isNewer) {
        if (banner && !isDismissed) {
          if (bannerText) bannerText.textContent = `发现新版本 v${remoteVer} · 点击立即更新`;
          banner.style.display = 'flex';
        }
        if (versionText) {
          versionText.textContent = `新版 v${remoteVer} 可升级`;
        }
        if (badge) {
          badge.classList.add('has-update');
        }
        if (isManual) {
          showToast(`发现新版本 v${remoteVer}！点击顶栏或强刷更新`);
        }
      } else {
        if (banner) banner.style.display = 'none';
        if (badge) badge.classList.remove('has-update');
        if (versionText) {
          versionText.textContent = `版本 v${APP_BUILD_ID} · 82道全科考点版`;
        }
        if (isManual) {
          showToast('当前已是最新版本 v' + APP_BUILD_ID);
        }
      }
    } catch (err) {
      console.warn('Update check failed:', err);
      if (versionText) versionText.textContent = `版本 v${APP_BUILD_ID} · 82道全科考点版`;
      if (isManual) showToast('网络未连接或已是最新版');
    }
  }

  async function forceCleanAndReload() {
    const targetVer = (latestUpdatePayload && latestUpdatePayload.version) || APP_BUILD_ID;
    showToast(`正在清除缓存并同步最新 v${targetVer} 资源...`, 3000);
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      sessionStorage.clear();
    } catch (e) {
      console.warn('Cache clear warning:', e);
    }
    const cleanUrl = window.location.origin + window.location.pathname + '?v=' + encodeURIComponent(targetVer) + '&t=' + Date.now();
    setTimeout(() => {
      window.location.href = cleanUrl;
    }, 300);
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
          forceCleanAndReload();
        } else {
          checkAppUpdate(true);
        }
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        forceCleanAndReload();
      });
    }

    if (bannerBody) {
      bannerBody.addEventListener('click', () => {
        forceCleanAndReload();
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
      navigator.serviceWorker.register('./sw.js', { scope: './' }).then((reg) => {
        setInterval(() => {
          reg.update().catch(() => {});
        }, 60 * 1000);

        reg.onupdatefound = () => {
          const installingWorker = reg.installing;
          if (installingWorker) {
            installingWorker.onstatechange = () => {
              if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                console.log('[PWA] 发现并激活新版本 v1.9.8，自动极速重载...');
                window.location.reload();
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
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  }

  function startApp() {
    initElements();
    setupAudioEngine();
    setupEventListeners();
    setupKubaiNavigation();
    loadManifestData();
    setupVersionHandlers();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
  } else {
    startApp();
  }
})();
