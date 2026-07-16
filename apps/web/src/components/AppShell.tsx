import { useEffect, useRef, useState } from "react";
import {
  Activity,
  BadgeCheck,
  BookOpenText,
  Bot,
  ChevronRight,
  CircleHelp,
  FilePlus2,
  Gauge,
  Menu,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useOnboarding } from "../contexts/OnboardingContext";

interface NavigationItem {
  readonly badge?: boolean;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly to: string;
}

interface NavigationGroup {
  readonly items: readonly NavigationItem[];
  readonly label: string;
}

const NAVIGATION: readonly NavigationGroup[] = [
  {
    label: "知识运营",
    items: [
      { icon: Gauge, label: "总览", to: "/" },
      { icon: BookOpenText, label: "知识库", to: "/knowledge" },
      { icon: FilePlus2, label: "贡献知识", to: "/contribute" },
    ],
  },
  {
    label: "质量与治理",
    items: [
      { icon: BadgeCheck, label: "审核中心", to: "/review", badge: true },
      { icon: ShieldCheck, label: "发布治理", to: "/governance" },
      { icon: Activity, label: "效果证据", to: "/evaluation" },
    ],
  },
  {
    label: "平台",
    items: [
      { icon: Bot, label: "Agent 接入", to: "/agents" },
      { icon: Settings, label: "平台设置", to: "/settings" },
    ],
  },
];

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState("");
  const globalSearch = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const onboarding = useOnboarding();
  const currentItem = NAVIGATION
    .flatMap((group) => group.items)
    .find((item) => item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to));
  const submitSearch = () => {
    const value = search.trim();
    if (value.length === 0) return;
    navigate(`/knowledge?q=${encodeURIComponent(value)}`);
    setMobileOpen(false);
  };

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const focusGlobalSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        globalSearch.current?.focus();
      }
      if (event.key === "Escape" && mobileOpen) setMobileOpen(false);
    };
    if (mobileOpen) document.body.style.overflow = "hidden";
    window.addEventListener("keydown", focusGlobalSearch);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", focusGlobalSearch);
    };
  }, [mobileOpen]);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`} id="primary-sidebar">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            <Sparkles size={19} />
          </div>
          <div>
            <strong>KnowledgeOS</strong>
            <span>Agent Knowledge Platform</span>
          </div>
          <button
            className="icon-button sidebar-close"
            aria-label="关闭导航"
            onClick={() => setMobileOpen(false)}
          >
            <X size={20} />
          </button>
        </div>

        <div className="workspace-switcher">
          <div className="workspace-avatar">AK</div>
          <div>
            <strong>Agent Knowledge</strong>
            <span>本地开发空间</span>
          </div>
          <span className="workspace-status">LOCAL</span>
        </div>

        <nav className="primary-nav" aria-label="主要导航">
          {NAVIGATION.map((group) => (
            <div className="nav-group" key={group.label}>
              <p className="nav-label">{group.label}</p>
              {group.items.map((item) => (
                <NavLink
                  className={({ isActive }) => `nav-item ${isActive ? "nav-item-active" : ""}`}
                  end={item.to === "/"}
                  key={item.to}
                  onClick={() => setMobileOpen(false)}
                  to={item.to}
                >
                  <item.icon size={19} aria-hidden="true" />
                  <span>{item.label}</span>
                  {item.badge ? <span className="nav-dot" aria-label="有待处理内容" /> : null}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button className="help-card" onClick={onboarding.open}>
            <span className="help-icon"><CircleHelp size={18} /></span>
            <span>
              <strong>新手任务</strong>
              <small>{onboarding.completed.length}/5 已完成</small>
            </span>
            <span className="help-progress" aria-hidden="true">
              <i style={{ width: `${onboarding.completed.length * 20}%` }} />
            </span>
          </button>
          <div className="user-row">
            <div className="user-avatar">MO</div>
            <div>
              <strong>本地管理员</strong>
              <span>Development</span>
            </div>
          </div>
        </div>
      </aside>

      {mobileOpen ? (
        <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />
      ) : null}

      <div className="main-column">
        <header className="topbar">
          <button aria-controls="primary-sidebar" aria-expanded={mobileOpen} className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setMobileOpen(true)}>
            <Menu size={21} />
          </button>
          <div className="topbar-context" aria-label="当前位置">
            <span>Agent Knowledge</span>
            <ChevronRight size={14} aria-hidden="true" />
            <strong>{currentItem?.label ?? "工作台"}</strong>
          </div>
          <form
            className="global-search"
            onSubmit={(event) => {
              event.preventDefault();
              submitSearch();
            }}
          >
            <Search size={18} aria-hidden="true" />
            <input
              aria-label="全局搜索知识"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索知识、版本或来源…"
              ref={globalSearch}
              value={search}
            />
            <kbd>⌘ K</kbd>
          </form>
          <div className="topbar-actions">
            <span className="environment-pill"><i /> 开发环境</span>
            <button className="icon-button" aria-label="打开新手引导" onClick={onboarding.open}>
              <CircleHelp size={20} />
            </button>
          </div>
        </header>
        <main className="page-content" key={location.pathname}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
