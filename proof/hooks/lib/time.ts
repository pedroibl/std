/**
 * Shared Time Utilities
 *
 * Consistent timestamp generation across the hook system.
 * Reads timezone from settings.json via principal.timezone
 * Used by: All hooks that need timestamps
 *
 * Story 13.7 (AD-9.4 Rule 3): internals collapsed onto the tested `core` date primitives BEHIND
 * byte-stable export signatures — this is the frozen-facade migration 13.3/13.4 deferred here.
 *   - getISOTimestamp     → core.isoOffset(now, tz)      (YYYY-MM-DDTHH:MM:SS±HH:MM; byte-parity golden test)
 *   - getPSTDate          → core.dateParts(now, tz).iso  (date-only YYYY-MM-DD)
 *   - getPSTComponents / getFilenameTimestamp / getPSTTimestamp derive their H:M:S from isoOffset's
 *     fixed-width YYYY-MM-DDTHH:MM:SS prefix — NOT dateParts (which has NO hour/minute/second field).
 * The tz short-NAME (getPSTTimestamp / getTimezoneDisplay) has no std primitive → stays caller-local.
 * The 7 exports are the contract: their bytes must not shift — 12 importers across 4 clusters (incl. 3
 * live 13.3 hooks) depend on getISOTimestamp emitting identical bytes.
 */

import { getPrincipal } from './identity';
import { isoOffset, dateParts } from 'std/core';

/**
 * Get configured timezone from settings.json (defaults to UTC)
 */
function getTimezone(): string {
  return getPrincipal().timezone || 'UTC';
}

/**
 * Get full timestamp string: "YYYY-MM-DD HH:MM:SS TZ"
 */
export function getPSTTimestamp(): string {
  const timezone = getTimezone();
  const date = new Date();
  // Date + time from isoOffset's YYYY-MM-DDTHH:MM:SS prefix (dateParts has no H:M:S).
  const iso = isoOffset(date, timezone);
  const ymd = `${iso.slice(0, 4)}-${iso.slice(5, 7)}-${iso.slice(8, 10)}`;
  const hms = `${iso.slice(11, 13)}:${iso.slice(14, 16)}:${iso.slice(17, 19)}`;

  // Get short timezone name (caller-local: no std primitive for the short tz NAME)
  const tzName = date.toLocaleString('en-US', { timeZone: timezone, timeZoneName: 'short' }).split(' ').pop() || 'UTC';

  return `${ymd} ${hms} ${tzName}`;
}

/**
 * Get date only: "YYYY-MM-DD"
 */
export function getPSTDate(): string {
  return dateParts(new Date(), getTimezone()).iso;
}

/**
 * Get year-month for directory structure: "YYYY-MM"
 */
export function getYearMonth(): string {
  return getPSTDate().substring(0, 7);
}

/**
 * Get ISO8601 timestamp with timezone offset
 */
export function getISOTimestamp(): string {
  return isoOffset(new Date(), getTimezone());
}

/**
 * Get timestamp formatted for filenames: "YYYY-MM-DD-HHMMSS"
 */
export function getFilenameTimestamp(): string {
  // H:M:S from isoOffset's fixed-width prefix (dateParts is date-only).
  const iso = isoOffset(new Date(), getTimezone());
  return `${iso.slice(0, 4)}-${iso.slice(5, 7)}-${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

/**
 * Get timestamp components for custom formatting
 */
export function getPSTComponents(): {
  year: number;
  month: string;
  day: string;
  hours: string;
  minutes: string;
  seconds: string;
} {
  // Every component from isoOffset's YYYY-MM-DDTHH:MM:SS prefix (dateParts has no H:M:S).
  const iso = isoOffset(new Date(), getTimezone());
  return {
    year: Number(iso.slice(0, 4)),
    month: iso.slice(5, 7),
    day: iso.slice(8, 10),
    hours: iso.slice(11, 13),
    minutes: iso.slice(14, 16),
    seconds: iso.slice(17, 19),
  };
}

/**
 * Get timezone string for display
 */
export function getTimezoneDisplay(): string {
  const timezone = getTimezone();
  const date = new Date();
  return date.toLocaleString('en-US', { timeZone: timezone, timeZoneName: 'short' }).split(' ').pop() || timezone;
}
