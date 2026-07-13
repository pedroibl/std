#!/usr/bin/env bun
/**
 * ToolActivityTracker.hook.ts - PostToolUse Event Logger
 *
 * Ground-truth audit capture: what the model did, not what it said it did.
 * Captures tool calls + ground-truth artifacts (file paths, bash exit codes,
 * git state at the time of the call) so the dashboard shows actual effects.
 *
 * TRIGGER: PostToolUse (all tools)
 *
 * OUTPUTS:
 * - MEMORY/OBSERVABILITY/tool-activity.jsonl (structured event log)
 *
 * PERFORMANCE: <25ms typical (adds one git rev-parse on write-class tools)
 *
 * ── Story 13.3 rewrite (consumer sweep) — the highest-risk 13.3 hook. Four re-hand-rolled primitives now
 *    import tested std slices; ALL behavior + frozen contracts preserved:
 *    - P1  readStdin() 2000ms event-listener race (:39-47)      → std/stdio  readStdinJson<ToolUseInput>()
 *    - P3  getISOTimestamp() from ./lib/time (:127)             → std/core   isoOffset(now,'Australia/Melbourne')
 *    - P2  existsSync/mkdirSync/appendFileSync (:137-138)       → std/report appendJsonlEvent(OBS_DIR, file, event)
 *    - std/git  gitSnapshot() 2× execFileSync (:53-65)         → std/git    git(repo, args) ×2 (fail-soft)
 *
 * POSTURE (AD-9.4 Rule 2): fail-OPEN, unchanged. The original already fails open (empty stdin → exit 0,
 *    outer try/catch → exit 0). readStdinJson keeps that: null (empty / malformed / timeout) → the VISIBLE
 *    `process.exit(0)` branch. No posture flip — this file was already fail-open (unlike its FileChanged sibling).
 *
 * FROZEN (AD-9.4 Rule 3 / AC7 — MUST stay byte-identical):
 *    - imports `pushEventsToTargets`/`pushStateToTargets` from './lib/observability-transport' and
 *      `bumpLastToolActivity` from './lib/isa-utils' (identical strings — resolve to REAL modules on deploy).
 *    - the KV-push side-effect chain + its 30s-debounce staleness fix (only push state when we actually wrote).
 *    - the exact event keys {timestamp,event,source,type,session_id,tool_name,tool_input_preview,ground_truth?}.
 *    - the ground_truth sub-shape + truncation caps (300 preview / 500 diff+content / 800 stdout+stderr).
 *
 * Behavioral deltas recorded (not silent):
 *    - P3 timestamp: getISOTimestamp() looked the tz up via getTimezone() config; isoOffset hardwires the
 *      caller-local (D4) tz `Australia/Melbourne`. Same output SHAPE (tz-offset ISO, no ms). On Pedro's box
 *      the config already resolves to Melbourne → no value delta; the tz is now caller-local, not config-read.
 *    - std/git drops the explicit {timeout:500} (it has no per-call timeout). Acceptable: both are fast local
 *      `rev-parse`/`status` on the cwd. std/git is fail-soft (→ '' on error), so a non-repo cwd yields head=''
 *      → snapshot returns undefined, preserving the original try/catch → undefined outcome. Minor sub-delta:
 *      the original wrapped BOTH commands in one try (if `status` threw after `rev-parse` succeeded → undefined);
 *      here a fail-soft `status` yields '' → {head, dirty:false}. status failing after a good rev-parse is
 *      effectively impossible on a real repo, so the observable snapshot is unchanged.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { git } from 'std/git';
import { isoOffset } from 'std/core';
import { appendJsonlEvent } from 'std/report';
import { readStdinJson } from 'std/stdio';
import { resolveFrameworkDir } from 'std/fsx';
import { pushEventsToTargets, pushStateToTargets } from './lib/observability-transport';
import { bumpLastToolActivity } from './lib/isa-utils';

interface ToolUseInput {
  session_id: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

// Caller-local (D4): Pedro's actual tz — never the PAI template's America/Los_Angeles.
const TZ = 'Australia/Melbourne';

// OBS_DIR resolved via resolveFrameworkDir (Epic-16-aware; matches the 13.3 canary + AC11 cluster convention).
const OBS_DIR = join(resolveFrameworkDir(process.env.HOME ?? homedir()), 'MEMORY', 'OBSERVABILITY');
const ACTIVITY_FILE = 'tool-activity.jsonl';

// Tools that mutate filesystem state — capture extra ground truth. Caller-local (D4), preserved verbatim.
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const BASH_TOOLS = new Set(['Bash']);

export type GitSnapshot = { head?: string; dirty?: boolean } | undefined;
export type SnapshotFn = (cwd: string) => GitSnapshot;

/** Truncation cap — caller-local, preserved verbatim (300/500/800 callers below). Pure. */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...[truncated]' : s;
}

