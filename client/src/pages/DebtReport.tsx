import { AppShell } from "@/components/AppShell";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useSection } from "@/contexts/SectionContext";
import { Banknote } from "lucide-react";
import { useEffect } from "react";

export default function DebtReport() {
  const { section } = useSection();
  const { setActions } = useNavActions();

  useEffect(() => {
    setActions(<SyncStatusBar />);
    return () => setActions(null);
  }, [setActions]);

  return (
    <AppShell>
      <div className="max-w-screen-2xl mx-auto px-4 py-5">
        <div className="bg-white border border-gray-200 rounded-xl p-8 text-center">
          <Banknote className="w-10 h-10 text-emerald-600 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-gray-900">รายงานหนี้</h1>
          <p className="text-sm text-gray-500 mt-1">
            Section ปัจจุบัน: <span className="font-medium">{section}</span>
          </p>
          <p className="text-xs text-gray-400 mt-4">
            รายงานเป้าเก็บหนี้ / ยอดเก็บหนี้จะเพิ่มใน Phase 5
          </p>
        </div>
      </div>
    </AppShell>
  );
}
