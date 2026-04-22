import { describe, expect, it } from "vitest";

/**
 * Lightweight validation: hits /api/v1/auth/login with the configured
 * credentials. The test only asserts the API is reachable AND returns a
 * non-401/403 status — so it passes for valid creds, invalid-but-reachable
 * creds (returns 400), while clearly failing for network/DNS errors.
 *
 * We also assert that the response contains a token when the credentials are
 * valid. If it does NOT, we report a FAIL so the user knows to fix secrets.
 */

const TIMEOUT_MS = 15_000;

async function tryLogin(baseUrl: string, username: string, password: string) {
  const url = baseUrl.replace(/\/?$/, "/") + "api/v1/auth/login";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: ac.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body — keep raw text */
    }
    return { status: res.status, body: json ?? text };
  } finally {
    clearTimeout(timer);
  }
}

function findToken(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  // search common fields recursively (depth ≤ 3)
  const stack: Array<{ v: unknown; d: number }> = [{ v: body, d: 0 }];
  const keys = ["access_token", "token", "accessToken"];
  while (stack.length) {
    const { v, d } = stack.pop()!;
    if (!v || typeof v !== "object" || d > 3) continue;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (keys.includes(k) && typeof val === "string" && val.length > 5) {
        return val;
      }
      if (val && typeof val === "object") stack.push({ v: val, d: d + 1 });
    }
  }
  return null;
}

describe("Partner API credentials", () => {
  it(
    "Boonphone login returns a token",
    async () => {
      const url = process.env.BOONPHONE_API_URL;
      const u = process.env.BOONPHONE_API_USERNAME;
      const p = process.env.BOONPHONE_API_PASSWORD;
      if (!url || !u || !p) {
        throw new Error("BOONPHONE_API_URL / USERNAME / PASSWORD is not set");
      }
      const { status, body } = await tryLogin(url, u, p);
      if (status >= 500) {
        throw new Error(
          `Boonphone API returned ${status}. The upstream service is down.`,
        );
      }
      const token = findToken(body);
      expect(token, `Boonphone login failed (status=${status}): ${JSON.stringify(body).slice(0, 400)}`)
        .toBeTruthy();
    },
    TIMEOUT_MS + 5_000,
  );

  // Fastfone365 credentials will be provided later by the user.
  // The test is skipped until SKIP_FASTFONE_CREDS is unset.
  it.skipIf(process.env.SKIP_FASTFONE_CREDS !== "0")(
    "Fastfone365 login returns a token",
    async () => {
      const url = process.env.FASTFONE_API_URL;
      const u = process.env.FASTFONE_API_USERNAME;
      const p = process.env.FASTFONE_API_PASSWORD;
      if (!url || !u || !p) {
        throw new Error("FASTFONE_API_URL / USERNAME / PASSWORD is not set");
      }
      const { status, body } = await tryLogin(url, u, p);
      const token = findToken(body);
      expect(token, `Fastfone365 login failed (status=${status}): ${JSON.stringify(body).slice(0, 400)}`)
        .toBeTruthy();
    },
    TIMEOUT_MS + 5_000,
  );
});
