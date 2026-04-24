import { systemRouter } from "./_core/systemRouter";
import { router } from "./_core/trpc";
import { adminRouter } from "./routers/admin";
import { authRouter } from "./routers/auth";
import { contractsRouter } from "./routers/contracts";
import { badDebtRouter } from "./routers/badDebt";
import { debtRouter } from "./routers/debt";
import { syncRouter } from "./routers/sync";

export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  admin: adminRouter,
  sync: syncRouter,
  contracts: contractsRouter,
  debt: debtRouter,
  badDebt: badDebtRouter,
});

export type AppRouter = typeof appRouter;
