import { BRAND_LOGOS } from "@/config/brand";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useSection } from "@/contexts/SectionContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  KeyRound,
  LogOut,
  Menu as MenuIcon,
  Users,
  Shield,
  FileText,
  Banknote,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";

type NavItem = {
  label: string;
  path: string;
  icon: typeof FileText;
  menuCode: "contract" | "debt_report" | "settings_users" | "settings_groups";
};

const NAV_ITEMS: NavItem[] = [
  { label: "ข้อมูลสัญญา", path: "/contracts", icon: FileText, menuCode: "contract" },
  { label: "รายงานหนี้", path: "/debt-report", icon: Banknote, menuCode: "debt_report" },
  { label: "จัดการผู้ใช้งาน", path: "/settings/users", icon: Users, menuCode: "settings_users" },
  { label: "จัดการสิทธิ์", path: "/settings/groups", icon: Shield, menuCode: "settings_groups" },
];

export function TopNav() {
  const { me, can, logout } = useAppAuth();
  const { section, clearSection } = useSection();
  const { actions } = useNavActions();
  const [location, navigate] = useLocation();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sectionMenuOpen, setSectionMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const sectionMenuRef = useRef<HTMLDivElement>(null);

  // close menus on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!userMenuRef.current?.contains(e.target as Node)) setUserMenuOpen(false);
      if (!sectionMenuRef.current?.contains(e.target as Node))
        setSectionMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const visibleNav = NAV_ITEMS.filter((item) => can(item.menuCode, "view"));

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
                  onClick={() => setSectionMenuOpen((v) => !v)}
                  className="flex items-center gap-2 py-1 pr-2 pl-1 rounded-lg hover:bg-gray-100"
                >
                  <img
                    src={BRAND_LOGOS[section]}
                    alt={section}
                    className="w-8 h-8 rounded-md object-contain bg-white border border-gray-200"
                  />
                  <span className="hidden sm:inline text-sm font-semibold text-gray-800">
                    {section}
                  </span>
                  <ChevronDown className="w-3 h-3 text-gray-400" />
                </button>
                {sectionMenuOpen && (
                  <div className="absolute top-full left-0 mt-1 w-44 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50">
                    <button
                      onClick={handleChangeSection}
                      className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    >
                      สลับ Section
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Desktop nav links */}
            <div className="hidden lg:flex items-center gap-1">
              {visibleNav.map((item) => {
                const isActive = location.startsWith(item.path);
                return (
                  <Link
                    key={item.path}
                    href={item.path}
                    className={cn(
                      "px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                      isActive
                        ? "bg-blue-50 text-blue-700"
                        : "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Right: injected actions + user */}
          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
            <div className="hidden md:flex items-center gap-2">{actions}</div>

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
              {visibleNav.map((item) => {
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
            </nav>
          </aside>
        </>
      )}
    </>
  );
}
