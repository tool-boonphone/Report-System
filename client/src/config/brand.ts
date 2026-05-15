/**
 * Brand assets per section. Logos are served from client/public/.
 *
 * BRAND_LOGOS_SQUARE  — โลโก้สำหรับแสดงแบบจตุรัส (w = h) เช่น SelectSection, TopNav, DataLoadingScreen
 * BRAND_LOGOS_RECT    — โลโก้สำหรับแสดงแบบผืนผ้า (landscape) เช่น header banner
 * BRAND_LOGOS         — alias ชี้ไปยัง BRAND_LOGOS_RECT (backward-compat)
 */
import type { SectionKey } from "@shared/const";

export const BRAND_LOGOS_SQUARE: Record<SectionKey, string> = {
  Boonphone: "/logo-boonphone-square.png",
  Fastfone365: "/logo-fastfone365-square.png",
};

export const BRAND_LOGOS_RECT: Record<SectionKey, string> = {
  Boonphone: "/logo-boonphone.png",
  Fastfone365: "/logo-fastfone365.png",
};

/** @deprecated ใช้ BRAND_LOGOS_SQUARE หรือ BRAND_LOGOS_RECT แทน */
export const BRAND_LOGOS: Record<SectionKey, string> = BRAND_LOGOS_RECT;

export const BRAND_ACCENT: Record<SectionKey, string> = {
  Boonphone: "#ec4899", // pink-500
  Fastfone365: "#c2410c", // orange-700
};
