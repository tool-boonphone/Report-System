import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { APP_SESSION_COOKIE } from "../../shared/const";
import { getUserFromSession, type AppUserWithGroup } from "../authDb";
import { sdk } from "./sdk";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  /** Manus OAuth user — kept for backward compatibility (unused by this app). */
  user: User | null;
  /** Report-System app user resolved from app_sessions cookie. */
  appUser: AppUserWithGroup | null;
};

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("=") ?? "");
  }
  return out;
}

export async function createContext(
  opts: CreateExpressContextOptions,
): Promise<TrpcContext> {
  let user: User | null = null;
  let appUser: AppUserWithGroup | null = null;

  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch {
    user = null;
  }

  const cookies = parseCookies(opts.req.headers.cookie);
  const sid = cookies[APP_SESSION_COOKIE];
  if (sid) {
    try {
      appUser = await getUserFromSession(sid);
    } catch (err) {
      console.warn("[context] session lookup failed", err);
      appUser = null;
    }
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
    appUser,
  };
}
