#!/usr/bin/env bun
/**
 * FileChanged hook — fires when a file is modified.
 * Watches for changes to key PAI config files and triggers validation.
 *
 * Story 13.3 rewrite (consumer sweep) — the three re-hand-rolled primitives now import tested std slices:
 *   - synchronous JSON.parse(readFileSync('/dev/stdin'))  → std/stdio  readStdinJson  (P1)
 *   - guard-less appendFileSync (no ensureDir)            → std/report appendJsonlEvent (P2, adds ensureDir)
 *   - bare new Date().toISOString() (UTC)                 → std/core   isoOffset       (P3)
 *
 * POSTURE (AD-9.4 Rule 2) — the one POSTURE CORRECTION in the cluster: the original was fail-CLOSED (a
 * synchronous parse with no timeout / no try-catch → it CRASHES on empty or malformed stdin). This rewrite
 * makes it fail-OPEN like its observability siblings: readStdinJson returns null (empty / malformed /
 * timeout) → `process.exit(0)`, the visible Rule-2 checkpoint. Recorded in deferred-work.md §13-3.
 *
 * Behavioral deltas recorded (not silent):
 *   - posture flip fail-closed → fail-open (above).
 *   - `ts` format: bare UTC (`…Z`) → isoOffset tz-offset (`…+10:00`). Confirmed no execution.jsonl consumer
 *     parses `ts` as strict-UTC.
 *
 * Target is NON-OBSERVABILITY: MEMORY/SKILLS/execution.jsonl (not MEMORY/OBSERVABILITY) — preserved.
 */

import { paiPath } from "./lib/paths";
import { isoOffset } from "std/core";
import { appendJsonlEvent } from "std/report";
import { readStdinJson } from "std/stdio";

const TZ = "Australia/Melbourne"; // Pedro's actual tz (never the PAI template's America/Los_Angeles).

// Key files that should trigger alerts when modified — caller-local (D4), preserved verbatim.
const watchedPatterns = [
  /settings\.json$/,
  /settings\.local\.json$/,
  /CLAUDE\.md$/,
  /CONTEXT_ROUTING\.md$/,
  /Algorithm\/v[\d.]+\.md$/,
];

interface FileChangedInput {
  toolInput?: { file_path?: string };
  filePath?: string;
}

interface FileChangedRecord {
  ts: string;
  event: "FileChanged";
  file: string;
}

/** Only watched files are logged. Pure — the regex gate, off the stdin/fs path. */
export function isWatched(filePath: string): boolean {
  return watchedPatterns.some((p) => p.test(filePath));
}

/** Shape the log record. Pure (`now`/`tz` injected) — the P3 tz-offset timestamp lives here, hermetically
 *  testable off the fs path. */
export function buildRecord(filePath: string, now: Date, tz: string): FileChangedRecord {
  return { ts: isoOffset(now, tz), event: "FileChanged", file: filePath };
}

async function main(): Promise<void> {
  // P1: read + parse stdin, posture-neutral. FAIL-OPEN (the posture correction): null → exit 0.
  const input = await readStdinJson<FileChangedInput>();
  if (input === null) { process.exit(0); }

  const filePath: string = input?.toolInput?.file_path ?? input?.filePath ?? "";

  if (isWatched(filePath)) {
    const record = buildRecord(filePath, new Date(), TZ);
    // P2: ensureDir + size-rotation + best-effort. Non-OBSERVABILITY target preserved.
    appendJsonlEvent(paiPath("MEMORY", "SKILLS"), "execution.jsonl", record);
  }

  // Always allow — this is observability, not a gate.
  process.exit(0);
}

if (import.meta.main) { main(); }
