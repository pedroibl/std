import { describe, expect, test } from "bun:test";

import { dateParts, daysSince, isoDate, isoOffset } from "./date";

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

describe("isoOffset — tz-offset ISO timestamp YYYY-MM-DDTHH:MM:SS±HH:MM (Story 13.2 / P3)", () => {
  // Fixed instants + DST-free zones so the offsets are stable regardless of the run date.
  test("positive whole-hour offset (Australia/Brisbane, +10:00, no DST)", () => {
    expect(isoOffset(new Date("2026-07-13T04:00:00Z"), "Australia/Brisbane")).toBe(
      "2026-07-13T14:00:00+10:00",
    );
  });

  test("negative whole-hour offset (America/Phoenix, -07:00, no DST)", () => {
    expect(isoOffset(new Date("2026-07-13T12:00:00Z"), "America/Phoenix")).toBe(
      "2026-07-13T05:00:00-07:00",
    );
  });

  test("HALF-HOUR offset renders +05:30, not a dropped/mis-padded minutes field (Asia/Kolkata)", () => {
    // The mandatory guard: every whole-hour case would pass a broken ±HH:MM minutes path. Only a
    // sub-hour zone proves the minutes remainder is carried. (Story AC3.)
    expect(isoOffset(new Date("2026-07-13T04:00:00Z"), "Asia/Kolkata")).toBe(
      "2026-07-13T09:30:00+05:30",
    );
  });

  test("45-minute offset renders +05:45 (Asia/Kathmandu) — the minutes field generalizes", () => {
    expect(isoOffset(new Date("2026-07-13T04:00:00Z"), "Asia/Kathmandu")).toBe(
      "2026-07-13T09:45:00+05:45",
    );
  });

  test("UTC renders +00:00", () => {
    expect(isoOffset(new Date("2026-07-13T08:15:30Z"), "UTC")).toBe("2026-07-13T08:15:30+00:00");
  });

  test("crosses the day boundary in the target tz (Australia/Melbourne)", () => {
    // 2026-07-13 15:00Z is 2026-07-14 01:00 in Melbourne (AEST +10:00 in July).
    expect(isoOffset(new Date("2026-07-13T15:00:00Z"), "Australia/Melbourne")).toBe(
      "2026-07-14T01:00:00+10:00",
    );
  });

  test("throws RangeError on an Invalid Date (fail-loud, FR5)", () => {
    expect(() => isoOffset(new Date("garbage"), "UTC")).toThrow(RangeError);
  });

  test("throws RangeError on an invalid IANA tz (fail-loud, FR5)", () => {
    expect(() => isoOffset(new Date("2026-07-13T04:00:00Z"), "Not/AZone")).toThrow(RangeError);
  });
});

describe("invalid-input contract (fail-loud, FR5)", () => {
  // An Invalid Date or a non-IANA tz is a caller precondition violation — these surface RangeError
  // (the stdlib failure), never a swallowed/wrong-but-silent date. Validation belongs at the edge.
  test("isoDate throws RangeError on an Invalid Date", () => {
    expect(() => isoDate(new Date("garbage"))).toThrow(RangeError);
  });

  test("dateParts throws RangeError on an invalid IANA tz", () => {
    expect(() => dateParts(new Date("2026-06-29T12:00:00Z"), "Not/AZone")).toThrow(RangeError);
  });

  test("dateParts throws RangeError on an Invalid Date", () => {
    expect(() => dateParts(new Date("garbage"), "UTC")).toThrow(RangeError);
  });
});
