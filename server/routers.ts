import { systemRouter } from "./_core/systemRouter";
import { router } from "./_core/trpc";
import { adminRouter } from "./routers/admin";
import { authRouter } from "./routers/auth";
import { contractsRouter } from "./routers/contracts";
import { badDebtRouter } from "./routers/badDebt";
import { debtRouter } from "./routers/debt";
import { syncRouter } from "./routers/sync";
import { aiRouter } from "./routers/ai";
import { monthlySummaryRouter } from "./routers/monthlySummary";
import { suspectedBadDebtRouter } from "./routers/suspectedBadDebt";
import { cacheRouter } from "./routers/cache";
import { accountingRouter } from "./routers/accounting";

export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  admin: adminRouter,
  sync: syncRouter,
  contracts: contractsRouter,
  debt: debtRouter,
  badDebt: badDebtRouter,
  ai: aiRouter,
  monthlySummary: monthlySummaryRouter,
  suspectedBadDebt: suspectedBadDebtRouter,
  cache: cacheRouter,
  accounting: accountingRouter,
});

export type AppRouter = typeof appRouter;
