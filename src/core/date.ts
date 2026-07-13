// Story 9.4 — the date kit: a UTC date stamp, a whole-day delta, and tz-local calendar parts. The
// three date idioms re-rolled ~12× across PAI/Tools — `new Date().toISOString().split('T')[0]`
// (WisdomFrameUpdater, OpinionTracker), the `Date.now()`-based day delta (Recommend), and the
// `Intl`/`toLocaleDateString` "today in America/Los_Angeles" (HealthSnapshot, DAGrowth, FailureCapture,
// Arthur). Pure (D1): zero node:*/fs/DOM/network, no process/document.
//
// `Date` and `Intl` ARE used, but the AMBIENT clock and host timezone are NOT read: `now` (a Date) and
// `tz` (an IANA string) are injected by the edge. That is the whole point — `Date.now()`, an arg-less
// `new Date()`, and a default-locale/timezone Intl call would each read ambient state and break D1/D4.
// The hardcoded `America/Los_Angeles` every origin bakes in is caller identity (D4); it stays in the caller.
//
// Error model — pure over VALID inputs, fail-loud on invalid ones (no Result, no swallowing):
//   • isoDate / dateParts are total over a valid Date; they throw RangeError on an Invalid Date, and
//     dateParts also throws RangeError on an invalid IANA `tz` (the stdlib `toISOString` / `Intl`
//     RangeError, surfaced). These are caller precondition violations — a config typo, an unparsed
//     Date — surfaced loudly per fail-loud (FR5), never swallowed into a wrong-but-silent date.
//     Validate the Date/tz at the edge that sources them.
//   • daysSince returns JS-native NaN for an unparseable `iso` (a number-returning shaper; NaN is its
//     natural "unknown", not an error).
// "No throw" applies to the SHAPING of valid inputs — do not harden that into Result; equally, do not
// swallow a genuinely invalid Date/tz into a fallback.

/** Calendar date in a given timezone: integer parts plus the assembled `YYYY-MM-DD` string. */
export interface DateParts {
  year: number;
  month: number;
  day: number;
  iso: string;
}

/**
 * The UTC calendar date of `now` as `YYYY-MM-DD`. Unifies the `toISOString().split('T')[0]` idiom,
 * with the ambient `new Date()` lifted to an injected `now`.
 *
 * UTC, timezone-independent — for a tz-local date use `dateParts(now, tz).iso`.
 *
 * Throws `RangeError` on an Invalid Date (caller precondition — fail-loud per FR5, not swallowed).
 */
export function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Whole-day count from `iso` to `now`: `floor((now - iso) / 1 day)`. `iso` is anything `new Date`
 * accepts; `now` is the injected clock. Negative when `iso` is in the future (no clamping); `NaN` when
 * `iso` is unparseable — both faithful to the origin, neither an error.
 */
export function daysSince(iso: string, now: Date): number {
  const then = new Date(iso).getTime();
  return Math.floor((now.getTime() - then) / (1000 * 60 * 60 * 24));
}

/**
 * Calendar date of `now` in IANA timezone `tz`, as `{ year, month, day, iso }`. `tz` is required —
 * there is no default (a default would bake one consumer's timezone (D4), and an undefined-timezone
 * Intl call would read the host tz (D1)). Built from `Intl.DateTimeFormat(...).formatToParts` for
 * robust integer extraction rather than splitting a locale-formatted string.
 *
 * Throws `RangeError` on an Invalid Date or an invalid IANA `tz` (caller precondition — validate at
 * the edge that sources the tz; fail-loud per FR5, not swallowed into a wrong-but-silent date).
 */
export function dateParts(now: Date, tz: string): DateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)!.value;
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  return { year: Number(yyyy), month: Number(mm), day: Number(dd), iso: `${yyyy}-${mm}-${dd}` };
}

/**
 * ISO-8601 timestamp of `now` in IANA timezone `tz`, WITH the tz offset: `YYYY-MM-DDTHH:MM:SS±HH:MM`
 * (e.g. `2026-07-13T09:30:00+05:30`). The tz-offset sibling of the UTC-only `isoDate` — it unifies the
 * hooks' `getISOTimestamp` (`lib/time.ts`), which emits this exact shape from `getPrincipal().timezone`.
 *
 * `now` (a Date) and `tz` (an IANA string) are injected — no ambient clock, no host tz, no baked zone
 * (D1/D4). Built from a single `Intl.DateTimeFormat(...).formatToParts` (the host-tz-free path
 * `dateParts` already uses), with the offset computed NUMERICALLY as (tz-local wall clock read as UTC) −
 * (the real UTC instant), in whole minutes. That is deliberate: it is NOT parsed from a `shortOffset`
 * string (which renders `+5:30` with an unpadded hour and is easy to mis-split), and NOT the
 * `toLocaleString`-round-trip hack `lib/time.ts` uses. Sub-hour zones render correctly because the
 * minutes field carries the true remainder — `Asia/Kolkata` → `+05:30`, `Asia/Kathmandu` → `+05:45`.
 *
 * Throws `RangeError` on an Invalid Date or an invalid IANA `tz` (caller precondition — fail-loud per
 * FR5, matching `isoDate`/`dateParts`; validate at the edge that sources the tz).
 */
export function isoOffset(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)!.value;
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const hh = get("hour");
  const min = get("minute");
  const ss = get("second");

  // Offset in whole minutes = (the tz-local wall clock, read as if it were UTC) − (the real UTC instant).
  // Robust for sub-hour zones — the ±HH:MM minutes field carries the true remainder — with no string parsing.
  const asUtc = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss));
  const offsetMin = Math.round((asUtc - now.getTime()) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offHH = String(Math.floor(abs / 60)).padStart(2, "0");
  const offMM = String(abs % 60).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}${sign}${offHH}:${offMM}`;
}
