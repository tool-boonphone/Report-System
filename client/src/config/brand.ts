/**
 * Brand assets per section. Uploaded via manus-upload-file --webdev.
 */
import type { SectionKey } from "@shared/const";

export const BRAND_LOGOS: Record<SectionKey, string> = {
  Boonphone: "/manus-storage/logo-boonphone_c9380bca.png",
  Fastfone365: "/manus-storage/logo-fastfone365_c68777f5.png",
};

/** Stock Sure+ logo (Boonphone only external link) */
export const SURE_PLUS_LOGO = "/manus-storage/sure-plus-logo_adec38e8.png";
export const SURE_PLUS_URL = "https://stock.boonphone.co.th/";

export const BRAND_ACCENT: Record<SectionKey, string> = {
  Boonphone: "#ec4899", // pink-500
  Fastfone365: "#c2410c", // orange-700
};
