import { z } from "zod";
import { MENU_CODES } from "../../shared/const";
import {
  changeUserPassword,
  createGroup,
  createUser,
  deleteGroup,
  deleteUser,
  listGroupsWithPermissions,
  listUsers,
  updateGroup,
  updateGroupPermission,
  updateUser,
} from "../authDb";
import { router, superAdminProcedure } from "../_core/trpc";

export const adminRouter = router({
  /* -------- Users -------- */
  listUsers: superAdminProcedure.query(() => listUsers()),

  createUser: superAdminProcedure
    .input(
      z.object({
        username: z.string().min(3).max(64),
        password: z.string().min(6),
        fullName: z.string().optional().nullable(),
        email: z.string().email().optional().nullable(),
        groupId: z.number().int().positive(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await createUser(input);
      return { success: true as const };
    }),

  updateUser: superAdminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        fullName: z.string().nullable().optional(),
        email: z.string().email().nullable().optional(),
        groupId: z.number().int().positive().optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      await updateUser(id, patch);
      return { success: true as const };
    }),

  resetUserPassword: superAdminProcedure
    .input(z.object({ id: z.number().int().positive(), newPassword: z.string().min(6) }))
    .mutation(async ({ input }) => {
      await changeUserPassword(input.id, input.newPassword);
      return { success: true as const };
    }),

  deleteUser: superAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      if (input.id === ctx.appUser.id) {
        throw new Error("ไม่สามารถลบผู้ใช้ของตนเองได้");
      }
      await deleteUser(input.id);
      return { success: true as const };
    }),

  /* -------- Groups & Permissions -------- */
  listGroups: superAdminProcedure.query(() => listGroupsWithPermissions()),

  createGroup: superAdminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(64),
        description: z.string().optional().nullable(),
        allowedSections: z.string().optional(), // comma-separated e.g. "Boonphone,Fastfone365"
      }),
    )
    .mutation(async ({ input }) => {
      const id = await createGroup(input);
      return { id };
    }),

  updateGroup: superAdminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(64).optional(),
        description: z.string().nullable().optional(),
        allowedSections: z.string().optional(), // comma-separated, empty = all
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      await updateGroup(id, patch);
      return { success: true as const };
    }),

  deleteGroup: superAdminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await deleteGroup(input.id);
      return { success: true as const };
    }),

  updatePermission: superAdminProcedure
    .input(
      z.object({
        groupId: z.number().int().positive(),
        menuCode: z.enum(MENU_CODES as unknown as [string, ...string[]]),
        canView: z.boolean().optional(),
        canAdd: z.boolean().optional(),
        canEdit: z.boolean().optional(),
        canDelete: z.boolean().optional(),
        canApprove: z.boolean().optional(),
        canExport: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { groupId, menuCode, ...patch } = input;
      await updateGroupPermission(
        groupId,
        menuCode as (typeof MENU_CODES)[number],
        patch,
      );
      return { success: true as const };
    }),
});
