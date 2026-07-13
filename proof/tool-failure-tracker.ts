#!/usr/bin/env bun
/**
 * ToolFailureTracker.hook.ts - PostToolUseFailure Event Logger
 *
 * Story 13.2 canary — the runtime PROOF that the Epic-13 hooks substrate + the vendored-std door work
 * when a real hook runs. Behavior preserved; the three re-hand-rolled primitives now import the tested
 * std slices (AD-9.4 Rule 4):
 *   - readStdin (2000ms race + JSON.parse + empty-guard)        → std/stdio  readStdinJson  (P1)
 *   - mkdirSync + appendFileSync(join(OBS_DIR, file), …)        → std/report appendJsonlEvent (P2)
 *   - getISOTimestamp (lib/time.ts, tz-offset ISO)             → std/core   isoOffset       (P3)
 *   - paiPath('MEMORY','OBSERVABILITY')                        → std/fsx    resolveFrameworkDir (Epic 16)
 *
 * POSTURE (AD-9.4 Rule 2): readStdinJson is posture-neutral (returns T | null, decides nothing). This
 * hook is FAIL-OPEN — the visible branch is `null → process.exit(0)` (proceed, log nothing). A security
 * hook (13.6) would map the same null to fail-CLOSED (deny / exit 2). The null branch below is the
 * mandatory Rule-2 review checkpoint, demonstrated.
 *
 * WRITE SIDE unused (AC8): this hook appends to a JSONL file and exits 0 — it never writes a stdout JSON
 * decision envelope, so it does not exercise `stdio`'s (deferred) write side.
 *
 * Generate-vs-corrected deltas from the hand-roll (recorded, all intentional):
 *   - stdin timeout 2000ms → readStdinJson's 1000ms default (AD-9.4 Rule 2.1; generous enough).
 *   - malformed stdin: the original caught JSON.parse and logged "[ToolFailureTracker] Error: …"; now it
 *     is one of readStdinJson's null cases → silent exit 0 (posture-neutral — the reader does not throw).
 *   - tz was getPrincipal().timezone (settings.json); now Pedro's actual is caller-local here
 *     (memory pai-template-defaults-are-pedros-data — Australia/Melbourne, never the LA template default).
 *
 * TRIGGER: PostToolUseFailure
 *
 * OUTPUTS:
 * - MEMORY/OBSERVABILITY/tool-failures.jsonl (structured event log)
 * - stderr logging for hook diagnostics
 *
 * PERFORMANCE: <20ms (file append only)
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { isoOffset } from 'std/core';
import { appendJsonlEvent } from 'std/report';
import { resolveFrameworkDir } from 'std/fsx';
import { readStdinJson } from 'std/stdio';

// Caller-local identity (D4 / AD-9.4 Rule 1 SPLIT): the event shape, the observability dir, and the tz
// stay HERE, in the consumer — std carries none of them.
interface ToolFailureInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  error?: string;
}

interface ToolFailureEvent {
  timestamp: string;
  event: 'tool_failure';
  session_id: string;
  tool_name: string;
  error: string;
  tool_input_preview: string;
}

const OBS_DIR = join(resolveFrameworkDir(homedir()), 'MEMORY', 'OBSERVABILITY');
const FAILURES_FILE = 'tool-failures.jsonl';
const TZ = 'Australia/Melbourne'; // Pedro's actual tz (never the PAI template's America/Los_Angeles).

/**
 * Shape a failure event from the hook input. Pure (the `now`/`tz` are injected) so it is hermetically
 * testable — the P3 `isoOffset` timestamp and the truncation caps live here, off the stdin/fs path.
 */
export function buildFailureEvent(data: ToolFailureInput, now: Date, tz: string): ToolFailureEvent {
  const toolName = data.tool_name || 'unknown';
  const error = data.error || 'unknown error';

  // Truncate tool input for storage
  let inputPreview = '';
  if (data.tool_input) {
    const raw = JSON.stringify(data.tool_input);
    inputPreview = raw.length > 500 ? raw.slice(0, 500) + '...' : raw;
  }

  return {
    timestamp: isoOffset(now, tz), // P3
    event: 'tool_failure',
    session_id: data.session_id,
    tool_name: toolName,
    error: error.slice(0, 1000),
    tool_input_preview: inputPreview,
  };
}

async function main(): Promise<void> {
  // P1: read + parse stdin, posture-neutral. FAIL-OPEN posture (AD-9.4 Rule 2): null (empty / malformed /
  // timeout) → exit 0, log nothing, do not block. This branch is the mandatory Rule-2 checkpoint.
  const data = await readStdinJson<ToolFailureInput>();
  if (data === null) { process.exit(0); }

  try {
    const event = buildFailureEvent(data, new Date(), TZ);
    appendJsonlEvent(OBS_DIR, FAILURES_FILE, event); // P2: ensureDir + size-rotation + best-effort
    console.error(`[ToolFailureTracker] Logged failure: ${event.tool_name} — ${event.error.slice(0, 80)}`);
  } catch (err) {
    console.error(`[ToolFailureTracker] Error: ${err}`);
  }
  process.exit(0);
}

if (import.meta.main) { main(); }
