import { BRAND_LOGOS, SURE_PLUS_LOGO, SURE_PLUS_URL } from "@/config/brand";
import { useSection } from "@/contexts/SectionContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { SECTIONS, type SectionKey } from "@shared/const";
import { ArrowRight, Loader2 } from "lucide-react";
import { useEffect } from "react";
import { useLocation } from "wouter";

export default function SelectSection() {
  const { isAuthenticated, isLoading, me, can, logout } = useAppAuth();
  const { setSection } = useSection();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate("/login", { replace: true });
    }
  }, [isLoading, isAuthenticated, navigate]);

  if (isLoading || !isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  // Compute allowed sections for this user's group
  // Empty allowedSections = all sections allowed
  const rawAllowed = me?.group?.allowedSections ?? "";
  const allowedSections: SectionKey[] = rawAllowed
    ? (rawAllowed.split(",").map((s) => s.trim()).filter((s) => SECTIONS.includes(s as SectionKey)) as SectionKey[])
    : [...SECTIONS];

  // Check if user can see Stock Sure+ (Boonphone must be in allowed sections + has permission)
  const canSeeStockSurePlus =
    allowedSections.includes("Boonphone") && can("stock_sure_plus", "view");

  function handlePick(s: SectionKey) {
    setSection(s);
    navigate("/data-loading", { replace: true });
  }

  // If user has access to only 1 section, auto-navigate there
  if (allowedSections.length === 1) {
    handlePick(allowedSections[0]);
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 px-4 py-10 flex items-center">
      <div className="w-full max-w-3xl mx-auto">
        <div className="text-center mb-8">
          <p className="text-sm text-gray-500">
            สวัสดี{me?.fullName ? ` คุณ${me.fullName}` : ""}
          </p>
          <h1 className="mt-1 text-2xl sm:text-3xl font-bold text-gray-900">
            เลือก Section ที่ต้องการใช้งาน
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            คุณสามารถสลับ Section ได้ภายหลังจากเมนูด้านบน
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          {allowedSections.map((s) => (
            <button
              key={s}
              onClick={() => handlePick(s)}
              className="group bg-white border border-gray-200 hover:border-blue-400 hover:shadow-lg rounded-2xl p-6 transition-all text-left"
            >
              <div className="flex items-center gap-4">
                <img
                  src={BRAND_LOGOS[s]}
                  alt={s}
                  className="w-16 h-16 rounded-xl object-contain bg-white border border-gray-100"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-lg font-semibold text-gray-900">{s}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    เข้าสู่ระบบรายงานของ {s}
                  </p>
                </div>
                <ArrowRight className="w-5 h-5 text-gray-300 group-hover:text-blue-600 transition-colors" />
              </div>
            </button>
          ))}
        </div>

        {/* Stock Sure+ shortcut — Boonphone only, controlled by permission */}
        {canSeeStockSurePlus && (
          <div className="mt-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="flex-1 h-px bg-gray-200" />
              <span className="text-xs text-gray-400 whitespace-nowrap">หรือเปิดระบบอื่น</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>
            <a
              href={SURE_PLUS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-4 bg-white border border-gray-200 hover:border-sky-400 hover:shadow-lg rounded-2xl p-5 transition-all w-full"
            >
              <div className="w-16 h-16 rounded-xl bg-sky-50 border border-sky-100 flex items-center justify-center overflow-hidden flex-shrink-0">
                <img
                  src={SURE_PLUS_LOGO}
                  alt="Stock Sure+"
                  className="w-14 h-14 object-contain"
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-base font-semibold text-gray-900">Stock Sure+</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  ระบบจัดการสต็อก Boonphone
                </p>
              </div>
              <ArrowRight className="w-5 h-5 text-gray-300 group-hover:text-sky-500 transition-colors flex-shrink-0" />
            </a>
          </div>
        )}

        <div className="text-center mt-8">
          <button
            onClick={async () => {
              await logout();
              navigate("/login", { replace: true });
            }}
            className="text-sm text-gray-500 hover:text-red-600"
          >
            ออกจากระบบ
          </button>
        </div>
      </div>
    </div>
  );
}
