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
    reciteMode: 'normal', // 'normal' 或 'loop3'
    loopCount: 0,
    fontSize: 17,
    theme: 'parchment',
    
    // 筛选条件
    tierFilter: 'all',
    scoreFilter: 'all',
    searchQuery: '',
    
    lastUserScrollTime: 0
  };

  const audio = new Audio();
  audio.preload = 'metadata';

  const el = {};

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
  }

  // 加载数据包 (优先调用已嵌入的 window.KAOYAN_MANIFEST，彻底免疫 file:/// 下的 CORS 阻断)
  async function loadManifestData() {
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

    updateBadgeCounts();
    renderFilterPills();
    renderSidebarList();
    
    const defaultList = getCurrentItemsList();
    if (defaultList.length > 0) {
      selectItem(defaultList[0].id);
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
    const c807 = (state.allData.items_807 || []).length;
    const c706 = (state.allData.items_706 || []).length;
    const cEn = (state.allData.items_en || []).length;
    if (el.count807) el.count807.textContent = `${c807}题`;
    if (el.count706) el.count706.textContent = `${c706}题`;
    if (el.countEn) el.countEn.textContent = `${cEn}条`;
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
    
    renderSidebarList();
    const list = getCurrentItemsList();
    if (list.length > 0) {
      selectItem(list[0].id);
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
        if (window.innerWidth <= 900 && el.sidebar) {
          el.sidebar.classList.remove('open');
          if (el.backdrop) el.backdrop.classList.remove('open');
        }
      });

      el.itemList.appendChild(card);
    });
  }

  async function selectItem(itemId, autoPlay = false) {
    const list = getCurrentItemsList();
    const item = list.find(x => x.id === itemId);
    if (!item) return;

    state.activeItemId = itemId;
    state.activeItem = item;
    state.currentSentIndex = -1;
    state.loopCount = 0;

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
    el.stageTopic.textContent = item.topic || (item.author ? `${item.author} 专章` : '核心考点');
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

    await loadTrackData(state.currentTrack, autoPlay);
  }

  async function loadTrackData(trackNum, autoPlay = false) {
    state.currentTrack = trackNum;
    state.currentSentIndex = -1;
    state.loopCount = 0;

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

    // 优先读取内嵌时间戳包，彻底免 fetch 零报错
    let sentences = [];
    const sFile = trackObj ? trackObj.sentences_file.replace(/\\/g, '/') : '';
    if (window.KAOYAN_SENTENCES && window.KAOYAN_SENTENCES[sFile]) {
      sentences = window.KAOYAN_SENTENCES[sFile];
    } else if (sFile) {
      try {
        const res = await fetch(sFile + '?t=' + Date.now());
        if (res.ok) sentences = await res.json();
      } catch (e) {
        console.warn('Sentence timestamps fallback failed:', e);
      }
    }
    state.activeSentences = sentences;

    renderPaperContent(trackObj, sentences);
    buildFrameworkIndex();

    if (trackObj && trackObj.audio) {
      audio.src = trackObj.audio;
      audio.load();
      if (autoPlay) {
        audio.play().catch(e => console.log('Autoplay prevented:', e));
      }
    } else {
      audio.src = '';
    }

    updatePlayBtnUI();
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
    highlightSentence(sentId);
  }

  function highlightSentence(sentId) {
    const sents = document.querySelectorAll('.recite-sent');
    sents.forEach(s => {
      const match = String(s.dataset.sentId) === String(sentId);
      s.classList.toggle('active-spotlight', match);
      if (match) {
        const now = Date.now();
        if (now - state.lastUserScrollTime > 2500) {
          s.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    });
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
      const firstSent = card.querySelector('.recite-sent');
      const start = firstSent ? parseFloat(firstSent.dataset.start || 0) : 0;
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

      const thesisSentEl = card.querySelector('.thesis-sent, .teacher-explain-row .recite-sent, .recite-sent');
      const thesisText = thesisSentEl ? thesisSentEl.textContent.replace(/【[^】]+】/g, '').trim() : '';

      currentFrameworkSections.push({
        index: idx,
        badge: badge,
        desc: desc,
        start: start,
        sentId: sentId,
        cardEl: card,
        thesisSnippet: thesisText.slice(0, 65) + (thesisText.length > 65 ? '...' : '')
      });
    });

    if (currentFrameworkSections.length === 0 && state.activeSentences && state.activeSentences.length > 0) {
      currentFrameworkSections.push({
        index: 0,
        badge: '全文答题展开',
        desc: '核心论述',
        start: 0,
        sentId: state.activeSentences[0].id,
        cardEl: null,
        thesisSnippet: state.activeSentences[0].text
      });
    }

    updateHUDDisplay(audio.currentTime || 0);
    renderOutlineDrawer();
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

      if (activeSecIdx !== currentActiveSectionIndex) {
        currentActiveSectionIndex = activeSecIdx;
        const sec = currentFrameworkSections[activeSecIdx];
        const total = currentFrameworkSections.length;
        
        if (el.hudFrameworkText) {
          el.hudFrameworkText.textContent = `框架 [${sec.index + 1}/${total}] · ${sec.badge}`;
        }

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
      if (el.hudFrameworkText) el.hudFrameworkText.textContent = '整篇答题';
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
            <span class="outline-node-badge">${sec.badge}</span>
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
      el.outlineDrawer.setAttribute('aria-hidden', 'false');
    }
    if (el.outlineDrawerBackdrop) {
      el.outlineDrawerBackdrop.style.display = 'block';
    }
  }

  function closeOutlineDrawer() {
    if (el.outlineDrawer) {
      el.outlineDrawer.classList.remove('open');
      el.outlineDrawer.setAttribute('aria-hidden', 'true');
    }
    if (el.outlineDrawerBackdrop) {
      el.outlineDrawerBackdrop.style.display = 'none';
    }
  }

  function setupAudioEngine() {
    audio.addEventListener('play', () => {
      state.isPlaying = true;
      updatePlayBtnUI();
    });

    audio.addEventListener('pause', () => {
      state.isPlaying = false;
      updatePlayBtnUI();
    });

    audio.addEventListener('timeupdate', () => {
      const cur = audio.currentTime;
      const dur = audio.duration || 0;

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
          const sent = state.activeSentences[activeIdx];
          highlightSentence(sent.id);
        }

        if (state.reciteMode === 'loop3' && state.currentSentIndex !== -1) {
          const sent = state.activeSentences[state.currentSentIndex];
          if (cur >= sent.end - 0.08) {
            if (state.loopCount < 2) {
              state.loopCount++;
              audio.currentTime = sent.start;
            } else {
              state.loopCount = 0;
            }
          }
        }
      }
    });

    audio.addEventListener('ended', () => {
      state.isPlaying = false;
      updatePlayBtnUI();
      playNextItem();
    });

    audio.addEventListener('loadedmetadata', () => {
      if (el.timeTotal) el.timeTotal.textContent = formatTime(audio.duration || 0);
    });
  }

  function updatePlayBtnUI() {
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
    if (el.outlineDrawerBackdrop) {
      el.outlineDrawerBackdrop.addEventListener('click', closeOutlineDrawer);
    }
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el.outlineDrawer && el.outlineDrawer.classList.contains('open')) {
        closeOutlineDrawer();
      }
    });

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
      const handleSeek = (e) => {
        const rect = el.progressBar.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        if (audio.duration) {
          audio.currentTime = pos * audio.duration;
        }
      };

      el.progressBar.addEventListener('click', handleSeek);
    }

    // 倍速调节
    const speeds = [1.0, 1.2, 1.5, 0.8];
    let speedIdx = 0;
    if (el.speedBtn) {
      el.speedBtn.addEventListener('click', () => {
        speedIdx = (speedIdx + 1) % speeds.length;
        state.speed = speeds[speedIdx];
        audio.playbackRate = state.speed;
        el.speedBtn.querySelector('span').textContent = `${state.speed.toFixed(1)}x`;
      });
    }

    // 单句循环模式
    if (el.loopModeBtn) {
      el.loopModeBtn.addEventListener('click', () => {
        if (state.reciteMode === 'normal') {
          state.reciteMode = 'loop3';
          state.loopCount = 0;
          el.loopModeBtn.classList.add('active');
          el.loopModeBtn.title = "当前：单句循环3遍（点击切回正常播放）";
          el.loopModeBtn.querySelector('.mode-text').textContent = "句循3";
        } else {
          state.reciteMode = 'normal';
          state.loopCount = 0;
          el.loopModeBtn.classList.remove('active');
          el.loopModeBtn.title = "当前：全篇顺序播放（点击开启单句循环3遍）";
          el.loopModeBtn.querySelector('.mode-text').textContent = "单循";
        }
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

    // 字体切换体系
    const fontFamilies = [
      { id: 'song', name: '雅宋', value: '"Noto Serif SC", "Source Han Serif SC", SimSun, serif' },
      { id: 'kai', name: '温楷', value: '"LXGW WenKai Screen", "LXGW WenKai", "Kaiti SC", KaiTi, serif' },
      { id: 'hei', name: '精黑', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif' },
      { id: 'fangsong', name: '仿宋', value: 'FangSong, "FangSong SC", "STFangsong", serif' }
    ];
    let fontIdx = 0;
    const fontSwitchBtn = document.getElementById('btn-font-switch');
    const fontNameLabel = document.getElementById('font-current-name');

    const savedFont = localStorage.getItem('kaoyan_font_family');
    if (savedFont) {
      const idx = fontFamilies.findIndex(f => f.id === savedFont);
      if (idx !== -1) {
        fontIdx = idx;
        document.documentElement.style.setProperty('--font-content', fontFamilies[fontIdx].value);
        if (fontNameLabel) fontNameLabel.textContent = fontFamilies[fontIdx].name;
      }
    }

    if (fontSwitchBtn) {
      fontSwitchBtn.addEventListener('click', () => {
        fontIdx = (fontIdx + 1) % fontFamilies.length;
        const curFont = fontFamilies[fontIdx];
        document.documentElement.style.setProperty('--font-content', curFont.value);
        if (fontNameLabel) fontNameLabel.textContent = curFont.name;
        localStorage.setItem('kaoyan_font_family', curFont.id);
      });
    }

    // 移动端抽屉菜单
    if (el.mobileMenuBtn && el.sidebar) {
      el.mobileMenuBtn.addEventListener('click', () => {
        el.sidebar.classList.toggle('open');
        if (el.backdrop) el.backdrop.classList.toggle('open');
      });
    }

    if (el.backdrop && el.sidebar) {
      el.backdrop.addEventListener('click', () => {
        el.sidebar.classList.remove('open');
        el.backdrop.classList.remove('open');
      });
    }

    // 监听正文区域用户手动滚动，短时间内不强制打断滚动视图
    if (el.paperContent) {
      el.paperContent.addEventListener('scroll', () => {
        state.lastUserScrollTime = Date.now();
      }, { passive: true });
    }

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
  }

  // ==========================================
  // PWA 自动热更新与版本检视服务
  // ==========================================
  const APP_BUILD_ID = '1.7.1';
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
  document.addEventListener('DOMContentLoaded', () => {
    initElements();
    setupAudioEngine();
    setupEventListeners();
    loadManifestData();
    setupVersionHandlers();
  });
})();
