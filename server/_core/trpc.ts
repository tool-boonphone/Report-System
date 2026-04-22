import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "@shared/const";
import type { MenuCode, PermissionAction } from "@shared/const";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { checkPermission } from "../authDb";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

/** Legacy OAuth-user guard (kept for framework compatibility). */
const requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});
export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;
    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    return next({ ctx: { ...ctx, user: ctx.user } });
  }),
);

/* --------------------------------------------------------------------------
 * Report-System custom auth guards
 * ------------------------------------------------------------------------ */

/** Requires a signed-in Report-System user (from app_sessions). */
export const appProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;
    if (!ctx.appUser) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    }
    return next({ ctx: { ...ctx, appUser: ctx.appUser } });
  }),
);

/** Requires Super Admin group membership. */
export const superAdminProcedure = appProcedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;
    if (!ctx.appUser || !ctx.appUser.group.isSuperAdmin) {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    return next({ ctx: { ...ctx, appUser: ctx.appUser } });
  }),
);

/** Factory: guard by (menu, action) from the permission matrix. */
export function requirePermission(menu: MenuCode, action: PermissionAction) {
  return appProcedure.use(
    t.middleware(async (opts) => {
      const { ctx, next } = opts;
      if (!ctx.appUser || !checkPermission(ctx.appUser, menu, action)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `ไม่มีสิทธิ์ ${action} สำหรับเมนู ${menu}`,
        });
      }
      return next({ ctx: { ...ctx, appUser: ctx.appUser } });
    }),
  );
}
