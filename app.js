/**
 * 2027 考研专业课双轨随身背诵手卷 · 核心交互引擎 (独立专研版)
 * 支持纯本地离线 (ZERO-CORS) 瞬时加载与全量 72 音轨毫秒级点读对齐
 */

(function () {
  'use strict';

  const state = {
    allData: null,
    currentSubject: '807',
    currentTrack: 1, // 1: 考场直接答题完整版, 2: 答题版内部逻辑精解版
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
    el.count807 = document.getElementById('count-807');
    el.count706 = document.getElementById('count-706');
    el.searchInput = document.getElementById('search-input');
    el.itemList = document.getElementById('item-list');
    
    el.questionTitle = document.getElementById('stage-title');
    el.stageSubject = document.getElementById('stage-subject');
    el.stageTopic = document.getElementById('stage-topic');
    el.stageScore = document.getElementById('stage-score');
    el.stageTier = document.getElementById('stage-tier');
    
    el.tabTrack1 = document.getElementById('tab-track-1');
    el.tabTrack2 = document.getElementById('tab-track-2');
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
    el.tierPills = document.querySelectorAll('.filter-pill[data-tier]');
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
    renderSidebarList();
    
    const defaultList = getCurrentItemsList();
    if (defaultList.length > 0) {
      selectItem(defaultList[0].id);
    }
  }

  function getCurrentItemsList() {
    if (!state.allData) return [];
    const rawList = state.currentSubject === '807' ? state.allData.items_807 : state.allData.items_706;
    if (!rawList) return [];

    return rawList.filter(item => {
      if (state.tierFilter !== 'all' && item.level !== state.tierFilter) return false;
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
    if (el.count807) el.count807.textContent = `${c807}题`;
    if (el.count706) el.count706.textContent = `${c706}题`;
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
        ? `<span class="card-audio-status has-audio" title="龙安朗全段通读已就绪">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
               <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
               <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
             </svg>
             通读
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
    el.stageSubject.textContent = state.currentSubject === '807' ? '807 现当代文学' : '706 古代文学';
    el.stageTopic.textContent = item.author ? `${item.author} 专章` : '核心考点';
    el.stageScore.textContent = item.score;
    el.stageTier.textContent = item.level;
    el.stageTier.className = `tier-badge tier-${item.level}`;

    if (el.dockTitle) el.dockTitle.textContent = item.title;
    if (el.dockTrackPill) el.dockTrackPill.textContent = state.currentTrack === 1 ? '考场直接答题完整版' : '答题版内部逻辑精解版';

    await loadTrackData(state.currentTrack, autoPlay);
  }

  async function loadTrackData(trackNum, autoPlay = false) {
    state.currentTrack = trackNum;
    state.currentSentIndex = -1;
    state.loopCount = 0;

    if (el.tabTrack1) el.tabTrack1.classList.toggle('active', trackNum === 1);
    if (el.tabTrack2) el.tabTrack2.classList.toggle('active', trackNum === 2);
    if (el.dockTrackPill) el.dockTrackPill.textContent = trackNum === 1 ? '考场直接答题完整版' : '答题版内部逻辑精解版';

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
          const sentId = parseInt(s.dataset.sentId, 10);
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
      const match = parseInt(s.dataset.sentId, 10) === sentId;
      s.classList.toggle('active-spotlight', match);
      if (match) {
        const now = Date.now();
        if (now - state.lastUserScrollTime > 2500) {
          s.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    });
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
    el.subject807Btn.addEventListener('click', () => {
      if (state.currentSubject === '807') return;
      state.currentSubject = '807';
      el.subject807Btn.classList.add('active');
      el.subject706Btn.classList.remove('active');
      renderSidebarList();
      const list = getCurrentItemsList();
      if (list.length > 0) selectItem(list[0].id);
    });

    el.subject706Btn.addEventListener('click', () => {
      if (state.currentSubject === '706') return;
      state.currentSubject = '706';
      el.subject706Btn.classList.add('active');
      el.subject807Btn.classList.remove('active');
      renderSidebarList();
      const list = getCurrentItemsList();
      if (list.length > 0) selectItem(list[0].id);
    });

    el.searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value.trim();
      renderSidebarList();
    });

    el.tierPills.forEach(pill => {
      pill.addEventListener('click', () => {
        el.tierPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.tierFilter = pill.dataset.tier;
        renderSidebarList();
      });
    });

    el.tabTrack1.addEventListener('click', () => {
      if (state.currentTrack === 1) return;
      loadTrackData(1, state.isPlaying);
    });

    el.tabTrack2.addEventListener('click', () => {
      if (state.currentTrack === 2) return;
      loadTrackData(2, state.isPlaying);
    });

    el.playBtn.addEventListener('click', () => {
      if (audio.paused) {
        if (!audio.src) {
          loadTrackData(state.currentTrack, true);
        } else {
          audio.play().catch(e => console.log(e));
        }
      } else {
        audio.pause();
      }
    });

    el.prevBtn.addEventListener('click', playPrevItem);
    el.nextBtn.addEventListener('click', playNextItem);

    el.rewindBtn.addEventListener('click', () => {
      audio.currentTime = Math.max(0, audio.currentTime - 5);
    });

    el.forwardBtn.addEventListener('click', () => {
      audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
    });

    if (el.progressBar) {
      el.progressBar.addEventListener('click', (e) => {
        const rect = el.progressBar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        if (audio.duration) {
          audio.currentTime = ratio * audio.duration;
        }
      });
    }

    const speeds = [0.85, 1.0, 1.15, 1.25, 1.5];
    let speedIdx = 1;
    el.speedBtn.addEventListener('click', () => {
      speedIdx = (speedIdx + 1) % speeds.length;
      state.speed = speeds[speedIdx];
      audio.playbackRate = state.speed;
      el.speedBtn.textContent = `${state.speed}x`;
    });

    el.loopModeBtn.addEventListener('click', () => {
      if (state.reciteMode === 'normal') {
        state.reciteMode = 'loop3';
        state.loopCount = 0;
        el.loopModeBtn.classList.add('active');
        el.loopModeBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="17 1 21 5 17 9"></polyline>
            <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
            <polyline points="7 23 3 19 7 15"></polyline>
            <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
          </svg>
          三遍循环`;
      } else {
        state.reciteMode = 'normal';
        state.loopCount = 0;
        el.loopModeBtn.classList.remove('active');
        el.loopModeBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="17 1 21 5 17 9"></polyline>
            <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
            <polyline points="7 23 3 19 7 15"></polyline>
            <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
          </svg>
          全篇顺读`;
      }
    });

    el.themeToggleBtn.addEventListener('click', () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const newTheme = isDark ? 'parchment' : 'dark';
      document.documentElement.setAttribute('data-theme', isDark ? '' : 'dark');
      localStorage.setItem('kaoyan_theme_pro', newTheme);
    });

    el.fontIncBtn.addEventListener('click', () => {
      if (state.fontSize < 24) {
        state.fontSize += 1;
        document.documentElement.style.setProperty('--font-base', `${state.fontSize}px`);
      }
    });

    el.fontDecBtn.addEventListener('click', () => {
      if (state.fontSize > 14) {
        state.fontSize -= 1;
        document.documentElement.style.setProperty('--font-base', `${state.fontSize}px`);
      }
    });

    if (el.mobileMenuBtn && el.sidebar) {
      el.mobileMenuBtn.addEventListener('click', () => {
        const isOpen = el.sidebar.classList.toggle('open');
        if (el.backdrop) el.backdrop.classList.toggle('open', isOpen);
      });
    }

    if (el.backdrop && el.sidebar) {
      el.backdrop.addEventListener('click', () => {
        el.sidebar.classList.remove('open');
        el.backdrop.classList.remove('open');
      });
    }

    const stage = document.querySelector('.main-stage');
    if (stage) {
      stage.addEventListener('scroll', () => {
        state.lastUserScrollTime = Date.now();
      }, { passive: true });
    }
  }

  
  // 多样化字体切换体系
  const FONT_OPTIONS = [
    { id: 'song', name: '雅宋', title: '文人雅宋 (默认)' },
    { id: 'kai', name: '温楷', title: '霞鹜温楷' },
    { id: 'sans', name: '精黑', title: '现代精黑' },
    { id: 'fangsong', name: '仿宋', title: '典雅仿宋' }
  ];
  let currentFontIdx = 0;

  function initFontSystem() {
    el.fontSwitchBtn = document.getElementById('btn-font-switch');
    el.fontCurrentName = document.getElementById('font-current-name');
    
    const saved = localStorage.getItem('kaoyan_font_choice') || 'song';
    const foundIdx = FONT_OPTIONS.findIndex(f => f.id === saved);
    currentFontIdx = foundIdx >= 0 ? foundIdx : 0;
    applyFont(FONT_OPTIONS[currentFontIdx].id);

    if (el.fontSwitchBtn) {
      el.fontSwitchBtn.addEventListener('click', () => {
        currentFontIdx = (currentFontIdx + 1) % FONT_OPTIONS.length;
        applyFont(FONT_OPTIONS[currentFontIdx].id);
      });
    }
  }

  function applyFont(fontId) {
    document.documentElement.setAttribute('data-font', fontId);
    localStorage.setItem('kaoyan_font_choice', fontId);
    if (el.fontCurrentName) {
      const opt = FONT_OPTIONS.find(f => f.id === fontId);
      if (opt) el.fontCurrentName.textContent = opt.name;
    }
  }


  
  // ==========================================
  // 云端版本检测与一键强刷更新机制
  // ==========================================
  const APP_BUILD_ID = '1.1.0';
  let latestUpdatePayload = null;

  function showToast(msg, duration = 2500) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, duration);
  }

  function compareVersions(v1, v2) {
    const p1 = (v1 || '').replace(/^v/, '').split('.').map(Number);
    const p2 = (v2 || '').replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const n1 = p1[i] || 0;
      const n2 = p2[i] || 0;
      if (n1 > n2) return 1;
      if (n1 < n2) return -1;
    }
    return 0;
  }

  async function checkAppUpdate(isManual = false) {
    const badge = document.getElementById('appVersionBadge');
    const versionText = document.getElementById('versionText');
    const banner = document.getElementById('updateBannerPill');
    const bannerText = document.getElementById('updateBannerText');

    if (isManual) {
      showToast('正在检查云端更新…');
      if (versionText) versionText.textContent = '正在检查更新…';
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
        if (banner && bannerText && !isDismissed) {
          bannerText.textContent = `发现新版本 v${remoteVer} · 点击立即更新`;
          banner.style.display = 'flex';
        }
        if (versionText) {
          versionText.textContent = `发现新版 v${remoteVer} · 点击更新`;
        }
        if (badge) {
          badge.classList.add('has-update');
        }
        if (isManual) {
          showToast(`发现新版本 v${remoteVer}，请点击升级！`);
        }
      } else {
        if (banner) banner.style.display = 'none';
        if (badge) badge.classList.remove('has-update');
        if (versionText) {
          versionText.textContent = `版本 v${APP_BUILD_ID} · 双轨研读版`;
        }
        if (isManual) {
          showToast('已是最新版本 v' + APP_BUILD_ID);
        }
      }
    } catch (err) {
      console.warn('Update check failed:', err);
      if (versionText) versionText.textContent = `版本 v${APP_BUILD_ID} · 双轨研读版`;
      if (isManual) showToast('当前已是最新版本');
    }
  }

  function applyAppUpdate() {
    showToast('正在强制更新至最新版本…');
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(regs => {
        for (let reg of regs) {
          reg.unregister();
        }
      }).catch(() => {});
    }
    if ('caches' in window) {
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).catch(() => {});
    }
    setTimeout(() => {
      window.location.replace(window.location.pathname + '?v=' + Date.now());
    }, 400);
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
          applyAppUpdate();
        } else {
          checkAppUpdate(true);
        }
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        applyAppUpdate();
      });
    }

    if (bannerBody) {
      bannerBody.addEventListener('click', () => {
        applyAppUpdate();
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

    // 页面加载 1.5 秒后静默检查云端版本
    setTimeout(() => {
      checkAppUpdate(false);
    }, 1500);
  }

  window.addEventListener('DOMContentLoaded', () => {
    initElements();
    setupAudioEngine();
    setupEventListeners();
    
    const savedTheme = localStorage.getItem('kaoyan_theme_pro');
    if (savedTheme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }

    initFontSystem();
    loadManifestData();
    setupVersionHandlers();
  });
})();
