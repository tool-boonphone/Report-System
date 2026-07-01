/**
 * Generic client for the Boonphone/Fastfone365 partner APIs.
 *
 * Both sections share the same REST surface, so we expose a single class that
 * is configured per-section. Responsibilities:
 *   1. Login + token caching + auto-refresh on 401.
 *   2. Paginated GET helpers with per-request timeout and retry.
 *   3. Uniform response unwrapping: `{ success, data, message }`.
 */

type PartnerConfig = {
  section: string;
  baseUrl: string;
  username: string;
  password: string;
  /** Per-request timeout (AbortController). Defaults to 20s. */
  timeoutMs?: number;
};

type LoginData = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

type ApiEnvelope<T = unknown> = {
  success: boolean;
  status_code: number;
  message: string;
  timestamp?: string;
  data?: T;
  errors?: unknown;
};

export class PartnerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: unknown,
    message: string,
  ) {
    super(message);
    this.name = "PartnerApiError";
  }
}

export class PartnerClient {
  private readonly cfg: Required<PartnerConfig>;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(cfg: PartnerConfig) {
    // Normalize baseUrl so we always have a trailing "/".
    const baseUrl = cfg.baseUrl.endsWith("/")
      ? cfg.baseUrl
      : `${cfg.baseUrl}/`;
    this.cfg = {
      timeoutMs: 20_000,
      ...cfg,
      baseUrl,
    };
  }

  /** Whether this client is configured with credentials. */
  isConfigured(): boolean {
    return Boolean(
      this.cfg.baseUrl && this.cfg.username && this.cfg.password,
    );
  }

  get section(): string {
    return this.cfg.section;
  }

