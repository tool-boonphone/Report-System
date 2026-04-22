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
    <div className="min-h-screen bg-gray-50">
      <TopNav />
      <main>{children}</main>
    </div>
  );
}
