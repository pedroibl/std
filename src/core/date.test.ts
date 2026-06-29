import { describe, expect, test } from "bun:test";

import { dateParts, daysSince, isoDate } from "./date";

// All instants are fixed Date literals — never `new Date()` — so the suite is deterministic and a
// stray ambient-clock read in the kit would surface as a failure rather than a flaky pass.

describe("isoDate", () => {
  test("returns the UTC calendar date as YYYY-MM-DD", () => {
    expect(isoDate(new Date("2026-06-29T12:00:00Z"))).toBe("2026-06-29");
  });

  test("is UTC, not tz-local — early-UTC instant differs from the America/Los_Angeles date", () => {
    // 01:30Z is still the previous evening in Los Angeles (UTC-7 in June, PDT).
    const instant = new Date("2026-06-29T01:30:00Z");
    expect(isoDate(instant)).toBe("2026-06-29"); // UTC day
    expect(dateParts(instant, "America/Los_Angeles").iso).toBe("2026-06-28"); // tz-local day
  });
});

describe("daysSince", () => {
  test("counts whole days between iso and the injected now", () => {
    expect(daysSince("2026-06-19T12:00:00Z", new Date("2026-06-29T12:00:00Z"))).toBe(10);
  });

  test("returns 0 when less than 24h apart", () => {
    expect(daysSince("2026-06-29T00:00:00Z", new Date("2026-06-29T23:00:00Z"))).toBe(0);
  });

  test("returns a negative number when iso is in the future (no clamping)", () => {
    expect(daysSince("2026-06-30T12:00:00Z", new Date("2026-06-29T12:00:00Z"))).toBe(-1);
  });

  test("returns NaN for an unparseable iso (pure transform, no throw)", () => {
    expect(Number.isNaN(daysSince("not-a-date", new Date("2026-06-29T12:00:00Z")))).toBe(true);
  });
});

describe("dateParts", () => {
  test("formats the calendar date in the supplied timezone — tz is a parameter", () => {
    // One fixed instant near a day boundary, three timezones → the tz drives the result.
    const instant = new Date("2026-06-29T15:30:00Z");
    expect(dateParts(instant, "UTC").iso).toBe("2026-06-29"); // 15:30 UTC
    expect(dateParts(instant, "America/Los_Angeles").iso).toBe("2026-06-29"); // 08:30 PDT
    expect(dateParts(instant, "Australia/Melbourne").iso).toBe("2026-06-30"); // 01:30 next day AEST (+10)
    // Proof the tz is honored, not the host: UTC and Melbourne land on different days.
    expect(dateParts(instant, "UTC").iso).not.toBe(dateParts(instant, "Australia/Melbourne").iso);
  });

  test("returns integer year/month/day that reconstruct the iso", () => {
    const p = dateParts(new Date("2026-06-30T01:30:00Z"), "Australia/Melbourne");
    expect(p).toEqual({ year: 2026, month: 6, day: 30, iso: "2026-06-30" });
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(`${p.year}-${pad(p.month)}-${pad(p.day)}`).toBe(p.iso);
  });
});
