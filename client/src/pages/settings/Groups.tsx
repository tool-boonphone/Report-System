import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAppAuth } from "@/hooks/useAppAuth";
import { trpc } from "@/lib/trpc";
import {
  MENU_CODES,
  MENU_LABELS,
  PERMISSION_ACTIONS,
  PERMISSION_ACTION_LABELS,
  type MenuCode,
  type PermissionAction,
} from "@shared/const";
import { Edit3, Loader2, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type GroupRow = {
  id: number;
  name: string;
  description: string | null;
  isSuperAdmin: boolean;
  permissions: Array<{
    groupId: number;
    menuCode: string;
    canView: boolean;
    canAdd: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canApprove: boolean;
    canExport: boolean;
  }>;
};

function actionField(a: PermissionAction):
  | "canView"
  | "canAdd"
  | "canEdit"
  | "canDelete"
  | "canApprove"
  | "canExport" {
  switch (a) {
    case "view":
      return "canView";
    case "add":
      return "canAdd";
    case "edit":
      return "canEdit";
    case "delete":
      return "canDelete";
    case "approve":
      return "canApprove";
    case "export":
      return "canExport";
  }
}

export default function GroupsSettings() {
  const { isSuperAdmin, isLoading } = useAppAuth();
  const utils = trpc.useUtils();
  const groups = trpc.admin.listGroups.useQuery(undefined, {
    enabled: isSuperAdmin,
  });

  const createMut = trpc.admin.createGroup.useMutation({
    onSuccess: () => {
      utils.admin.listGroups.invalidate();
      toast.success("สร้างกลุ่มสำเร็จ");
    },
    onError: (e) => toast.error(e.message),
  });
  const updateMut = trpc.admin.updateGroup.useMutation({
    onSuccess: () => utils.admin.listGroups.invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const deleteMut = trpc.admin.deleteGroup.useMutation({
    onSuccess: () => {
      utils.admin.listGroups.invalidate();
      toast.success("ลบกลุ่มสำเร็จ");
    },
    onError: (e) => toast.error(e.message),
  });
  const permMut = trpc.admin.updatePermission.useMutation({
    onSuccess: () => utils.admin.listGroups.invalidate(),
    onError: (e) => toast.error(e.message),
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<{
    id?: number;
    name: string;
    description: string;
  }>({ name: "", description: "" });

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
    setForm({ name: "", description: "" });
    setDialogOpen(true);
  }
  function openEdit(g: GroupRow) {
    setForm({ id: g.id, name: g.name, description: g.description ?? "" });
    setDialogOpen(true);
  }
  async function handleSubmit() {
    if (!form.name.trim()) return toast.error("กรุณาระบุชื่อกลุ่ม");
    if (form.id) {
      await updateMut.mutateAsync({
        id: form.id,
        name: form.name.trim(),
        description: form.description || null,
      });
    } else {
      await createMut.mutateAsync({
        name: form.name.trim(),
        description: form.description || null,
      });
    }
    setDialogOpen(false);
  }

  async function togglePermission(
    g: GroupRow,
    menu: MenuCode,
    action: PermissionAction,
    value: boolean,
  ) {
    const field = actionField(action);
    await permMut.mutateAsync({
      groupId: g.id,
      menuCode: menu,
      [field]: value,
    } as Parameters<typeof permMut.mutateAsync>[0]);
  }

  return (
    <AppShell requireSection={false}>
      <div className="max-w-screen-xl mx-auto px-4 py-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-lg sm:text-xl font-semibold text-gray-900">
              จัดการกลุ่มสิทธิ์
            </h1>
            <p className="text-xs text-gray-500">
              กำหนดสิทธิ์แบบรายเมนูให้แต่ละกลุ่ม
            </p>
          </div>
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4" /> เพิ่มกลุ่ม
          </Button>
        </div>

        {(groups.data ?? []).map((g) => (
          <div
            key={g.id}
            className="bg-white border border-gray-200 rounded-xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-wrap gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-gray-900">{g.name}</h2>
                  {g.isSuperAdmin && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                      SUPER ADMIN
                    </span>
                  )}
                </div>
                {g.description && (
                  <p className="text-xs text-gray-500 mt-0.5">{g.description}</p>
                )}
              </div>
              {!g.isSuperAdmin && (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => openEdit(g as GroupRow)}>
                    <Edit3 className="w-4 h-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-600"
                    onClick={() => {
                      if (confirm(`ลบกลุ่ม ${g.name}?`))
                        deleteMut.mutate({ id: g.id });
                    }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr className="text-xs text-gray-600">
                    <th className="px-3 py-2 text-left font-semibold">เมนู</th>
                    {PERMISSION_ACTIONS.map((a) => (
                      <th key={a} className="px-3 py-2 text-center font-semibold">
                        {PERMISSION_ACTION_LABELS[a]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {MENU_CODES.map((menu) => {
                    const perm = g.permissions.find(
                      (p) => p.menuCode === menu,
                    );
                    return (
                      <tr key={menu} className="border-b border-gray-100 last:border-0">
                        <td className="px-3 py-2 text-gray-800">
                          {MENU_LABELS[menu]}
                        </td>
                        {PERMISSION_ACTIONS.map((a) => {
                          const field = actionField(a);
                          const checked = perm
                            ? (perm[field] as boolean)
                            : false;
                          return (
                            <td key={a} className="px-3 py-2 text-center">
                              <Checkbox
                                checked={checked}
                                disabled={g.isSuperAdmin}
                                onCheckedChange={(c) =>
                                  togglePermission(
                                    g as GroupRow,
                                    menu,
                                    a,
                                    Boolean(c),
                                  )
                                }
                              />
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      {/* Create/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{form.id ? "แก้ไขกลุ่ม" : "เพิ่มกลุ่ม"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>ชื่อกลุ่ม</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>คำอธิบาย</Label>
              <Textarea
                rows={3}
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              ยกเลิก
            </Button>
            <Button onClick={handleSubmit}>บันทึก</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
