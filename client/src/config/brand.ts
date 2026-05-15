/**
 * Brand assets per section. Logos are served from client/public/.
 */
import type { SectionKey } from "@shared/const";

export const BRAND_LOGOS: Record<SectionKey, string> = {
  Boonphone: "/logo-boonphone.png",
  Fastfone365: "/logo-fastfone365.png",
};

export const BRAND_ACCENT: Record<SectionKey, string> = {
  Boonphone: "#ec4899", // pink-500
  Fastfone365: "#c2410c", // orange-700
};
