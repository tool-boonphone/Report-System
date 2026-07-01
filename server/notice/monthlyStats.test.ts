import { describe, expect, it } from "vitest";

/** mirror of noticeDb bangkokMonthKey for unit test */
function bangkokMonthKey(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  if (!year || !month) return null;
  return `${year}-${month}`;
}

describe("bangkokMonthKey", () => {
  it("groups UTC evening into Bangkok month", () => {
    // 2026-06-30 20:00 UTC = 2026-07-01 03:00 Bangkok
    const key = bangkokMonthKey(new Date("2026-06-30T20:00:00.000Z"));
    expect(key).toBe("2026-07");
  });
});