/** git HEAD + dirty snapshot via std/git (fail-soft, -C wrapper). Preserves the two-command
 *  rev-parse+status contract; stderr is swallowed by std/git. `git` never throws → head='' means
 *  "not a repo / error" → undefined, matching the original try/catch outcome. */
export function gitSnapshot(cwd: string): GitSnapshot {
  const head = git(cwd, ['rev-parse', '--short', 'HEAD']).trim();
  if (!head) return undefined;
  const status = git(cwd, ['status', '--porcelain']);
  return { head, dirty: status.trim().length > 0 };
}

/** Extract bounded ground-truth artifacts for write/bash tools. Pure given an injected `snapshot`
 *  + `cwd` (defaults to the real gitSnapshot over process.cwd()). Truncation caps preserved verbatim. */
export function captureGroundTruth(
  toolName: string,
  input: Record<string, unknown>,
  response: unknown,
  snapshot: SnapshotFn = gitSnapshot,
  cwd: string = process.cwd(),
): Record<string, unknown> | undefined {
  const gt: Record<string, unknown> = {};

  if (WRITE_TOOLS.has(toolName) && typeof input.file_path === 'string') {
    gt.file_path = input.file_path;
    // Edit/MultiEdit carry the before/after diff in args; capture bounded.
    if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      gt.diff = {
        removed: truncate(input.old_string, 500),
        added: truncate(input.new_string, 500),
      };
    }
    if (typeof input.content === 'string') {
      gt.content_preview = truncate(input.content, 500);
      gt.content_bytes = input.content.length;
    }
    const gs = snapshot(cwd);
    if (gs) gt.git = gs;
  }

  if (BASH_TOOLS.has(toolName) && typeof input.command === 'string') {
    gt.command = truncate(input.command, 500);
    // Claude Code puts stdout/stderr/exit in tool_response — shape varies.
    if (response && typeof response === 'object') {
      const r = response as Record<string, unknown>;
      if ('stdout' in r && typeof r.stdout === 'string') {
        gt.stdout_preview = truncate(r.stdout, 800);
        gt.stdout_bytes = r.stdout.length;
      }
      if ('stderr' in r && typeof r.stderr === 'string') {
        gt.stderr_preview = truncate(r.stderr, 800);
      }
      if ('exit_code' in r || 'exitCode' in r) {
        gt.exit_code = r.exit_code ?? r.exitCode;
      }
    }
  }

  return Object.keys(gt).length > 0 ? gt : undefined;
}

/** Shape the tool_use event. Pure — `now`/`tz`/`snapshot`/`cwd` injected so the P3 tz-offset stamp, the
 *  ground_truth extraction, and the 300/500/800 truncations are all hermetically testable off the fs/git path.
 *  Event keys + ground_truth sub-shape are FROZEN (AC7). */
export function buildActivityEvent(
  data: ToolUseInput,
  now: Date,
  tz: string,
  snapshot: SnapshotFn = gitSnapshot,
  cwd: string = process.cwd(),
): Record<string, unknown> {
  const toolName = data.tool_name || 'unknown';

  let inputPreview = '';
  if (data.tool_input) {
    const raw = JSON.stringify(data.tool_input);
    inputPreview = raw.length > 300 ? raw.slice(0, 300) + '...' : raw;
  }

  const groundTruth = data.tool_input
    ? captureGroundTruth(toolName, data.tool_input, data.tool_response, snapshot, cwd)
    : undefined;

  return {
    timestamp: isoOffset(now, tz),
    event: 'tool_use',
    source: 'tool-activity',
    type: 'tool_use',
    session_id: data.session_id,
    tool_name: toolName,
    tool_input_preview: inputPreview,
    ...(groundTruth ? { ground_truth: groundTruth } : {}),
  };
}

async function main(): Promise<void> {
  try {
    // P1: read + parse stdin, posture-neutral. FAIL-OPEN (unchanged posture): null → exit 0.
    const data = await readStdinJson<ToolUseInput>();
    if (data === null) { process.exit(0); }

    const event = buildActivityEvent(data, new Date(), TZ);

    // P2: ensureDir + size-rotation + best-effort/never-throw.
    appendJsonlEvent(OBS_DIR, ACTIVITY_FILE, event);

    // Bump lastToolActivity on work.json; push state to CF KV when we actually
    // wrote (i.e. past the 30s debounce). Without this push, the dashboard
    // shows tool-heavy sessions as stale because KV only gets updated on
    // UserPromptSubmit — the 5-10 min stale window elapses between prompts
    // and the session disappears mid-work.  [FROZEN — AC7]
    const wrote = data.session_id ? bumpLastToolActivity(data.session_id) : false;

    const pushes: Promise<void>[] = [pushEventsToTargets()];
    if (wrote) pushes.push(pushStateToTargets());
    await Promise.all(pushes);
  } catch (e) {
    console.error('[ToolActivityTracker]', e instanceof Error ? e.message : String(e));
  }
  process.exit(0);
}

if (import.meta.main) { main(); }
