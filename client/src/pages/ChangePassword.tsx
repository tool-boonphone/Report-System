import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { KeyRound, Loader2 } from "lucide-react";
import { FormEvent, useState } from "react";
import { toast } from "sonner";

export default function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");

  const mut = trpc.auth.changePassword.useMutation();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (newPwd !== confirmPwd) {
      toast.error("รหัสผ่านใหม่และยืนยันไม่ตรงกัน");
      return;
    }
    try {
      await mut.mutateAsync({ currentPassword: current, newPassword: newPwd });
      toast.success("เปลี่ยนรหัสผ่านสำเร็จ");
      setCurrent("");
      setNewPwd("");
      setConfirmPwd("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "เปลี่ยนรหัสผ่านไม่สำเร็จ");
    }
  }

  return (
    <AppShell requireSection={false}>
      <div className="max-w-xl mx-auto px-4 py-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5 sm:p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-lg bg-blue-50 text-blue-700 flex items-center justify-center">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-gray-900">เปลี่ยนรหัสผ่าน</h1>
              <p className="text-xs text-gray-500">กำหนดรหัสผ่านอย่างน้อย 6 ตัวอักษร</p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="curr">รหัสผ่านปัจจุบัน</Label>
              <Input
                id="curr"
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new">รหัสผ่านใหม่</Label>
              <Input
                id="new"
                type="password"
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
                required
                minLength={6}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm">ยืนยันรหัสผ่านใหม่</Label>
              <Input
                id="confirm"
                type="password"
                value={confirmPwd}
                onChange={(e) => setConfirmPwd(e.target.value)}
                required
                minLength={6}
                autoComplete="new-password"
              />
            </div>
            <Button type="submit" className="w-full" disabled={mut.isPending}>
              {mut.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> กำลังบันทึก...
                </>
              ) : (
                "บันทึก"
              )}
            </Button>
          </form>
        </div>
      </div>
    </AppShell>
  );
}
