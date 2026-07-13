#!/usr/bin/env bun
/**
 * IntegrityCheck.hook.ts - PAI Integrity Check (SessionEnd)
 *
 * Runs system integrity check — detects PAI system file changes, spawns background maintenance.
 * Doc cross-ref integrity is handled by DocIntegrity.hook.ts (Stop event) to avoid double execution.
 *
 * TRIGGER: SessionEnd (settings.json:194, wired)
 * PERFORMANCE: ~50ms (single transcript parse, one handler call). Non-blocking.
 *
 * Story 13.3 rewrite (consumer sweep) — ONE re-hand-rolled primitive now imports a tested std slice:
 *   - the Bun.stdin.stream() 500ms-race read loop (orig :21-38)  → std/stdio  readStdinJson<HookInput>()  (P1)
 * This hook only READS stdin then delegates — no P2 (write) / P3 (timestamp) surface.
 *
 * POSTURE (AD-9.4 Rule 2) — fail-OPEN, PRESERVED. The original already exits 0 on missing input; the
 * stricter guard `if (!hookInput?.transcript_path) process.exit(0)` is kept as the VISIBLE Rule-2 branch.
 * It subsumes a plain null-check: readStdinJson returns null on empty/malformed/timeout, and
 * `null?.transcript_path` is undefined → the guard exits 0. No gate — SessionEnd never blocks.
 *
 * Behavioral delta recorded (not silent):
 *   - stdin read timeout: 500ms → 1000ms (readStdinJson default). AD-9.4 Rule 2 point 1 — the generous
 *     default is intentional (SessionEnd is non-blocking; a longer window trades nothing for reliability).
 *     Filed in deferred-work.md §13-3.
 *
 * Frozen contracts PRESERVED byte-for-byte:
 *   - import { parseTranscript } from '../PAI/TOOLS/TranscriptParser'  (identical string)
 *   - import { handleSystemIntegrity } from './handlers/SystemIntegrity' (identical string, sibling rewrite)
 *   - the parseTranscript(transcript_path) → handleSystemIntegrity(parsed, hookInput) call contract.
 */

import { parseTranscript } from '../PAI/TOOLS/TranscriptParser';
import { handleSystemIntegrity } from './handlers/SystemIntegrity';
import { readStdinJson } from 'std/stdio';

// Caller-local hook-event shape (D4) — the SessionEnd stdin envelope, preserved verbatim from source.
interface HookInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
}

async function main(): Promise<void> {
  // P1: read + parse stdin, posture-neutral, never throws (1000ms default timeout — up from 500ms).
  const hookInput = await readStdinJson<HookInput>();

  // Rule-2 fail-OPEN checkpoint (PRESERVED, stricter-than-null): no usable transcript → allow, exit 0.
  if (!hookInput?.transcript_path) { process.exit(0); }

  const parsed = parseTranscript(hookInput.transcript_path);

  // Run system integrity check (doc cross-ref is handled by DocIntegrity.hook.ts).
  await handleSystemIntegrity(parsed, hookInput);

  process.exit(0);
}

if (import.meta.main) { main().catch(() => process.exit(0)); }
