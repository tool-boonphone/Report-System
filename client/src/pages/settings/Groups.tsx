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
  SECTIONS,
  type MenuCode,
  type PermissionAction,
  type SectionKey,
} from "@shared/const";
import { Edit3, Loader2, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type GroupRow = {
  id: number;
  name: string;
  description: string | null;
  isSuperAdmin: boolean;
  allowedSections: string;
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

/** Parse comma-separated allowedSections string to a Set */
function parseAllowedSections(raw: string): Set<SectionKey> {
  if (!raw || raw.trim() === "") return new Set(); // empty = all
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is SectionKey => SECTIONS.includes(s as SectionKey)),
  );
}

/** Serialize Set<SectionKey> back to comma-separated string */
function serializeAllowedSections(set: Set<SectionKey>): string {
  if (set.size === 0 || set.size === SECTIONS.length) return ""; // empty = all
  return Array.from(set).join(",");
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
    allowedSections: Set<SectionKey>;
  }>({ name: "", description: "", allowedSections: new Set() });

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
    setForm({ name: "", description: "", allowedSections: new Set() });
    setDialogOpen(true);
  }
  function openEdit(g: GroupRow) {
    setForm({
      id: g.id,
      name: g.name,
      description: g.description ?? "",
      allowedSections: parseAllowedSections(g.allowedSections ?? ""),
    });
    setDialogOpen(true);
  }
  async function handleSubmit() {
    if (!form.name.trim()) return toast.error("กรุณาระบุชื่อกลุ่ม");
    const allowedSections = serializeAllowedSections(form.allowedSections);
    if (form.id) {
      await updateMut.mutateAsync({
        id: form.id,
        name: form.name.trim(),
        description: form.description || null,
        allowedSections,
      });
    } else {
      await createMut.mutateAsync({
        name: form.name.trim(),
        description: form.description || null,
        allowedSections,
      });
    }
    setDialogOpen(false);
  }

  function toggleFormSection(s: SectionKey) {
    setForm((f) => {
      const next = new Set(f.allowedSections);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return { ...f, allowedSections: next };
    });
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
              กำหนดสิทธิ์แบบรายเมนูและ Section ที่เข้าถึงได้ให้แต่ละกลุ่ม
            </p>
          </div>
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4" /> เพิ่มกลุ่ม
          </Button>
        </div>

        {(groups.data ?? []).map((g) => {
          const gRow = g as GroupRow;
          const allowedSet = parseAllowedSections(gRow.allowedSections ?? "");
          const allSections = allowedSet.size === 0; // empty = all

          return (
            <div
              key={g.id}
              className="bg-white border border-gray-200 rounded-xl overflow-hidden"
            >
              {/* Group header */}
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
                    <Button size="sm" variant="ghost" onClick={() => openEdit(gRow)}>
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

              {/* Section access row */}
              <div className="px-4 py-2.5 bg-blue-50 border-b border-blue-100 flex items-center gap-3 flex-wrap">
                <span className="text-xs font-semibold text-blue-700 shrink-0">
                  Section ที่เข้าถึงได้:
                </span>
                {g.isSuperAdmin ? (
                  <span className="text-xs text-blue-600 font-medium">ทุก Section (Super Admin)</span>
                ) : allSections ? (
                  <span className="text-xs text-gray-500">ทุก Section</span>
                ) : (
                  SECTIONS.map((s) => (
                    <span
                      key={s}
                      className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        allowedSet.has(s as SectionKey)
                          ? "bg-blue-600 text-white"
                          : "bg-gray-200 text-gray-400 line-through"
                      }`}
                    >
                      {s}
                    </span>
                  ))
                )}
              </div>

              {/* Permission table */}
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
                      // section_switch: only canView matters
                      const isSectionSwitch = menu === "section_switch";
                      return (
                        <tr
                          key={menu}
                          className={
                            "border-b border-gray-100 last:border-0 transition-colors cursor-default" +
                            (isSectionSwitch ? " bg-blue-50 hover:bg-blue-100" : " hover:bg-blue-50 hover:shadow-[inset_3px_0_0_0_#3b82f6]")
                          }
                        >
                          <td className="px-3 py-2 text-gray-800 font-medium">
                            {MENU_LABELS[menu]}
                            {isSectionSwitch && (
                              <span className="ml-2 text-[10px] text-blue-600 bg-blue-100 px-1.5 py-0.5 rounded font-normal">
                                เฉพาะ ดู
                              </span>
                            )}
                          </td>
                          {PERMISSION_ACTIONS.map((a) => {
                            const field = actionField(a);
                            const checked = perm
                              ? (perm[field] as boolean)
                              : false;
                            // For section_switch, only show canView; others are disabled/hidden
                            if (isSectionSwitch && a !== "view") {
                              return (
                                <td key={a} className="px-3 py-2 text-center">
                                  <span className="text-gray-200">—</span>
                                </td>
                              );
                            }
                            return (
                              <td key={a} className="px-3 py-2 text-center">
                                <Checkbox
                                  checked={checked}
                                  disabled={g.isSuperAdmin}
                                  onCheckedChange={(c) =>
                                    togglePermission(
                                      gRow,
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
          );
        })}
      </div>

      {/* Create/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{form.id ? "แก้ไขกลุ่ม" : "เพิ่มกลุ่ม"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
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
            {/* Section access control */}
            <div className="space-y-2">
              <Label>Section ที่เข้าถึงได้</Label>
              <p className="text-xs text-gray-500">
                ไม่เลือก = เข้าถึงได้ทุก Section, เลือกเฉพาะ = จำกัดเฉพาะ Section ที่เลือก
              </p>
              <div className="flex gap-3 flex-wrap">
                {SECTIONS.map((s) => (
                  <label
                    key={s}
                    className="flex items-center gap-2 cursor-pointer select-none"
                  >
                    <Checkbox
                      checked={form.allowedSections.has(s)}
                      onCheckedChange={() => toggleFormSection(s)}
                    />
                    <span className="text-sm font-medium">{s}</span>
                  </label>
                ))}
              </div>
                {form.allowedSections.size > 0 && (
                <p className="text-xs text-blue-600">
                  จำกัดเฉพาะ: {Array.from(form.allowedSections).join(", ")}
                </p>
              )}
              {form.allowedSections.size === 0 && (
                <p className="text-xs text-gray-400">เข้าถึงได้ทุก Section</p>
              )}
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
