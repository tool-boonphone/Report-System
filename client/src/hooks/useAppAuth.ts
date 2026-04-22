import { trpc } from "@/lib/trpc";
import type { MenuCode, PermissionAction } from "@shared/const";
import { useCallback, useMemo } from "react";

/**
 * Report-System authentication hook (distinct from Manus OAuth).
 * Reads from trpc.auth.me.
 */
export function useAppAuth() {
  const utils = trpc.useUtils();
  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: async () => {
      utils.auth.me.setData(undefined, null);
      await utils.auth.me.invalidate();
    },
  });

  const me = meQuery.data ?? null;

  const can = useCallback(
    (menu: MenuCode, action: PermissionAction) => {
      if (!me) return false;
      if (me.group.isSuperAdmin) return true;
      const p = me.permissions.find((x) => x.menuCode === menu);
      if (!p) return false;
      switch (action) {
        case "view":
          return p.canView;
        case "add":
          return p.canAdd;
        case "edit":
          return p.canEdit;
        case "delete":
          return p.canDelete;
        case "approve":
          return p.canApprove;
        case "export":
          return p.canExport;
      }
    },
    [me],
  );

  return useMemo(
    () => ({
      me,
      isLoading: meQuery.isLoading,
      isAuthenticated: Boolean(me),
      isSuperAdmin: Boolean(me?.group.isSuperAdmin),
      can,
      refresh: () => meQuery.refetch(),
      logout: () => logoutMutation.mutateAsync(),
    }),
    [me, meQuery, logoutMutation, can],
  );
}
