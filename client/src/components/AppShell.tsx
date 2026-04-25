import { useAppAuth } from "@/hooks/useAppAuth";
import { useSection } from "@/contexts/SectionContext";
import { useAiChat } from "@/contexts/AiChatContext";
import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { useLocation } from "wouter";
import { TopNav } from "./TopNav";
import { AIChatPanel } from "./AIChatPanel";

/**
 * AppShell guards authenticated routes:
 *  - If loading → spinner
 *  - If not authenticated → /login
 *  - If authenticated but no section picked → /select-section
 *  - Otherwise render children inside TopNav layout
 */
export function AppShell({
  children,
  requireSection = true,
}: {
  children: ReactNode;
  requireSection?: boolean;
}) {
  const { isLoading, isAuthenticated } = useAppAuth();
  const { hasSection } = useSection();
  const { aiChatOpen } = useAiChat();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      navigate("/login", { replace: true });
      return;
    }
    if (requireSection && !hasSection) {
      navigate("/select-section", { replace: true });
    }
  }, [isLoading, isAuthenticated, hasSection, requireSection, navigate]);

  if (isLoading || !isAuthenticated || (requireSection && !hasSection)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <TopNav />
      {/* Content area: flex row เพื่อรองรับ side-by-side AI panel */}
      <div className="flex flex-1 min-h-0 relative">
        {/* Main content — transition margin เมื่อ panel เปิด */}
        <main
          className="flex-1 min-w-0 transition-all duration-300"
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
