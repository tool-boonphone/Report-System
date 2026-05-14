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
    // กรอง transient errors ที่ retry ได้เอง ออกจาก console
    // เพื่อไม่ให้ user เห็น error notification ที่ไม่จำเป็น
    const msg = error instanceof TRPCClientError ? error.message : String(error);
    if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("AbortError")) return;
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

// Phase 32: เพิ่ม timeout สำหรับ tRPC requests
// - sync.trigger ใช้ 40 นาที เพราะ sync ทำงานแบบ synchronous (await จนเสร็จ)
// - request อื่นๆ ใช้ 120 วินาที
const TRPC_TIMEOUT_MS = 120_000; // 120 seconds (default)
const SYNC_TRIGGER_TIMEOUT_MS = 40 * 60 * 1000; // 40 minutes for sync.trigger

/**
 * Cold Start Retry: Cloud Run ใช้ min-instances=0 ทำให้ server shutdown เมื่อไม่มีคนใช้
 * เมื่อ server กำลัง boot ใหม่ จะส่ง HTTP 502/503 หรือ HTML "Service Unavailable" แทน JSON
 * ทำให้ tRPC parse fail ด้วย "Unexpected token 'S'" หรือ "Unexpected token '<'"
 * → ตรวจจับ error นี้แล้ว retry อัตโนมัติสูงสุด 5 ครั้ง ด้วย delay เพิ่มขึ้นเรื่อยๆ
 */
const COLD_START_RETRY_DELAYS = [3000, 5000, 8000, 12000, 15000]; // ms

async function fetchWithColdStartRetry(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const doFetch = () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    return globalThis.fetch(input, {
      ...(init ?? {}),
      credentials: "include",
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId));
  };

  // ลองครั้งแรก
  let res = await doFetch();

  // ถ้า server ส่ง 502/503 → cold start → retry
  if (res.status === 502 || res.status === 503) {
    for (const delay of COLD_START_RETRY_DELAYS) {
      console.warn(`[tRPC] Cold start detected (HTTP ${res.status}), retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
      res = await doFetch();
      if (res.status !== 502 && res.status !== 503) break;
    }
    return res;
  }

  // ถ้า response ไม่ใช่ JSON (HTML error page จาก cold start / proxy error)
  // ตรวจ content-type: ถ้าไม่มี application/json และไม่มี text/plain → น่าจะเป็น HTML
  const contentType = res.headers.get("content-type") ?? "";
  if (
    res.ok &&
    !contentType.includes("application/json") &&
    !contentType.includes("text/plain")
  ) {
    for (const delay of COLD_START_RETRY_DELAYS) {
      console.warn(`[tRPC] Non-JSON response (content-type: "${contentType}"), retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
      res = await doFetch();
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json") || ct.includes("text/plain")) break;
    }
  }

  return res;
}

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        // Use longer timeout for sync.trigger requests (synchronous long-running)
        const url = typeof input === "string" ? input
          : input instanceof URL ? input.toString()
          : (input as Request).url;
        const isSyncTrigger = url.includes("sync.trigger");
        const timeoutMs = isSyncTrigger ? SYNC_TRIGGER_TIMEOUT_MS : TRPC_TIMEOUT_MS;
        return fetchWithColdStartRetry(input, init, timeoutMs);
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
