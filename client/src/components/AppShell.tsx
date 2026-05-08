import { useAppAuth } from "@/hooks/useAppAuth";
import { useSection } from "@/contexts/SectionContext";
import { useDebtCache } from "@/contexts/DebtCacheContext";
import { useAiChat } from "@/contexts/AiChatContext";
import type { SectionKey } from "@shared/const";
import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { useLocation } from "wouter";
import { TopNav } from "./TopNav";
import { AIChatPanel } from "./AIChatPanel";

/** Key ที่ใช้เก็บ returnPath ใน localStorage (ใช้ localStorage แทน sessionStorage เพื่อให้รอดจาก OAuth redirect) */
export const DATA_LOADING_RETURN_KEY = "dl_return_path";
/** Key สำหรับเก็บ timestamp ของ returnPath เพื่อป้องกัน stale path */
const DATA_LOADING_RETURN_TS_KEY = "dl_return_path_ts";
/** TTL ของ returnPath: 10 นาที */
const RETURN_PATH_TTL_MS = 10 * 60 * 1000;

/** บันทึก returnPath พร้อม timestamp ลง localStorage */
export function saveReturnPath(path: string) {
  localStorage.setItem(DATA_LOADING_RETURN_KEY, path);
  localStorage.setItem(DATA_LOADING_RETURN_TS_KEY, String(Date.now()));
}

/** อ่าน returnPath จาก localStorage แล้วล้างออก (ถ้าหมดอายุจะ return null) */
export function popReturnPath(): string | null {
  const path = localStorage.getItem(DATA_LOADING_RETURN_KEY);
  const ts = localStorage.getItem(DATA_LOADING_RETURN_TS_KEY);
  localStorage.removeItem(DATA_LOADING_RETURN_KEY);
  localStorage.removeItem(DATA_LOADING_RETURN_TS_KEY);
  if (!path || path === "/data-loading") return null;
  // ตรวจสอบ TTL
  if (ts && Date.now() - parseInt(ts, 10) > RETURN_PATH_TTL_MS) return null;
  return path;
}

/**
 * AppShell guards authenticated routes:
 *  - If loading → spinner
 *  - If not authenticated → /login
 *  - If authenticated but no section picked → /select-section
 *  - If section set but cache empty (e.g. browser refresh) → /data-loading
 *    (บันทึก returnPath ใน localStorage เพื่อให้ DataLoadingScreen กลับมาหน้าเดิม)
 *  - Otherwise render children inside TopNav layout
 */
export function AppShell({
  children,
  requireSection = true,
  fullHeight = false,
}: {
  children: ReactNode;
  requireSection?: boolean;
  /** เมื่อ true: main จะไม่ scroll ด้วยตัวเอง (ให้ children จัดการ scroll เอง เช่น MonthlySummary) */
  fullHeight?: boolean;
}) {
  const { isLoading, isAuthenticated } = useAppAuth();
  const { hasSection, section } = useSection();
  const debtCache = useDebtCache();
  const { aiChatOpen } = useAiChat();
  const [location, navigate] = useLocation();

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      navigate("/login", { replace: true });
      return;
    }
    if (requireSection && !hasSection) {
      navigate("/select-section", { replace: true });
      return;
    }
    // ถ้ามี section แต่ cache ยังไม่มีข้อมูล (เช่น refresh browser)
    // และไม่ได้อยู่ที่ /data-loading อยู่แล้ว → redirect ไป preload
    if (requireSection && hasSection && section && location !== "/data-loading") {
      const cache = debtCache.getCache(section as SectionKey);
      if (!cache.target || !cache.collected) {
        // บันทึก returnPath ลง localStorage (รอดจาก OAuth redirect)
        saveReturnPath(location);
        navigate("/data-loading", { replace: true });
      }
    }
  }, [isLoading, isAuthenticated, hasSection, requireSection, navigate, section, location]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading || !isAuthenticated || (requireSection && !hasSection)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="h-screen bg-gray-50 flex flex-col overflow-hidden">
      <TopNav />
      {/* Content area: flex row เพื่อรองรับ side-by-side AI panel */}
      <div className="flex flex-1 min-h-0 relative">
        {/* Main content — transition margin เมื่อ panel เปิด */}
        <main
          className={`flex-1 min-w-0 transition-all duration-300 ${fullHeight ? 'overflow-hidden flex flex-col' : 'overflow-y-auto overflow-x-hidden'}`}
          style={aiChatOpen ? { marginRight: "400px" } : {}}
        >
          {children}
        </main>
        {/* AI Chat Panel — fixed right, ไม่ทับ content */}
        <AIChatPanel />
      </div>
    </div>
  );
}
