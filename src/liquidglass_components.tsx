import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { Glass, TabBar, Button, SegmentedControl } from "@onlymoein/liquidglass";

// 内联纯 SVG 图标，严格遵守无外部字体库规范
const Icons = {
  Menu: () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  ),
  Theme: () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  ),
  Book: () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  ),
  Eye: () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  Play: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  ),
  Pause: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  ),
  Chart: () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  ),
  Gear: () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
};

// 1. 顶部液态玻璃导航栏组件 (Floating Liquid Pill Bar)
export function LiquidHeader() {
  const [activeSubject, setActiveSubject] = useState("807");

  // 同步原生科目选择状态
  useEffect(() => {
    const checkSubject = () => {
      const btn807 = document.getElementById("btn-subject-807");
      const btn706 = document.getElementById("btn-subject-706");
      const btnEn = document.getElementById("btn-subject-en");

      if (btn706?.classList.contains("active")) {
        setActiveSubject("706");
      } else if (btnEn?.classList.contains("active")) {
        setActiveSubject("en");
      } else {
        setActiveSubject("807");
      }
    };

    checkSubject();
    const timer = setInterval(checkSubject, 300);
    return () => clearInterval(timer);
  }, []);

  const handleSubjectChange = (val: string) => {
    setActiveSubject(val);
    const targetId = val === "706" ? "btn-subject-706" : val === "en" ? "btn-subject-en" : "btn-subject-807";
    document.getElementById(targetId)?.click();
  };

  const openDrawer = () => {
    const menuBtn = document.getElementById("btn-mobile-menu");
    if (menuBtn) {
      menuBtn.click();
    } else {
      document.querySelector(".sidebar")?.classList.add("open");
      document.querySelector(".sidebar-backdrop")?.classList.add("open");
    }
  };

  const toggleTheme = () => {
    document.getElementById("btn-theme-toggle")?.click();
  };

  return (
    <header className="liquid-floating-header">
      <Glass className="liquid-header-pill">
        {/* 左端：目录按钮 */}
        <Button
          variant="glass"
          size="small"
          className="liquid-nav-btn"
          onClick={openDrawer}
          icon={<Icons.Menu />}
        >
          <span className="liquid-btn-text">目录</span>
        </Button>

        {/* 中间：SegmentedControl 物理滑动透镜科目组 */}
        <div className="liquid-subject-segmented-wrap">
          <SegmentedControl
            value={activeSubject}
            onValueChange={handleSubjectChange}
            items={[
              { value: "807", label: "807 现当代" },
              { value: "706", label: "706 古代" },
              { value: "en", label: "英语写作" }
            ]}
          />
        </div>

        {/* 右端：夜间模式切换 */}
        <Button
          variant="glass"
          size="small"
          className="liquid-nav-btn liquid-theme-btn"
          onClick={toggleTheme}
          icon={<Icons.Theme />}
          aria-label="切换主题"
        />
      </Glass>
    </header>
  );
}

// 2. 底部液态玻璃 TabBar 组件 (真实动态物理透镜)
export function LiquidTabBar() {
  const [activeTab, setActiveTab] = useState<string>("catalog");
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  useEffect(() => {
    const syncState = () => {
      const audio = document.getElementById("global-audio") as HTMLAudioElement | null;
      if (audio) {
        setIsPlaying(!audio.paused && !audio.ended);
      }
    };
    syncState();
    const timer = setInterval(syncState, 500);
    return () => clearInterval(timer);
  }, []);

  const handleTabChange = (val: string) => {
    setActiveTab(val);
    if (val === "catalog") {
      document.getElementById("btn-mobile-menu")?.click();
    } else if (val === "practice") {
      document.getElementById("btn-cloze-mode")?.click();
    } else if (val === "play") {
      const playBtn = document.getElementById("btn-play-toggle");
      playBtn?.click();
    } else if (val === "dashboard") {
      document.getElementById("btn-study-dashboard")?.click();
    } else if (val === "settings") {
      document.getElementById("btn-settings-toggle")?.click() || document.getElementById("nav-item-settings")?.click();
    }
  };

  return (
    <div className="liquid-tabbar-container" data-liquidglass-tabbar>
      <TabBar
        value={activeTab}
        onValueChange={handleTabChange}
        items={[
          { value: "catalog", label: "题库", icon: <Icons.Book /> },
          { value: "practice", label: "自测", icon: <Icons.Eye /> },
          { value: "play", label: isPlaying ? "暂停" : "播放", icon: isPlaying ? <Icons.Pause /> : <Icons.Play /> },
          { value: "dashboard", label: "看板", icon: <Icons.Chart /> },
          { value: "settings", label: "设置", icon: <Icons.Gear /> }
        ]}
      />
    </div>
  );
}

// 自动挂载并接管页面
export function initLiquidGlassApp() {
  console.log("⚡ 初始化 @onlymoein/liquidglass 官方驱动引擎...");

  // 1. 挂载顶部导航栏
  let headerRootEl = document.getElementById("liquid-glass-header-root");
  if (!headerRootEl) {
    headerRootEl = document.createElement("div");
    headerRootEl.id = "liquid-glass-header-root";
    const existingHeader = document.querySelector(".app-header");
    if (existingHeader && existingHeader.parentNode) {
      existingHeader.parentNode.insertBefore(headerRootEl, existingHeader);
      // 隐藏原生旧顶栏
      (existingHeader as HTMLElement).style.display = "none";
    } else {
      document.body.prepend(headerRootEl);
    }
  }

  const headerRoot = ReactDOM.createRoot(headerRootEl);
  headerRoot.render(<LiquidHeader />);

  // 2. 挂载底部 TabBar
  let tabbarRootEl = document.getElementById("liquid-glass-tabbar-root");
  if (!tabbarRootEl) {
    tabbarRootEl = document.createElement("div");
    tabbarRootEl.id = "liquid-glass-tabbar-root";
    const existingBottomNav = document.getElementById("app-bottom-nav");
    if (existingBottomNav && existingBottomNav.parentNode) {
      existingBottomNav.parentNode.insertBefore(tabbarRootEl, existingBottomNav);
      // 隐藏原生旧底栏
      (existingBottomNav as HTMLElement).style.display = "none";
    } else {
      document.body.appendChild(tabbarRootEl);
    }
  }

  const tabbarRoot = ReactDOM.createRoot(tabbarRootEl);
  tabbarRoot.render(<LiquidTabBar />);

  console.log("✅ @onlymoein/liquidglass Header & TabBar 挂载成功！");
}

if (typeof window !== "undefined") {
  (window as any).initLiquidGlassApp = initLiquidGlassApp;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initLiquidGlassApp);
  } else {
    initLiquidGlassApp();
  }
}
