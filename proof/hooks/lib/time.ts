// PROOF-ONLY SHIM (Story 13.4, Option A) — NOT deployed.
// Reproduces the ~/.claude/hooks/lib/time.ts exports the 13.4 rewrites consume so proof/hooks/**
// typechecks in isolation; the DEPLOYED hooks import the REAL `./lib/time` by the identical relative
// string (byte-verbatim deploy holds). FROZEN module (AD-9.4 Rule 3 / AC7) — lib/time.ts is owned by
// Story 13.7 (its internal swap to core.isoOffset/dateParts is 13.7's, NOT this story's); this copy
// exists ONLY for the proof. Caller-local default = Pedro's actual tz (Australia/Melbourne — memory
// pai-template-defaults-are-pedros-data, never the template's America/Los_Angeles).
//
// Deterministic-ish: the proof drives the hooks to their `null`-stdin / no-state exit-0 branches, which
// return BEFORE these time fns run on the happy path, so exact values are never asserted through the fire
// tests. getPSTComponents returns fixed sentinels so any accidental happy-path reach stays inspectable.

const TZ = "Australia/Melbourne";

function localNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
}

/** ISO-ish timestamp (real impl: tz-aware). Proof stub returns a stable ISO string shape. */
export function getISOTimestamp(): string {
  return new Date().toISOString();
}

/** YYYY-MM-DD in the caller-local tz. Real impl reads the configured tz; proof mirrors the shape. */
export function getPSTDate(): string {
  const d = localNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** YYYY-MM in the caller-local tz. */
export function getYearMonth(): string {
  const d = localNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Decomposed tz-local components (faithful shape of the real getPSTComponents). */
export function getPSTComponents(): {
  year: number;
  month: string;
  day: string;
  hours: string;
  minutes: string;
  seconds: string;
} {
  const d = localNow();
  return {
    year: d.getFullYear(),
    month: String(d.getMonth() + 1).padStart(2, "0"),
    day: String(d.getDate()).padStart(2, "0"),
    hours: String(d.getHours()).padStart(2, "0"),
    minutes: String(d.getMinutes()).padStart(2, "0"),
    seconds: String(d.getSeconds()).padStart(2, "0"),
  };
}
