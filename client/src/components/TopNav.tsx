import { BRAND_LOGOS, SURE_PLUS_LOGO, SURE_PLUS_URL } from "@/config/brand";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useSection } from "@/contexts/SectionContext";
import { useAiChat } from "@/contexts/AiChatContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { cn } from "@/lib/utils";
import { SECTIONS } from "@shared/const";
import {
  AlertTriangle,
  Banknote,
  BookOpen,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu as MenuIcon,
  Receipt,
  Settings,
  Shield,
  TrendingDown,
  Users,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";

type MenuCode =
  | "contract"
  | "debt_overview"
  | "debt_report"
  | "suspected_bad_debt"
  | "bad_debt_summary"
  | "monthly_summary"
  | "income"
  | "expense"
  | "settings_users"
  | "settings_groups"
  | "stock_sure_plus";

type NavLeaf = {
  kind: "leaf";
  label: string;
  path: string;
  icon: typeof FileText;
  menuCode: MenuCode;
};

type NavGroup = {
  kind: "group";
  label: string;
  icon: typeof FileText;
  childCodes: MenuCode[];
  children: NavLeaf[];
};

/** External link nav item — opens in new tab, not a router path */
type NavExternal = {
  kind: "external";
  label: string;
  url: string;
  logo?: string; // image src (optional, falls back to icon)
  icon: typeof FileText;
  menuCode: MenuCode;
  /** Only show when section matches one of these values */
  onlySections?: string[];
};

type NavEntry = NavLeaf | NavGroup | NavExternal;

const MAIN_NAV: NavEntry[] = [
  {
    kind: "leaf",
    label: "สัญญา",
    path: "/contracts",
    icon: FileText,
    menuCode: "contract",
  },
  {
    kind: "group",
    label: "รายงานหนี้",
    icon: Banknote,
    childCodes: ["debt_overview", "debt_report", "suspected_bad_debt", "bad_debt_summary", "monthly_summary"],
    children: [
      { kind: "leaf", label: "สรุปภาพรวม", path: "/debt-overview", icon: LayoutDashboard, menuCode: "debt_overview" },
      { kind: "leaf", label: "สรุปรายเดือน", path: "/monthly-summary", icon: CalendarDays, menuCode: "monthly_summary" },
      { kind: "leaf", label: "เป้า-ยอดเก็บ", path: "/debt-report", icon: Banknote, menuCode: "debt_report" },
      { kind: "leaf", label: "หนี้สงสัยจะเสีย", path: "/suspected-bad-debt", icon: AlertTriangle, menuCode: "suspected_bad_debt" },
      { kind: "leaf", label: "หนี้เสีย", path: "/bad-debt-summary", icon: TrendingDown, menuCode: "bad_debt_summary" },
    ],
  },
  {
    kind: "group",
    label: "บัญชี",
    icon: BookOpen,
    childCodes: ["income", "expense"],
    children: [
      { kind: "leaf", label: "รายรับ", path: "/income", icon: Receipt, menuCode: "income" },
      { kind: "leaf", label: "รายจ่าย", path: "/expense", icon: TrendingDown, menuCode: "expense" },
    ],
  },
  {
    kind: "external",
    label: "Stock Sure+",
    url: SURE_PLUS_URL,
    logo: SURE_PLUS_LOGO,
    icon: ExternalLink,
    menuCode: "stock_sure_plus",
    onlySections: ["Boonphone"],
  },
];

const SETTINGS_NAV: NavLeaf[] = [
  { kind: "leaf", label: "จัดการผู้ใช้งาน", path: "/settings/users", icon: Users, menuCode: "settings_users" },
  { kind: "leaf", label: "จัดการสิทธิ์", path: "/settings/groups", icon: Shield, menuCode: "settings_groups" },
];

function AiChatIcon({ active, section }: { active: boolean; section: string | null }) {
  const isBoon = !section || section === "Boonphone";
  const gradId = isBoon ? "aiGradBoon" : "aiGradFast";
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"
      className={cn("w-[18px] h-[18px]", active ? "" : "animate-ai-sparkle")} aria-hidden="true">
      <defs>
        {isBoon ? (
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#F03E7B" /><stop offset="60%" stopColor="#FF6BA8" /><stop offset="100%" stopColor="#FFD700" />
          </linearGradient>
        ) : (
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#F5A623" /><stop offset="60%" stopColor="#F07A1A" /><stop offset="100%" stopColor="#E8621A" />
          </linearGradient>
        )}
      </defs>
      <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z" fill={`url(#${gradId})`} />
      <path d="M19 3l.75 2.25L22 6l-2.25.75L19 9l-.75-2.25L16 6l2.25-.75L19 3z" fill={`url(#${gradId})`} opacity="0.8" />
      <path d="M5 15l.6 1.8L7.4 17.4l-1.8.6L5 20l-.6-1.8L2.6 17.4l1.8-.6L5 15z" fill={`url(#${gradId})`} opacity="0.6" />
    </svg>
  );
}

