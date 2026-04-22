import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { AlertCircle, Eye, EyeOff, Loader2, LogIn } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { useAppAuth } from "@/hooks/useAppAuth";

/**
 * Login page
 * - Inline error banner แทน toast เพื่อให้ผู้ใช้เห็นบริบทชัดเจนและไม่รบกวนหน้าอื่น
 * - เคลียร์ password + focus กลับเมื่อ login ไม่สำเร็จ เพื่อให้กดลองใหม่สะดวก
 * - Toast success เฉพาะตอน login สำเร็จ
 */
export default function Login() {
  const [, navigate] = useLocation();
  const { isAuthenticated, isLoading, refresh } = useAppAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const loginMutation = trpc.auth.login.useMutation();

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate("/select-section", { replace: true });
    }
  }, [isLoading, isAuthenticated, navigate]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    try {
      await loginMutation.mutateAsync({ username: username.trim(), password });
      toast.success("เข้าสู่ระบบสำเร็จ");
      await refresh();
      navigate("/select-section", { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "เข้าสู่ระบบไม่สำเร็จ";
      setErrorMsg(msg);
      setPassword("");
      // Delay focus a tick so React commits the state change first
      setTimeout(() => passwordRef.current?.focus(), 0);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-6 sm:p-8">
          <div className="flex flex-col items-center gap-3 mb-6">
            <div className="w-14 h-14 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-md">
              <LogIn className="w-7 h-7" />
            </div>
            <h1 className="text-xl font-bold text-gray-900">Report System</h1>
            <p className="text-sm text-gray-500 text-center">
              ระบบรายงานและจัดการข้อมูลสัญญา
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="username" className="text-sm text-gray-700">
                ชื่อผู้ใช้งาน
              </Label>
              <Input
                id="username"
                autoComplete="username"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  if (errorMsg) setErrorMsg(null);
                }}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-sm text-gray-700">
                รหัสผ่าน
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  ref={passwordRef}
                  type={showPwd ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (errorMsg) setErrorMsg(null);
                  }}
                  required
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                  aria-label={showPwd ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
                >
                  {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {errorMsg && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              >
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={loginMutation.isPending}
            >
              {loginMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  กำลังเข้าสู่ระบบ...
                </>
              ) : (
                "เข้าสู่ระบบ"
              )}
            </Button>
          </form>

          <p className="mt-6 text-xs text-center text-gray-400">
            ต้องการสิทธิ์เพิ่มเติม? ติดต่อผู้ดูแลระบบ
          </p>
        </div>
      </div>
    </div>
  );
}
