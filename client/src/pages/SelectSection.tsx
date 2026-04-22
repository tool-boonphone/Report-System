import { BRAND_LOGOS } from "@/config/brand";
import { useSection } from "@/contexts/SectionContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { SECTIONS, type SectionKey } from "@shared/const";
import { ArrowRight, Loader2 } from "lucide-react";
import { useEffect } from "react";
import { useLocation } from "wouter";

export default function SelectSection() {
  const { isAuthenticated, isLoading, me, logout } = useAppAuth();
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

  function handlePick(s: SectionKey) {
    setSection(s);
    navigate("/contracts", { replace: true });
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
          {SECTIONS.map((s) => (
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
