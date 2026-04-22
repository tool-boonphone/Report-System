import { systemRouter } from "./_core/systemRouter";
import { router } from "./_core/trpc";
import { adminRouter } from "./routers/admin";
import { authRouter } from "./routers/auth";
import { syncRouter } from "./routers/sync";

export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  admin: adminRouter,
  sync: syncRouter,
});

export type AppRouter = typeof appRouter;