function DesktopGroupMenu({ entry, location }: { entry: NavGroup; location: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { can } = useAppAuth();
  const visibleChildren = entry.children.filter((c) => can(c.menuCode, "view"));
  if (visibleChildren.length === 0) return null;
  const isActive = visibleChildren.some((c) => location.startsWith(c.path));
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  useEffect(() => { setOpen(false); }, [location]);
  const GroupIcon = entry.icon;
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)}
        className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
          isActive || open ? "bg-blue-50 text-blue-700" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900")}>
        <GroupIcon className="w-4 h-4" />
        {entry.label}
        <ChevronDown className={cn("w-3.5 h-3.5 transition-transform duration-150", open ? "rotate-180" : "")} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-44 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
          {visibleChildren.map((child) => {
            const ChildIcon = child.icon;
            const childActive = location.startsWith(child.path);
            return (
              <Link key={child.path} href={child.path} onClick={() => setOpen(false)}
                className={cn("flex items-center gap-2 px-3 py-2 text-sm",
                  childActive ? "bg-blue-50 text-blue-700 font-medium" : "text-gray-700 hover:bg-gray-50")}>
                <ChildIcon className="w-3.5 h-3.5 flex-shrink-0" />
                {child.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TopNav() {
  const { me, can, logout } = useAppAuth();
  const { section, setSection, clearSection } = useSection();
  const { actions } = useNavActions();
  const { aiChatOpen, toggleAiChat } = useAiChat();
  const [location, navigate] = useLocation();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sectionMenuOpen, setSectionMenuOpen] = useState(false);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState<Set<string>>(() => {
    // auto-expand group ที่ active ตาม path ปัจจุบัน
    const init = new Set<string>();
    for (const entry of MAIN_NAV) {
      if (entry.kind === "group" && entry.children.some((c) => window.location.pathname.startsWith(c.path))) {
        init.add(entry.label);
      }
    }
    return init;
  });
  const userMenuRef = useRef<HTMLDivElement>(null);
  const sectionMenuRef = useRef<HTMLDivElement>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!userMenuRef.current?.contains(e.target as Node)) setUserMenuOpen(false);
      if (!sectionMenuRef.current?.contains(e.target as Node)) setSectionMenuOpen(false);
      if (!settingsMenuRef.current?.contains(e.target as Node)) setSettingsMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  useEffect(() => { setSettingsMenuOpen(false); }, [location]);
  // sync mobile expanded groups เมื่อ location เปลี่ยน (เช่น navigate จาก desktop)
  useEffect(() => {
    setMobileExpanded((prev) => {
      const next = new Set(prev);
      for (const entry of MAIN_NAV) {
        if (entry.kind === "group" && entry.children.some((c) => location.startsWith(c.path))) {
          next.add(entry.label);
        }
      }
      return next;
    });
  }, [location]);
  const canSwitchSection = can("section_switch", "view");
  const visibleSettings = SETTINGS_NAV.filter((item) => can(item.menuCode, "view"));
  const settingsActive = visibleSettings.some((item) => location.startsWith(item.path));
  const rawAllowed = (me?.group as { allowedSections?: string } | undefined)?.allowedSections ?? "";
  const allowedSectionsList: typeof SECTIONS[number][] = rawAllowed
    ? (rawAllowed.split(",").map((s) => s.trim()).filter((s) => SECTIONS.includes(s as typeof SECTIONS[number])) as typeof SECTIONS[number][])
    : [...SECTIONS];
  const handleLogout = async () => {
    try {
      await logout();
      toast.success("ออกจากระบบแล้ว");
      clearSection();
      window.location.href = "/login";
    } catch {
      toast.error("ออกจากระบบไม่สำเร็จ");
    }
  };
  const handleSwitchToSection = (target: typeof SECTIONS[number]) => {
    setSectionMenuOpen(false);
    setMobileMenuOpen(false);
    setSection(target);
    navigate("/contracts");
  };
  const toggleMobileGroup = (label: string) => {
    setMobileExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  /** Check if a nav entry should be visible based on current section + permission */
  function isEntryVisible(entry: NavEntry): boolean {
    if (entry.kind === "external") {
      if (!can(entry.menuCode, "view")) return false;
      if (entry.onlySections && section && !entry.onlySections.includes(section)) return false;
      return true;
    }
    if (entry.kind === "leaf") return can(entry.menuCode, "view");
    // group: check if any child is visible
    return entry.children.some((c) => can(c.menuCode, "view"));
  }

  return (
    <>
      <nav className="sticky top-0 z-50 bg-white border-b border-gray-200 shadow-sm">
        <div className="h-14 max-w-screen-2xl mx-auto px-3 sm:px-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
            <button onClick={() => setMobileMenuOpen((v) => !v)}
              className="lg:hidden p-2 -ml-2 rounded-lg hover:bg-gray-100" aria-label="เปิดเมนู">
              {mobileMenuOpen ? <X className="w-5 h-5 text-gray-700" /> : <MenuIcon className="w-5 h-5 text-gray-700" />}
            </button>
            {section && (
              <div ref={sectionMenuRef} className="relative flex-shrink-0">
                <button onClick={() => canSwitchSection && setSectionMenuOpen((v) => !v)}
                  className={"flex items-center gap-2 py-1 pr-2 pl-1 rounded-lg" + (canSwitchSection ? " hover:bg-gray-100 cursor-pointer" : " cursor-default")}>
                  <img src={BRAND_LOGOS[section]} alt={section} className="w-8 h-8 rounded-md object-contain bg-white border border-gray-200" />
                  <span className="hidden sm:inline text-sm font-semibold text-gray-800">{section}</span>
                  {canSwitchSection && <ChevronDown className="w-3 h-3 text-gray-400" />}
                </button>
                {sectionMenuOpen && canSwitchSection && (
                  <div className="absolute top-full left-0 mt-1 w-52 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
                    <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-100">สลับ Section</div>
                    {allowedSectionsList.filter((s) => s !== section).map((s) => (
                      <button key={s} onClick={() => handleSwitchToSection(s)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                        <img src={BRAND_LOGOS[s]} alt={s} className="w-7 h-7 rounded-md object-contain bg-white border border-gray-200" />
                        <span className="font-medium">{s}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="hidden lg:flex items-center gap-1">
              {MAIN_NAV.map((entry) => {
                if (!isEntryVisible(entry)) return null;

                if (entry.kind === "external") {
                  return (
                    <a
                      key={entry.menuCode}
                      href={entry.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium transition-colors text-gray-600 hover:bg-sky-50 hover:text-sky-700"
                    >
                      {entry.logo ? (
                        <img src={entry.logo} alt={entry.label} className="h-5 w-auto object-contain" />
                      ) : (
                        <entry.icon className="w-4 h-4" />
                      )}
                      <ExternalLink className="w-3 h-3 opacity-50" />
                    </a>
                  );
                }

                if (entry.kind === "leaf") {
                  const isActive = location.startsWith(entry.path);
                  const Icon = entry.icon;
                  return (
                    <Link key={entry.path} href={entry.path}
                      className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                        isActive ? "bg-blue-50 text-blue-700" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900")}>
                      <Icon className="w-4 h-4" />
                      {entry.label}
                    </Link>
                  );
                }
                return <DesktopGroupMenu key={entry.label} entry={entry} location={location} />;
              })}
            </div>
          </div>
          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
            <div className="hidden md:flex items-center gap-2">{actions}</div>
            {/* AI Chat button */}
            <button
              onClick={toggleAiChat}
              aria-label="AI Chat"
              title="AI Chat"
              className={cn(
                "h-9 w-9 inline-flex items-center justify-center rounded-lg border transition-colors",
                aiChatOpen
                  ? "bg-blue-50 border-blue-200 text-blue-700"
                  : "bg-white border-gray-200 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              )}
            >
              <AiChatIcon active={aiChatOpen} section={section} />
            </button>
            {visibleSettings.length > 0 && (
              <div ref={settingsMenuRef} className="relative hidden md:block">
                <button onClick={() => setSettingsMenuOpen((v) => !v)} aria-label="ตั้งค่า" title="ตั้งค่า"
                  className={cn("h-9 w-9 inline-flex items-center justify-center rounded-lg border transition-colors",
                    settingsActive || settingsMenuOpen ? "bg-blue-50 border-blue-200 text-blue-700" : "bg-white border-gray-200 text-gray-600 hover:bg-gray-100 hover:text-gray-900")}>
                  <Settings className="w-4 h-4" />
                </button>
                {settingsMenuOpen && (
                  <div className="absolute top-full right-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
                    <div className="px-3 py-2 border-b border-gray-100">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">ตั้งค่า</p>
                    </div>
                    {visibleSettings.map((item) => {
                      const Icon = item.icon;
                      const isActive = location.startsWith(item.path);
                      return (
                        <Link key={item.path} href={item.path} onClick={() => setSettingsMenuOpen(false)}
                          className={cn("flex items-center gap-2 px-3 py-2 text-sm",
                            isActive ? "bg-blue-50 text-blue-700 font-medium" : "text-gray-700 hover:bg-gray-50")}>
                          <Icon className="w-4 h-4 flex-shrink-0" />
                          {item.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {/* User menu */}
            <div ref={userMenuRef} className="relative">
              <button onClick={() => setUserMenuOpen((v) => !v)}
                className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-gray-200 bg-white hover:bg-gray-100 transition-colors"
                aria-label="เมนูผู้ใช้">
                <span className="text-xs font-semibold text-gray-700">
                  {(me?.fullName ?? me?.username ?? "?").charAt(0).toUpperCase()}
                </span>
              </button>
              {userMenuOpen && (
                <div className="absolute top-full right-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
                  <div className="px-3 py-2 border-b border-gray-100">
                    <p className="text-sm font-semibold text-gray-900 truncate">{me?.fullName ?? me?.username ?? "-"}</p>
                    <p className="text-xs text-gray-500 truncate mt-0.5">{me?.group?.name ?? "-"}</p>
                  </div>
                  <Link href="/change-password" onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                    <KeyRound className="w-4 h-4" />
                    เปลี่ยนรหัสผ่าน
                  </Link>
                  <button onClick={handleLogout} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50">
                    <LogOut className="w-4 h-4" />
                    ออกจากระบบ
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        {actions && (
          <div className="md:hidden border-t border-gray-100 px-3 py-2 flex items-center gap-2 flex-wrap">
            {actions}
          </div>
        )}
      </nav>
      {mobileMenuOpen && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40 lg:hidden" onClick={() => setMobileMenuOpen(false)} />
          <aside className="fixed left-0 top-14 bottom-0 w-64 bg-white border-r border-gray-200 z-40 lg:hidden overflow-y-auto">
            <nav className="p-3 space-y-0.5">
              {MAIN_NAV.map((entry) => {
                if (!isEntryVisible(entry)) return null;

                if (entry.kind === "external") {
                  return (
                    <a
                      key={entry.menuCode}
                      href={entry.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setMobileMenuOpen(false)}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-700 hover:bg-sky-50 hover:text-sky-700"
                    >
                      {entry.logo ? (
                        <img src={entry.logo} alt={entry.label} className="h-5 w-auto object-contain flex-shrink-0" />
                      ) : (
                        <entry.icon className="w-4 h-4 flex-shrink-0" />
                      )}
                      <span className="flex-1">{entry.label}</span>
                      <ExternalLink className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                    </a>
                  );
                }

                if (entry.kind === "leaf") {
                  const Icon = entry.icon;
                  const isActive = location.startsWith(entry.path);
                  return (
                    <Link key={entry.path} href={entry.path} onClick={() => setMobileMenuOpen(false)}
                      className={cn("flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium",
                        isActive ? "bg-blue-50 text-blue-700" : "text-gray-700 hover:bg-gray-100")}>
                      <Icon className="w-4 h-4" />
                      {entry.label}
                    </Link>
                  );
                }
                const visibleChildren = entry.children.filter((c) => can(c.menuCode, "view"));
                if (visibleChildren.length === 0) return null;
                const isExpanded = mobileExpanded.has(entry.label);
                const isGroupActive = visibleChildren.some((c) => location.startsWith(c.path));
                const GroupIcon = entry.icon;
                return (
                  <div key={entry.label}>
                    <button onClick={() => toggleMobileGroup(entry.label)}
                      className={cn("w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium",
                        isGroupActive ? "bg-blue-50 text-blue-700" : "text-gray-700 hover:bg-gray-100")}>
                      <GroupIcon className="w-4 h-4 flex-shrink-0" />
                      <span className="flex-1 text-left">{entry.label}</span>
                      {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                    </button>
                    {isExpanded && (
                      <div className="ml-4 mt-0.5 space-y-0.5 border-l-2 border-gray-100 pl-3">
                        {visibleChildren.map((child) => {
                          const ChildIcon = child.icon;
                          const childActive = location.startsWith(child.path);
                          return (
                            <Link key={child.path} href={child.path} onClick={() => setMobileMenuOpen(false)}
                              className={cn("flex items-center gap-3 px-3 py-2 rounded-lg text-sm",
                                childActive ? "bg-blue-50 text-blue-700 font-medium" : "text-gray-600 hover:bg-gray-100")}>
                              <ChildIcon className="w-3.5 h-3.5 flex-shrink-0" />
                              {child.label}
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {visibleSettings.length > 0 && (
                <>
                  <div className="pt-3 pb-1 px-3">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
                      <Settings className="w-3.5 h-3.5" />
                      ตั้งค่า
                    </p>
                  </div>
                  {visibleSettings.map((item) => {
                    const Icon = item.icon;
                    const isActive = location.startsWith(item.path);
                    return (
                      <Link key={item.path} href={item.path} onClick={() => setMobileMenuOpen(false)}
                        className={cn("flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium",
                          isActive ? "bg-blue-50 text-blue-700" : "text-gray-700 hover:bg-gray-100")}>
                        <Icon className="w-4 h-4" />
                        {item.label}
                      </Link>
                    );
                  })}
                </>
              )}
            </nav>
          </aside>
        </>
      )}
    </>
  );
}
