import { useAppAuth } from "@/hooks/useAppAuth";
import { useSection } from "@/contexts/SectionContext";
import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { useLocation } from "wouter";
import { TopNav } from "./TopNav";

/**
 * AppShell guards authenticated routes:
 *  - If loading → spinner
 *  - If not authenticated → /login
 *  - If authenticated but no section picked → /select-section
 *  - Otherwise render children inside TopNav layout
 *
 * Layout: h-screen flex-col so pages can use sticky/fixed bottom elements
 * that stay visible without scrolling.
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
    <div className="h-screen flex flex-col bg-gray-50 overflow-hidden">
      <TopNav />
      {/* flex-1 + overflow-y-auto: page content scrolls inside, TopNav stays fixed at top */}
      <main className="flex-1 overflow-y-auto min-h-0">{children}</main>
    </div>
  );
}
