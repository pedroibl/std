// Story 13.7 signature test — the time.ts frozen-facade byte-parity golden test (AC1).
//
// time.ts's internals were collapsed onto core.isoOffset / core.dateParts BEHIND byte-stable export
// signatures. This test is the Rule-3 contract's teeth: it proves each export emits IDENTICAL bytes to
// the pre-collapse hand-rolled algorithm — 12 importers across 4 clusters (incl. 3 live 13.3 hooks)
// depend on getISOTimestamp not shifting a single byte.
//
// Hermetic + deterministic: the clock is frozen with `setSystemTime`; the tz is read from the SAME
// getPrincipal() the impl reads, so the facade assertions are portable (adapt to whatever tz is
// configured) while the golden-literal block pins the exact Melbourne bytes.

import { afterAll, describe, expect, setSystemTime, test } from 'bun:test';
import {
  getFilenameTimestamp,
  getISOTimestamp,
  getPSTComponents,
  getPSTDate,
  getPSTTimestamp,
  getTimezoneDisplay,
  getYearMonth,
} from './time';
import { getPrincipal } from './identity';
import { dateParts, isoOffset } from 'std/core';

// A fixed instant with no DST edge in the tested zones — 02:34:56 UTC on 2026-07-16.
const FIXED = new Date('2026-07-16T02:34:56Z');

// ── The pre-collapse (legacy) algorithm, replicated verbatim from the old lib/time.ts ──
// The facade must reproduce these bytes exactly.
function legacyISO(date: Date, timezone: string): string {
  const localDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  const year = localDate.getFullYear();
  const month = String(localDate.getMonth() + 1).padStart(2, '0');
  const day = String(localDate.getDate()).padStart(2, '0');
  const hours = String(localDate.getHours()).padStart(2, '0');
  const minutes = String(localDate.getMinutes()).padStart(2, '0');
  const seconds = String(localDate.getSeconds()).padStart(2, '0');
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const diffMs = localDate.getTime() - utcDate.getTime();
  const diffHours = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60));
  const diffMins = Math.floor((Math.abs(diffMs) % (1000 * 60 * 60)) / (1000 * 60));
  const sign = diffMs >= 0 ? '+' : '-';
  const offset = `${sign}${String(diffHours).padStart(2, '0')}:${String(diffMins).padStart(2, '0')}`;
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offset}`;
}
function legacyDate(date: Date, timezone: string): string {
  const d = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function legacyComponents(date: Date, timezone: string) {
  const d = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  return {
    year: d.getFullYear(),
    month: String(d.getMonth() + 1).padStart(2, '0'),
    day: String(d.getDate()).padStart(2, '0'),
    hours: String(d.getHours()).padStart(2, '0'),
    minutes: String(d.getMinutes()).padStart(2, '0'),
    seconds: String(d.getSeconds()).padStart(2, '0'),
  };
}
function legacyTzName(date: Date, timezone: string): string {
  return date.toLocaleString('en-US', { timeZone: timezone, timeZoneName: 'short' }).split(' ').pop() || 'UTC';
}

afterAll(() => setSystemTime()); // restore the real clock

// 1 — the collapse targets are byte-equal to the legacy algorithm across zones (incl. sub-hour offsets).
describe('collapse targets vs legacy algorithm (byte-parity)', () => {
  const zones = [
    'Australia/Melbourne',
    'America/Los_Angeles',
    'UTC',
    'Asia/Kolkata', // +05:30
    'Asia/Kathmandu', // +05:45
    'Europe/London',
  ];
  const instants = ['2026-07-16T02:34:56Z', '2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z'];
  for (const iso of instants) {
    for (const z of zones) {
      test(`isoOffset == legacy getISOTimestamp @ ${iso} ${z}`, () => {
        expect(isoOffset(new Date(iso), z)).toBe(legacyISO(new Date(iso), z));
      });
      test(`dateParts.iso == legacy getPSTDate @ ${iso} ${z}`, () => {
        expect(dateParts(new Date(iso), z).iso).toBe(legacyDate(new Date(iso), z));
      });
    }
  }
});

// 2 — each facade export emits the legacy bytes at the configured tz (portable + deterministic).
describe('facade delegates byte-stably at the configured tz', () => {
  test('all 7 exports == legacy output for the frozen clock', () => {
    setSystemTime(FIXED);
    const tz = getPrincipal().timezone;

    expect(getISOTimestamp()).toBe(legacyISO(FIXED, tz));
    expect(getPSTDate()).toBe(legacyDate(FIXED, tz));
    expect(getYearMonth()).toBe(legacyDate(FIXED, tz).substring(0, 7));

    const c = legacyComponents(FIXED, tz);
    expect(getFilenameTimestamp()).toBe(`${c.year}-${c.month}-${c.day}-${c.hours}${c.minutes}${c.seconds}`);
    expect(getPSTComponents()).toEqual(c);
    expect(getPSTTimestamp()).toBe(`${c.year}-${c.month}-${c.day} ${c.hours}:${c.minutes}:${c.seconds} ${legacyTzName(FIXED, tz)}`);
    expect(getTimezoneDisplay()).toBe(legacyTzName(FIXED, tz));
  });
});

// 3 — golden literals: pin the exact Melbourne bytes so a slicing regression is caught by inspection.
describe('golden literals (Australia/Melbourne, +10:00 in July)', () => {
  test('isoOffset primitive emits the known Melbourne ISO', () => {
    expect(isoOffset(FIXED, 'Australia/Melbourne')).toBe('2026-07-16T12:34:56+10:00');
    expect(dateParts(FIXED, 'Australia/Melbourne').iso).toBe('2026-07-16');
  });
});

// 4 — internal cross-consistency of the facade (deterministic under the frozen clock).
describe('facade cross-consistency', () => {
  test('date/time slices line up across exports', () => {
    setSystemTime(FIXED);
    expect(getISOTimestamp().slice(0, 10)).toBe(getPSTDate());
    expect(getYearMonth()).toBe(getPSTDate().slice(0, 7));

    const iso = getISOTimestamp();
    const c = getPSTComponents();
    expect(String(c.year)).toBe(iso.slice(0, 4));
    expect(c.month).toBe(iso.slice(5, 7));
    expect(c.day).toBe(iso.slice(8, 10));
    expect(c.hours).toBe(iso.slice(11, 13));
    expect(c.minutes).toBe(iso.slice(14, 16));
    expect(c.seconds).toBe(iso.slice(17, 19));

    expect(getFilenameTimestamp()).toBe(`${c.year}-${c.month}-${c.day}-${c.hours}${c.minutes}${c.seconds}`);
  });
});