  /** Force a fresh login. Invalidates the cached token. */
  async login(): Promise<string> {
    const url = `${this.cfg.baseUrl}api/v1/auth/login`;
    // Login has its own 15s timeout — separate from per-request timeoutMs.
    // Without this, a hung auth server will stall the entire sync indefinitely.
    const LOGIN_TIMEOUT_MS = 15_000;
    const res = await this.rawFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.cfg.username,
        password: this.cfg.password,
      }),
    }, LOGIN_TIMEOUT_MS);
    const body = (await res.json().catch(() => ({}))) as ApiEnvelope<LoginData>;
    if (!res.ok || !body?.data?.access_token) {
      throw new PartnerApiError(
        res.status,
        body,
        `[${this.cfg.section}] login failed: ${body?.message ?? res.statusText}`,
      );
    }
    const token = body.data.access_token;
    const ttlSec = body.data.expires_in ?? 60 * 60; // default 1h if not given
    this.token = token;
    // Refresh a bit before actual expiry.
    this.tokenExpiresAt = Date.now() + (ttlSec - 60) * 1000;
    return token;
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    return await this.login();
  }

  /** GET an API v1 endpoint and unwrap the `data` envelope. */
  async get<T = unknown>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    /** Override per-request timeout (ms). Defaults to this.cfg.timeoutMs. */
    timeoutMs?: number,
  ): Promise<T> {
    const url = new URL(`${this.cfg.baseUrl}api/v1/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }

    // Up to 3 attempts total (1 + 2 retries). Exponential backoff: 1s → 2s.
    // Retry only on AbortError (timeout) and TypeError (network failure) — not HTTP 4xx/5xx.
    // Per skill §13: per-request timeout 30s, retry 2 times with 1s→2s backoff.
    const delays = [1000, 2000];
    let lastErr: unknown = null;
    for (let attemptIdx = 0; attemptIdx <= delays.length; attemptIdx++) {
      try {
        const token = await this.getToken();
        const res = await this.rawFetch(url.toString(), {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }, timeoutMs);
        const body = (await res.json().catch(() => ({}))) as ApiEnvelope<T>;
        if (res.status === 401 && attemptIdx === 0) {
          // Token might have rotated server-side — invalidate and try once more.
          this.token = null;
          continue;
        }
        if (!res.ok || body?.success === false) {
          const err = new PartnerApiError(
            res.status,
            body,
            `[${this.cfg.section}] GET ${path} failed: ${body?.message ?? res.statusText}`,
          );
          // Retry only on 5xx / 429. 4xx are usually permanent.
          if (res.status < 500 && res.status !== 429) throw err;
          lastErr = err;
        } else {
          return body.data as T;
        }
      } catch (err: any) {
        // Network/abort errors: retry.
        lastErr = err;
      }
      const delay = delays[attemptIdx];
      if (delay === undefined) break;
      await new Promise((r) => setTimeout(r, delay));
    }
    throw lastErr ?? new Error(`[${this.cfg.section}] GET ${path} failed`);
  }

  /** Follow pagination until `has_next` is false. Calls `onPage` for each page. */
  async forEachPage<TItem>(
    path: string,
    /**
     * How to get the items array out of the returned `data` envelope. Different
     * endpoints use different keys (`contracts`, `installments`, `transactions`,
     * ...). The caller picks it.
     */
    pickItems: (data: any) => TItem[] | undefined,
    /** Extra params besides page/limit. */
    params: Record<string, string | number | undefined> = {},
    onPage: (items: TItem[], page: number, totalPages: number) => Promise<void> | void,
    limit = 100,
    /** Override per-request timeout (ms). Defaults to this.cfg.timeoutMs. */
    timeoutMs?: number,
    /**
     * Resume from this page number (1-based). Useful when a previous run was
     * killed mid-way and we want to continue from where we left off.
     * Defaults to 1 (start from the beginning).
     */
    startPage = 1,
    /**
     * If true, skip pages that fail (timeout/network error) instead of throwing.
     * Useful for best-effort syncs where partial data is acceptable.
     * Defaults to false.
     */
    skipOnError = false,
  ): Promise<number> {
    let page = Math.max(1, startPage);
    let totalPages = page; // will be updated on first fetch
    let totalRows = 0;
    let skippedPages = 0;
    // Protect against accidental infinite loops.
    const MAX_PAGES = 10_000;
    while (page <= totalPages && page <= MAX_PAGES) {
      try {
        const data: any = await this.get<any>(path, { ...params, page, limit }, timeoutMs);
        const items = pickItems(data) ?? [];
        totalPages = Number(data?.pagination?.total_pages ?? 1);
        totalRows += items.length;
        await onPage(items, page, totalPages);
        if (items.length === 0) break;
      } catch (err: any) {
        if (!skipOnError) throw err;
        // skipOnError=true: log and continue to next page
        skippedPages += 1;
        console.warn(`[${this.cfg.section}] forEachPage: skipping page ${page} due to error: ${err?.message ?? err}`);
        // If we don't know totalPages yet (first page failed), we can't continue
        if (page === Math.max(1, startPage) && totalPages === page) {
          console.warn(`[${this.cfg.section}] forEachPage: first page failed, cannot determine totalPages — stopping`);
          break;
        }
      }
      page += 1;
    }
    if (skippedPages > 0) {
      console.warn(`[${this.cfg.section}] forEachPage: completed with ${skippedPages} skipped pages out of ${totalPages}`);
    }
    return totalRows;
  }

  /**
   * Parallel-batch version of forEachPage.
   * Fetches `batchSize` pages concurrently, waits `delayMs` ms between batches.
   * Useful for APIs that are slow per-request but support concurrent calls.
   *
   * Strategy:
   *  1. Fetch page `startPage` first to learn totalPages.
   *  2. Fetch remaining pages in parallel batches of `batchSize`.
   *  3. Call `onPage` for each page in ascending order.
   */
  async forEachPageParallel<TItem>(
    path: string,
    pickItems: (data: any) => TItem[] | undefined,
    params: Record<string, string | number | undefined> = {},
    onPage: (items: TItem[], page: number, totalPages: number) => Promise<void> | void,
    limit = 100,
    timeoutMs?: number,
    startPage = 1,
    batchSize = 5,
    delayMs = 100,
    skipOnError = false,
    onProgress?: (page: number, totalPages: number) => void,
  ): Promise<number> {
    let totalPages = startPage;
    let totalRows = 0;
    let skippedPages = 0;

    // Step 1: fetch startPage to learn totalPages.
    try {
      const data: any = await this.get<any>(path, { ...params, page: startPage, limit }, timeoutMs);
      const items = pickItems(data) ?? [];
      totalPages = Number(data?.pagination?.total_pages ?? 1);
      totalRows += items.length;
      await onPage(items, startPage, totalPages);
      onProgress?.(startPage, totalPages);
    } catch (err: any) {
      if (!skipOnError) throw err;
      skippedPages += 1;
      console.warn(`[${this.cfg.section}] forEachPageParallel: skipping page ${startPage} (first page) — cannot determine totalPages: ${err?.message ?? err}`);
      return 0;
    }

    if (totalPages <= startPage) return totalRows;

    // Step 2: fetch remaining pages in parallel batches
    for (let batchStart = startPage + 1; batchStart <= totalPages; batchStart += batchSize) {
      const batchEnd = Math.min(batchStart + batchSize - 1, totalPages);
      const pageNums = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);

      const batchResults = await Promise.allSettled(
        pageNums.map(async (page) => {
          const data: any = await this.get<any>(path, { ...params, page, limit }, timeoutMs);
          const items = pickItems(data) ?? [];
          return { page, items };
        }),
      );

      // Process results in page order
      for (let i = 0; i < pageNums.length; i++) {
        const result = batchResults[i];
        const page = pageNums[i];
        if (result.status === "fulfilled") {
          totalRows += result.value.items.length;
          await onPage(result.value.items, page, totalPages);
          onProgress?.(page, totalPages);
        } else {
          skippedPages += 1;
          console.warn(`[${this.cfg.section}] forEachPageParallel: skipping page ${page}: ${result.reason?.message ?? result.reason}`);
          if (!skipOnError) throw result.reason;
        }
      }

      // Delay between batches to avoid overwhelming the API
      if (batchEnd < totalPages) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    if (skippedPages > 0) {
      console.warn(`[${this.cfg.section}] forEachPageParallel: completed with ${skippedPages} skipped pages out of ${totalPages}`);
    }
    return totalRows;
  }

  /** Raw fetch with timeout via AbortController. */
  private async rawFetch(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs ?? this.cfg.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Build client from env for a given section. Returns null if not configured. */
export function buildClientFromEnv(
  section: "Boonphone" | "Fastfone365",
): PartnerClient | null {
  const prefix = section === "Boonphone" ? "BOONPHONE" : "FASTFONE";
  const baseUrl = process.env[`${prefix}_API_URL`];
  const username = process.env[`${prefix}_API_USERNAME`] ?? process.env[`${prefix}_USERNAME`];
  const password = process.env[`${prefix}_API_PASSWORD`] ?? process.env[`${prefix}_PASSWORD`];
  if (!baseUrl || !username || !password) return null;
  return new PartnerClient({ section, baseUrl, username, password });
}
