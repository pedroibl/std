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
// Pure deterministic transforms, NOT the Result union and NOT throwing. isoDate/dateParts are total
// over a valid Date; daysSince returns JS-native NaN for an unparseable `iso`. NaN is an invalid-input
// signal, not an error — do not "harden" any of these into Result or a throw.

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
