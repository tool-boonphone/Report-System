import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  APP_SESSION_COOKIE,
  APP_SESSION_TTL_MS,
  MENU_CODES,
} from "../../shared/const";
import {
  authenticate,
  changeUserPassword,
  createSession,
  destroySession,
} from "../authDb";
import { appUsers } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { getDb } from "../db";
import { appProcedure, publicProcedure, router } from "../_core/trpc";

function cookieOptions(req: { protocol?: string; headers: Record<string, unknown> }) {
  const forwardedProto = req.headers["x-forwarded-proto"] as string | undefined;
  const secure =
    req.protocol === "https" ||
    (typeof forwardedProto === "string" && forwardedProto.includes("https"));
  return {
    httpOnly: true,
    path: "/",
    sameSite: "none" as const,
    secure,
    maxAge: APP_SESSION_TTL_MS,
  };
}

export const authRouter = router({
  /** Current logged-in user + permissions for client gating. */
  me: publicProcedure.query(({ ctx }) => {
    if (!ctx.appUser) return null;
    return {
      id: ctx.appUser.id,
      username: ctx.appUser.username,
      fullName: ctx.appUser.fullName,
      email: ctx.appUser.email,
      group: {
        id: ctx.appUser.group.id,
        name: ctx.appUser.group.name,
        isSuperAdmin: ctx.appUser.group.isSuperAdmin,
      },
      permissions: ctx.appUser.permissions.map((p) => ({
        menuCode: p.menuCode,
        canView: p.canView,
        canAdd: p.canAdd,
        canEdit: p.canEdit,
        canDelete: p.canDelete,
        canApprove: p.canApprove,
        canExport: p.canExport,
      })),
      menuCodes: MENU_CODES,
    };
  }),

  login: publicProcedure
    .input(
      z.object({
        username: z.string().min(1, "กรุณาระบุชื่อผู้ใช้"),
        password: z.string().min(1, "กรุณาระบุรหัสผ่าน"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = await authenticate(input.username, input.password);
      if (!user) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง",
        });
      }
      const sid = await createSession(user.id);
      ctx.res.cookie(APP_SESSION_COOKIE, sid, cookieOptions(ctx.req));
      return { success: true as const };
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    const cookieHeader = ctx.req.headers.cookie ?? "";
    const match = cookieHeader.match(
      new RegExp(`${APP_SESSION_COOKIE}=([^;]+)`),
    );
    if (match) await destroySession(match[1]);
    ctx.res.clearCookie(APP_SESSION_COOKIE, {
      ...cookieOptions(ctx.req),
      maxAge: -1,
    });
    return { success: true as const };
  }),

  /** Authenticated user can change their own password. */
  changePassword: appProcedure
    .input(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(6, "รหัสผ่านใหม่ต้องยาวอย่างน้อย 6 ตัว"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select()
        .from(appUsers)
        .where(eq(appUsers.id, ctx.appUser.id))
        .limit(1);
      const me = rows[0];
      if (!me) throw new TRPCError({ code: "NOT_FOUND" });

      const ok = await bcrypt.compare(input.currentPassword, me.passwordHash);
      if (!ok) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "รหัสผ่านปัจจุบันไม่ถูกต้อง",
        });
      }
      await changeUserPassword(me.id, input.newPassword);
      return { success: true as const };
    }),
});
