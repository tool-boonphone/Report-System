import { AppShell } from "@/components/AppShell";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { useNavActions } from "@/contexts/NavActionsContext";
import { useSection } from "@/contexts/SectionContext";
import { FileText } from "lucide-react";
import { useEffect } from "react";

export default function Contracts() {
  const { section } = useSection();
  const { setActions } = useNavActions();

  // Register TopNav actions for this page.
  useEffect(() => {
    setActions(<SyncStatusBar />);
    return () => setActions(null);
  }, [setActions]);

  return (
    <AppShell>
      <div className="max-w-screen-2xl mx-auto px-4 py-5">
        <div className="bg-white border border-gray-200 rounded-xl p-8 text-center">
          <FileText className="w-10 h-10 text-blue-600 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-gray-900">ข้อมูลสัญญา</h1>
          <p className="text-sm text-gray-500 mt-1">
            Section ปัจจุบัน: <span className="font-medium">{section}</span>
          </p>
          <p className="text-xs text-gray-400 mt-4">
            ตารางข้อมูล 41 คอลัมน์ + Filter/Export จะเพิ่มใน Phase 4
          </p>
        </div>
      </div>
    </AppShell>
  );
}
