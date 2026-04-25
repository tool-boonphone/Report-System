import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import "./index.css";
import { AiChatProvider } from "@/contexts/AiChatContext";

const queryClient = new QueryClient();

const LOGIN_PATH = "/login";
const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;
  if (!isUnauthorized) return;
  if (window.location.pathname === LOGIN_PATH) return;

  window.location.href = LOGIN_PATH;
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

/**
 * Errors that are part of normal UX (invalid password, etc.) should NOT be
 * logged as console errors — the mutating page already surfaces them inline.
 * Everything else still hits console.error so we can investigate real bugs.
 */
const EXPECTED_MUTATION_ERRORS = new Set<string>([
  "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง",
  "รหัสผ่านปัจจุบันไม่ถูกต้อง",
]);

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    if (error instanceof TRPCClientError && EXPECTED_MUTATION_ERRORS.has(error.message)) {
      return;
    }
    console.error("[API Mutation Error]", error);
  }
});

// Phase 32: เพิ่ม timeout 120 วินาที สำหรับ Fastfone365 ที่มี payload ใหญ่
// (default fetch ไม่มี timeout แต่ reverse proxy มัก timeout ที่ ~30-60 วินาที)
const TRPC_TIMEOUT_MS = 120_000; // 120 seconds

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TRPC_TIMEOUT_MS);
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
          signal: controller.signal,
        }).finally(() => clearTimeout(timeoutId));
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      {/* AiChatProvider: share aiChatOpen state ระหว่าง TopNav และ AppShell */}
      <AiChatProvider>
        <App />
      </AiChatProvider>
    </QueryClientProvider>
  </trpc.Provider>
);
