import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAppAuth } from "@/hooks/useAppAuth";
import { trpc } from "@/lib/trpc";
import {
  Edit3,
  KeyRound,
  Loader2,
  Plus,
  ShieldAlert,
  Trash2,
  UserCircle2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

type FormState = {
  id?: number;
  username: string;
  password: string;
  fullName: string;
  email: string;
  groupId: number | null;
  isActive: boolean;
};

const EMPTY_FORM: FormState = {
  username: "",
  password: "",
  fullName: "",
  email: "",
  groupId: null,
  isActive: true,
};

export default function UsersSettings() {
  const { isSuperAdmin, isLoading } = useAppAuth();

  const users = trpc.admin.listUsers.useQuery(undefined, {
    enabled: isSuperAdmin,
  });
  const groups = trpc.admin.listGroups.useQuery(undefined, {
    enabled: isSuperAdmin,
  });

  const utils = trpc.useUtils();
  const createUser = trpc.admin.createUser.useMutation({
    onSuccess: () => {
      utils.admin.listUsers.invalidate();
      toast.success("เพิ่มผู้ใช้งานสำเร็จ");
    },
    onError: (e) => toast.error(e.message),
  });
  const updateUser = trpc.admin.updateUser.useMutation({
    onSuccess: () => {
      utils.admin.listUsers.invalidate();
      toast.success("อัพเดตข้อมูลผู้ใช้สำเร็จ");
    },
    onError: (e) => toast.error(e.message),
  });
  const resetPwd = trpc.admin.resetUserPassword.useMutation({
    onSuccess: () => toast.success("รีเซ็ตรหัสผ่านสำเร็จ"),
    onError: (e) => toast.error(e.message),
  });
  const deleteUser = trpc.admin.deleteUser.useMutation({
    onSuccess: () => {
      utils.admin.listUsers.invalidate();
      toast.success("ลบผู้ใช้งานสำเร็จ");
    },
    onError: (e) => toast.error(e.message),
  });

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pwdDialogUserId, setPwdDialogUserId] = useState<number | null>(null);
  const [pwdValue, setPwdValue] = useState("");

  const defaultGroupId = useMemo(() => {
    const nonAdmin = groups.data?.find((g) => !g.isSuperAdmin);
    return nonAdmin?.id ?? groups.data?.[0]?.id ?? null;
  }, [groups.data]);

  if (isLoading) {
    return (
      <AppShell requireSection={false}>
        <div className="min-h-[50vh] flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
        </div>
      </AppShell>
    );
  }

  if (!isSuperAdmin) {
    return (
      <AppShell requireSection={false}>
        <div className="max-w-md mx-auto px-4 py-12 text-center">
          <ShieldAlert className="w-10 h-10 text-red-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold">ไม่มีสิทธิ์เข้าถึง</h1>
          <p className="text-sm text-gray-500 mt-1">เฉพาะ Super Admin เท่านั้น</p>
        </div>
      </AppShell>
    );
  }

  function openCreate() {
    setForm({ ...EMPTY_FORM, groupId: defaultGroupId });
    setDialogOpen(true);
  }

  function openEdit(u: NonNullable<typeof users.data>[number]) {
    setForm({
      id: u.id,
      username: u.username,
      password: "",
      fullName: u.fullName ?? "",
      email: u.email ?? "",
      groupId: u.groupId,
      isActive: u.isActive,
    });
    setDialogOpen(true);
  }

  async function handleSubmit() {
    if (!form.groupId) {
      toast.error("กรุณาเลือกกลุ่มสิทธิ์");
      return;
    }
    if (form.id) {
      await updateUser.mutateAsync({
        id: form.id,
        fullName: form.fullName || null,
        email: form.email || null,
        groupId: form.groupId,
        isActive: form.isActive,
      });
    } else {
      if (!form.username.trim() || !form.password) {
        toast.error("กรุณาระบุ Username และรหัสผ่าน");
        return;
      }
      await createUser.mutateAsync({
        username: form.username.trim(),
        password: form.password,
        fullName: form.fullName || null,
        email: form.email || null,
        groupId: form.groupId,
        isActive: form.isActive,
      });
    }
    setDialogOpen(false);
  }

  return (
    <AppShell requireSection={false}>
      <div className="max-w-screen-lg mx-auto px-4 py-5 space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h1 className="text-lg sm:text-xl font-semibold text-gray-900">
              จัดการผู้ใช้งาน
            </h1>
            <p className="text-xs text-gray-500">
              เพิ่ม / แก้ไข / ลบ / เปิด-ปิดใช้งาน / เปลี่ยนรหัสผ่าน
            </p>
          </div>
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4" /> เพิ่มผู้ใช้
          </Button>
        </div>

        {/* Mobile cards */}
        <div className="sm:hidden space-y-3">
          {(users.data ?? []).map((u) => (
            <div
              key={u.id}
              className="bg-white border border-gray-200 rounded-xl p-4"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-700 flex items-center justify-center">
                  <UserCircle2 className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-900 truncate">
                    {u.fullName ?? u.username}
                  </p>
                  <p className="text-xs text-gray-500 truncate">
                    @{u.username} · {u.groupName ?? "-"}
                  </p>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    u.isActive
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-gray-100 text-gray-500"
                  }`}
                >
                  {u.isActive ? "ใช้งาน" : "ปิด"}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Button size="sm" variant="outline" onClick={() => openEdit(u)}>
                  <Edit3 className="w-3.5 h-3.5" /> แก้ไข
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setPwdDialogUserId(u.id);
                    setPwdValue("");
                  }}
                >
                  <KeyRound className="w-3.5 h-3.5" /> รหัสผ่าน
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-red-600"
                  onClick={() => {
                    if (confirm(`ลบผู้ใช้ ${u.username}?`))
                      deleteUser.mutate({ id: u.id });
                  }}
                >
                  <Trash2 className="w-3.5 h-3.5" /> ลบ
                </Button>
              </div>
            </div>
          ))}
        </div>

        {/* Desktop table */}
        <div className="hidden sm:block bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-xs text-gray-600 text-left">
                  <th className="px-4 py-2 font-semibold">Username</th>
                  <th className="px-4 py-2 font-semibold">ชื่อ-สกุล</th>
                  <th className="px-4 py-2 font-semibold">อีเมล</th>
                  <th className="px-4 py-2 font-semibold">กลุ่ม</th>
                  <th className="px-4 py-2 font-semibold">สถานะ</th>
                  <th className="px-4 py-2 font-semibold text-right">จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {(users.data ?? []).map((u) => (
                  <tr key={u.id} className="border-b border-gray-100">
                    <td className="px-4 py-2.5 font-medium text-gray-800">
                      {u.username}
                    </td>
                    <td className="px-4 py-2.5 text-gray-700">
                      {u.fullName ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{u.email ?? "—"}</td>
                    <td className="px-4 py-2.5 text-gray-600">
                      {u.groupName ?? "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          u.isActive
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-gray-100 text-gray-500"
                        }`}
                      >
                        {u.isActive ? "ใช้งาน" : "ปิด"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="inline-flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openEdit(u)}
                        >
                          <Edit3 className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setPwdDialogUserId(u.id);
                            setPwdValue("");
                          }}
                        >
                          <KeyRound className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-red-600"
                          onClick={() => {
                            if (confirm(`ลบผู้ใช้ ${u.username}?`))
                              deleteUser.mutate({ id: u.id });
                          }}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Create/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {form.id ? "แก้ไขผู้ใช้งาน" : "เพิ่มผู้ใช้งาน"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Username</Label>
              <Input
                disabled={!!form.id}
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
              />
            </div>
            {!form.id && (
              <div className="space-y-1.5">
                <Label>รหัสผ่าน</Label>
                <Input
                  type="password"
                  value={form.password}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, password: e.target.value }))
                  }
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label>ชื่อ-สกุล</Label>
              <Input
                value={form.fullName}
                onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>อีเมล</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>กลุ่มสิทธิ์</Label>
              <Select
                value={form.groupId ? String(form.groupId) : undefined}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, groupId: Number(v) }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="เลือกกลุ่ม" />
                </SelectTrigger>
                <SelectContent>
                  {(groups.data ?? []).map((g) => (
                    <SelectItem key={g.id} value={String(g.id)}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between pt-2">
              <Label htmlFor="is-active">สถานะเปิดใช้งาน</Label>
              <Switch
                id="is-active"
                checked={form.isActive}
                onCheckedChange={(c) => setForm((f) => ({ ...f, isActive: c }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              ยกเลิก
            </Button>
            <Button onClick={handleSubmit} disabled={createUser.isPending || updateUser.isPending}>
              บันทึก
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset password dialog */}
      <Dialog
        open={pwdDialogUserId !== null}
        onOpenChange={(o) => !o && setPwdDialogUserId(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>ตั้งรหัสผ่านใหม่</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>รหัสผ่านใหม่ (อย่างน้อย 6 ตัว)</Label>
            <Input
              type="password"
              value={pwdValue}
              onChange={(e) => setPwdValue(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPwdDialogUserId(null)}>
              ยกเลิก
            </Button>
            <Button
              onClick={async () => {
                if (!pwdDialogUserId) return;
                if (pwdValue.length < 6) {
                  toast.error("รหัสผ่านสั้นเกินไป");
                  return;
                }
                await resetPwd.mutateAsync({
                  id: pwdDialogUserId,
                  newPassword: pwdValue,
                });
                setPwdDialogUserId(null);
              }}
            >
              บันทึก
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
