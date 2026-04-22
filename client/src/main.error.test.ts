/**
 * Targeted test for the "expected mutation errors" allowlist.
 *
 * main.tsx suppresses console.error for a small set of UX-level TRPC
 * errors (invalid login, invalid old password, deactivated account) so
 * that expected user mistakes don't spam the error monitor. This test
 * pins down that behaviour at the unit level — it's a lot cheaper than
 * spinning up JSDOM just to verify a Set membership, and it protects
 * against someone renaming the strings in one place but not the other.
 */
import { describe, expect, it } from "vitest";

// Re-declare the allowlist locally; the source lives in main.tsx which
// pulls in the React app and isn't safely importable in Node tests.
// We intentionally mirror the strings here so a divergence is caught
// by a failing test when the list drifts.
const EXPECTED_MUTATION_ERRORS = new Set<string>([
  "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง",
  "รหัสผ่านปัจจุบันไม่ถูกต้อง",
]);

// These are the exact messages the server throws today — if the server
// renames them, this test fails and forces us to update both places.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("expected mutation error allowlist", () => {
  it("contains the tRPC messages the backend currently throws", () => {
    const authSrc = readFileSync(
      resolve(__dirname, "../../server/routers/auth.ts"),
      "utf8",
    );

    // Assert each allowlisted message is actually thrown somewhere in
    // the auth router — otherwise the allowlist is stale.
    for (const msg of EXPECTED_MUTATION_ERRORS) {
      expect(authSrc, `backend should still throw: ${msg}`).toContain(msg);
    }
  });

  it("stays in sync with the string used in main.tsx", () => {
    const mainSrc = readFileSync(
      resolve(__dirname, "./main.tsx"),
      "utf8",
    );

    for (const msg of EXPECTED_MUTATION_ERRORS) {
      expect(mainSrc, `main.tsx allowlist must include: ${msg}`).toContain(msg);
    }
  });
});
