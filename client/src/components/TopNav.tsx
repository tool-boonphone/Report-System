import { BRAND_LOGOS } from "@/config/brand";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useSection } from "@/contexts/SectionContext";
import { useAiChat } from "@/contexts/AiChatContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { cn } from "@/lib/utils";
import { SECTIONS } from "@shared/const";
import {
  Banknote,
  ChevronDown,
  FileText,
  KeyRound,
  LogOut,
  Menu as MenuIcon,
  Settings,
  Shield,
  TrendingDown,
  Users,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";

type MenuCode = "contract" | "debt_report" | "bad_debt_summary" | "settings_users" | "settings_groups";

type NavItem = {
  label: string;
  path: string;
  icon: typeof FileText;
  menuCode: MenuCode;
};

// Primary navigation: always shown on the TopNav itself.
const MAIN_NAV: NavItem[] = [
  { label: "ข้อมูลสัญญา", path: "/contracts", icon: FileText, menuCode: "contract" },
  { label: "รายงานหนี้", path: "/debt-report", icon: Banknote, menuCode: "debt_report" },
  { label: "สรุปหนี้เสีย", path: "/bad-debt-summary", icon: TrendingDown, menuCode: "bad_debt_summary" },
];

// Settings sub-menu: collapsed under the Settings icon button.
const SETTINGS_NAV: NavItem[] = [
  { label: "จัดการผู้ใช้งาน", path: "/settings/users", icon: Users, menuCode: "settings_users" },
  { label: "จัดการสิทธิ์", path: "/settings/groups", icon: Shield, menuCode: "settings_groups" },
];

/**
 * AI Chat icon — gradient sparkles with subtle pulse animation
 * ใช้ SVG แทน lucide เพื่อให้ใส่ gradient ได้
 */
function AiChatIcon({ active }: { active: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("w-[18px] h-[18px]", active ? "" : "animate-ai-sparkle")}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="aiGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#a855f7" />
          <stop offset="50%" stopColor="#ec4899" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      {/* Main sparkle star */}
      <path
        d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"
        fill="url(#aiGrad)"
      />
      {/* Small sparkle top-right */}
      <path
        d="M19 3l.75 2.25L22 6l-2.25.75L19 9l-.75-2.25L16 6l2.25-.75L19 3z"
        fill="url(#aiGrad)"
        opacity="0.8"
      />
      {/* Small sparkle bottom-left */}
      <path
        d="M5 15l.6 1.8L7.4 17.4l-1.8.6L5 20l-.6-1.8L2.6 17.4l1.8-.6L5 15z"
        fill="url(#aiGrad)"
        opacity="0.6"
      />
    </svg>
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
  const userMenuRef = useRef<HTMLDivElement>(null);
  const sectionMenuRef = useRef<HTMLDivElement>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);

  // Close any open pop-over menu when clicking outside of it.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!userMenuRef.current?.contains(e.target as Node)) setUserMenuOpen(false);
      if (!sectionMenuRef.current?.contains(e.target as Node))
        setSectionMenuOpen(false);
      if (!settingsMenuRef.current?.contains(e.target as Node))
        setSettingsMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Close settings dropdown whenever the active route changes so the
  // menu doesn't stay open after navigating to one of its sub-items.
  useEffect(() => {
    setSettingsMenuOpen(false);
  }, [location]);

  const canSwitchSection = can("section_switch", "view");
  const visibleMain = MAIN_NAV.filter((item) => can(item.menuCode, "view"));
  const visibleSettings = SETTINGS_NAV.filter((item) => can(item.menuCode, "view"));

  const settingsActive = visibleSettings.some((item) =>
    location.startsWith(item.path),
  );

  // Compute sections this user can switch to (based on group allowedSections)
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
  const handleChangeSection = () => {
    setSectionMenuOpen(false);
    setMobileMenuOpen(false);
    clearSection();
    navigate("/select-section");
  };

  return (
    <>
      <nav className="sticky top-0 z-50 bg-white border-b border-gray-200 shadow-sm">
        <div className="h-14 max-w-screen-2xl mx-auto px-3 sm:px-4 flex items-center justify-between gap-2">
          {/* Left: logo + section + desktop nav */}
          <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
            {/* Mobile hamburger */}
            <button
              onClick={() => setMobileMenuOpen((v) => !v)}
              className="lg:hidden p-2 -ml-2 rounded-lg hover:bg-gray-100"
              aria-label="เปิดเมนู"
            >
              {mobileMenuOpen ? (
                <X className="w-5 h-5 text-gray-700" />
              ) : (
                <MenuIcon className="w-5 h-5 text-gray-700" />
              )}
            </button>

            {/* Section switcher / brand */}
            {section && (
              <div ref={sectionMenuRef} className="relative flex-shrink-0">
                <button
                  onClick={() => canSwitchSection && setSectionMenuOpen((v) => !v)}
                  className={"flex items-center gap-2 py-1 pr-2 pl-1 rounded-lg" + (canSwitchSection ? " hover:bg-gray-100 cursor-pointer" : " cursor-default")}
                >
                  <img
                    src={BRAND_LOGOS[section]}
                    alt={section}
                    className="w-8 h-8 rounded-md object-contain bg-white border border-gray-200"
                  />
                  <span className="hidden sm:inline text-sm font-semibold text-gray-800">
                    {section}
                  </span>
                  {canSwitchSection && <ChevronDown className="w-3 h-3 text-gray-400" />}
                </button>
                {sectionMenuOpen && canSwitchSection && (
                  <div className="absolute top-full left-0 mt-1 w-52 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
                    <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-100">
                      สลับ Section
                    </div>
                    {allowedSectionsList.filter((s) => s !== section).map((s) => (
                      <button
                        key={s}
                        onClick={() => handleSwitchToSection(s)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      >
                        <img
                          src={BRAND_LOGOS[s]}
                          alt={s}
                          className="w-7 h-7 rounded-md object-contain bg-white border border-gray-200"
                        />
                        <span className="font-medium">{s}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Desktop nav links (main only — settings lives on the right) */}
            <div className="hidden lg:flex items-center gap-1">
              {visibleMain.map((item) => {
                const isActive = location.startsWith(item.path);
                return (
                  <Link
                    key={item.path}
                    href={item.path}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                      isActive
                        ? "bg-blue-50 text-blue-700"
                        : "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
                    )}
                  >
                    {(() => { const Icon = item.icon; return <Icon className="w-4 h-4" />; })()}
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Right: injected actions + settings + AI chat + user */}
          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
            <div className="hidden md:flex items-center gap-2">{actions}</div>

            {/* Settings dropdown: placed right after page-injected actions
                (typically a Refresh/Export cluster from each page). */}
            {visibleSettings.length > 0 && (
              <div ref={settingsMenuRef} className="relative hidden md:block">
                <button
                  onClick={() => setSettingsMenuOpen((v) => !v)}
                  aria-label="ตั้งค่า"
                  title="ตั้งค่า"
                  className={cn(
                    "h-9 w-9 inline-flex items-center justify-center rounded-lg border transition-colors",
                    settingsActive || settingsMenuOpen
                      ? "bg-blue-50 border-blue-200 text-blue-700"
                      : "bg-white border-gray-200 text-gray-600 hover:bg-gray-100 hover:text-gray-900",
                  )}
                >
                  <Settings className="w-4 h-4" />
                </button>
                {settingsMenuOpen && (
                  <div className="absolute top-full right-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
                    <div className="px-3 py-2 border-b border-gray-100">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        ตั้งค่า
                      </p>
                    </div>
                    {visibleSettings.map((item) => {
                      const Icon = item.icon;
                      const isActive = location.startsWith(item.path);
                      return (
                        <Link
                          key={item.path}
                          href={item.path}
                          onClick={() => setSettingsMenuOpen(false)}
                          className={cn(
                            "flex items-center gap-2 px-3 py-2 text-sm",
                            isActive
                              ? "bg-blue-50 text-blue-700"
                              : "text-gray-700 hover:bg-gray-50",
                          )}
                        >
                          <Icon className="w-4 h-4" />
                          {item.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* AI Chat button — between settings and profile
                ใช้ gradient sparkle icon + animation เพื่อดึงดูดความสนใจ */}
            {me && (
              <button
                onClick={toggleAiChat}
                aria-label="น้องเป๋าตัง AI Assistant"
                title="น้องเป๋าตัง — AI Assistant"
                className={cn(
                  "h-9 w-9 inline-flex items-center justify-center rounded-lg border transition-all duration-200",
                  aiChatOpen
                    ? "bg-gradient-to-br from-purple-50 to-pink-50 border-purple-300 shadow-sm shadow-purple-100"
                    : "bg-white border-gray-200 hover:border-purple-300 hover:bg-gradient-to-br hover:from-purple-50 hover:to-pink-50",
                )}
              >
                <AiChatIcon active={aiChatOpen} />
              </button>
            )}

            {me && (
              <div ref={userMenuRef} className="relative">
                <button
                  onClick={() => setUserMenuOpen((v) => !v)}
                  className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-gray-100"
                >
                  <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs font-semibold">
                    {(me.fullName ?? me.username).charAt(0).toUpperCase()}
                  </div>
                  <span className="hidden sm:inline text-sm text-gray-700 max-w-[10ch] truncate">
                    {me.fullName ?? me.username}
                  </span>
                </button>
                {userMenuOpen && (
                  <div className="absolute top-full right-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
                    <div className="px-3 py-2 border-b border-gray-100">
                      <p className="text-sm font-medium text-gray-800 truncate">
                        {me.fullName ?? me.username}
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {me.group.name}
                      </p>
                    </div>
                    <Link
                      href="/change-password"
                      onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    >
                      <KeyRound className="w-4 h-4" />
                      เปลี่ยนรหัสผ่าน
                    </Link>
                    <button
                      onClick={handleLogout}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                    >
                      <LogOut className="w-4 h-4" />
                      ออกจากระบบ
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Injected actions on mobile (below header) */}
        {actions && (
          <div className="md:hidden border-t border-gray-100 px-3 py-2 flex items-center gap-2 flex-wrap">
            {actions}
          </div>
        )}
      </nav>

      {/* Mobile side menu */}
      {mobileMenuOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/30 z-40 lg:hidden"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="fixed left-0 top-14 bottom-0 w-64 bg-white border-r border-gray-200 z-40 lg:hidden overflow-y-auto">
            <nav className="p-3 space-y-1">
              {visibleMain.map((item) => {
                const Icon = item.icon;
                const isActive = location.startsWith(item.path);
                return (
                  <Link
                    key={item.path}
                    href={item.path}
                    onClick={() => setMobileMenuOpen(false)}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium",
                      isActive
                        ? "bg-blue-50 text-blue-700"
                        : "text-gray-700 hover:bg-gray-100",
                    )}
                  >
                    <Icon className="w-4 h-4" />
                    {item.label}
                  </Link>
                );
              })}

              {/* Settings section header, shown only if the user has
                  permission to access at least one settings page. */}
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
                      <Link
                        key={item.path}
                        href={item.path}
                        onClick={() => setMobileMenuOpen(false)}
                        className={cn(
                          "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium",
                          isActive
                            ? "bg-blue-50 text-blue-700"
                            : "text-gray-700 hover:bg-gray-100",
                        )}
                      >
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
      {/* NOTE: AIChatPanel ถูกย้ายไปอยู่ใน AppShell เพื่อทำ side-by-side layout */}
    </>
  );
}
