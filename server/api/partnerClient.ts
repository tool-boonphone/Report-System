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
    const res = await this.rawFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.cfg.username,
        password: this.cfg.password,
      }),
    });
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
  ): Promise<T> {
    const url = new URL(`${this.cfg.baseUrl}api/v1/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }

    // Up to 4 attempts total (1 + 3 retries). Delays: 1s, 3s, 9s.
    const delays = [1000, 3000, 9000];
    let lastErr: unknown = null;
    for (let attemptIdx = 0; attemptIdx <= delays.length; attemptIdx++) {
      try {
        const token = await this.getToken();
        const res = await this.rawFetch(url.toString(), {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
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
  ): Promise<number> {
    let page = 1;
    let totalPages = 1;
    let totalRows = 0;
    // Protect against accidental infinite loops.
    const MAX_PAGES = 10_000;
    while (page <= totalPages && page <= MAX_PAGES) {
      const data: any = await this.get<any>(path, { ...params, page, limit });
      const items = pickItems(data) ?? [];
      totalPages = Number(data?.pagination?.total_pages ?? 1);
      totalRows += items.length;
      await onPage(items, page, totalPages);
      if (items.length === 0) break;
      page += 1;
    }
    return totalRows;
  }

  /** Raw fetch with timeout via AbortController. */
  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
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
  const username = process.env[`${prefix}_API_USERNAME`];
  const password = process.env[`${prefix}_API_PASSWORD`];
  if (!baseUrl || !username || !password) return null;
  return new PartnerClient({ section, baseUrl, username, password });
}
