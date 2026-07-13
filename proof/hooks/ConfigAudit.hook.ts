#!/usr/bin/env bun
/**
 * ConfigAudit.hook.ts - ConfigChange Event Logger
 *
 * PURPOSE:
 * Security audit trail for configuration changes. Logs what changed, when,
 * and in which session. Uses file-diff against a cached snapshot to detect
 * which top-level keys actually changed (the event stdin doesn't provide this).
 *
 * TRIGGER: ConfigChange (command-only event) — DORMANT / not-wired. Zero live-regression risk, so this
 * story exercises the FULL primitive set (P1 + P2 + P3 + std/fsx round-trip) as a validation case.
 *
 * Story 13.3 rewrite (consumer sweep) — the re-hand-rolled primitives now import tested std slices
 * (AD-9.4 Rule 4):
 *   - readStdin (2000ms race + empty-guard + JSON.parse)        → std/stdio  readStdinJson       (P1)
 *   - getISOTimestamp (lib/time.ts, tz-offset ISO)              → std/core   isoOffset            (P3)
 *   - mkdirSync + appendFileSync(join(OBS_DIR, file), …)        → std/report appendJsonlEvent     (P2)
 *   - readFileSync(settings) + /tmp snapshot round-trip         → std/fsx    readIfExists/loadJson/saveJson
 *   - paiPath('MEMORY','OBSERVABILITY')                         → std/fsx    resolveFrameworkDir  (Epic 16)
 *
 * POSTURE (AD-9.4 Rule 2) — PRESERVED fail-OPEN. The original already caught everything (empty → `!input.trim()`
 * → exit 0; malformed JSON → JSON.parse throws → main's try → exit 0). readStdinJson maps empty/malformed/
 * timeout → null; the visible `null → process.exit(0)` branch is the mandatory Rule-2 checkpoint. No posture
 * flip (unlike the FileChanged sibling, which was a genuine correction).
 *
 * Behavioral deltas recorded (not silent):
 *   - stdin timeout 2000ms → readStdinJson's 1000ms default (AD-9.4 Rule 2.1; generous enough).
 *   - malformed stdin: original logged "[ConfigAudit] Error: …" then exit 0; now a posture-neutral null →
 *     silent exit 0 (the reader never throws). Exit code identical.
 *   - `timestamp`: getISOTimestamp (tz from principal/settings) → isoOffset(now, TZ) with TZ caller-local
 *     Australia/Melbourne (Pedro's actual — never the LA template default). Same tz-offset ISO format.
 *   - snapshot read: original caught ANY snapshot-read error → empty (→ initial); loadJson softens only
 *     missing-file + parse-error and re-throws a REAL fs fault (permission). /tmp scratch → practically
 *     unreachable, and the outer main() try still catches it → exit 0.
 *
 * OUTPUTS:
 * - MEMORY/OBSERVABILITY/config-changes.jsonl (structured audit log)
 * - stderr logging for hook diagnostics
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSettingsPath } from './lib/paths';
import { isoOffset } from 'std/core';
import { appendJsonlEvent } from 'std/report';
import { loadJson, readIfExists, resolveFrameworkDir, saveJson } from 'std/fsx';
import { readStdinJson } from 'std/stdio';

interface ConfigChangeInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
  config_path?: string;
  config_key?: string;
  old_value?: unknown;
  new_value?: unknown;
}

interface ConfigChangeEvent {
  timestamp: string;
  event: 'config_change';
  session_id: string;
  config_path: string;
  config_key: string;
  change_summary: string;
}

// Caller-local identity (D4): the observability dir, the audit filename, the snapshot path, the tz, and the
// SENSITIVE_KEYS taxonomy all stay HERE in the consumer — std carries none of them.
const OBS_DIR = join(resolveFrameworkDir(process.env.HOME ?? homedir()), 'MEMORY', 'OBSERVABILITY');
const AUDIT_FILE = 'config-changes.jsonl';
const SNAPSHOT_PATH = '/tmp/pai-settings-snapshot.json';
const TZ = 'Australia/Melbourne'; // Pedro's actual tz (never the PAI template's America/Los_Angeles).

// Sensitive keys that warrant extra logging — caller-local taxonomy, preserved verbatim.
const SENSITIVE_KEYS = new Set([
  'permissions', 'hooks', 'env', 'mcpServers',
  'permissions.allow', 'permissions.deny', 'permissions.ask',
]);

/**
 * Diff two already-parsed settings objects. PURE — the caller injects `snapshot` (old) and `current` (new),
 * so this is hermetically testable off the fs path. Top-level + one-level-deep diff with the load-bearing
 * `initial`/`unchanged` sentinels preserved verbatim. (`could not read` is a read-failure sentinel and stays
 * in the impure shell below.)
 */
export function diffSettings(
  snapshot: Record<string, unknown>,
  current: Record<string, unknown>,
): { changedKeys: string[]; summary: string } {
  // If no prior snapshot, we can't diff
  if (Object.keys(snapshot).length === 0) {
    return { changedKeys: ['initial'], summary: 'initial snapshot (no prior to diff)' };
  }

  // Compare top-level keys
  const allKeys = new Set([...Object.keys(current), ...Object.keys(snapshot)]);
  const changed: string[] = [];
  const summaryParts: string[] = [];

  for (const key of allKeys) {
    const curVal = JSON.stringify(current[key]);
    const snapVal = JSON.stringify(snapshot[key]);

    if (curVal !== snapVal) {
      changed.push(key);

      if (!(key in snapshot)) {
        summaryParts.push(`${key}: added`);
      } else if (!(key in current)) {
        summaryParts.push(`${key}: removed`);
      } else {
        // For arrays/objects, try to show what changed at second level
        if (typeof current[key] === 'object' && current[key] && typeof snapshot[key] === 'object' && snapshot[key]) {
          const curObj = current[key] as Record<string, unknown>;
          const snapObj = snapshot[key] as Record<string, unknown>;
          const subKeys = new Set([...Object.keys(curObj), ...Object.keys(snapObj)]);
          const subChanged: string[] = [];
          for (const sk of subKeys) {
            if (JSON.stringify(curObj[sk]) !== JSON.stringify(snapObj[sk])) {
              subChanged.push(sk);
            }
          }
          if (subChanged.length <= 3) {
            summaryParts.push(`${key}.{${subChanged.join(',')}}: modified`);
          } else {
            summaryParts.push(`${key}: ${subChanged.length} sub-keys modified`);
          }
        } else {
          const newStr = JSON.stringify(current[key]).slice(0, 80);
          summaryParts.push(`${key}: → ${newStr}`);
        }
      }
    }
  }

  if (changed.length === 0) {
    return { changedKeys: ['unchanged'], summary: 'no diff detected (possible race)' };
  }

  return { changedKeys: changed, summary: summaryParts.join('; ') };
}

/**
 * Read current settings + cached snapshot, persist the new snapshot, and diff. IMPURE — the std/fsx round-trip
 * (readIfExists over settings.json, loadJson over the /tmp snapshot, saveJson to persist) lives here; the
 * `could not read settings.json` sentinel fires when the current read/parse fails (preserved verbatim).
 */
function readSettingsState(): { changedKeys: string[]; summary: string } {
  const settingsPath = getSettingsPath();

  let current: Record<string, unknown>;
  try {
    const raw = readIfExists(settingsPath);
    if (raw === null) throw new Error('settings.json missing');
    current = JSON.parse(raw);
  } catch {
    return { changedKeys: ['settings.json'], summary: 'could not read settings.json' };
  }

  // No snapshot or corrupt → empty (treat everything as new). loadJson returns the fallback on missing /
  // unparseable, matching the original best-effort snapshot read.
  const snapshot = loadJson<Record<string, unknown>>(SNAPSHOT_PATH, {});

  // Save new snapshot for next comparison (non-fatal). saveJson is fail-loud, so keep the best-effort guard.
  try {
    saveJson(SNAPSHOT_PATH, current);
  } catch {
    // Non-fatal
  }

  return diffSettings(snapshot, current);
}

/**
 * Shape the audit event. PURE (`now`/`tz` injected) — the P3 isoOffset timestamp and the preserved event
 * shape live here, off the stdin/fs path. Shape is byte-frozen:
 * `{timestamp,event:'config_change',session_id,config_path,config_key,change_summary}`.
 */
export function buildEvent(
  data: ConfigChangeInput,
  changedKeys: string[],
  summary: string,
  now: Date,
  tz: string,
): ConfigChangeEvent {
  return {
    timestamp: isoOffset(now, tz),
    event: 'config_change',
    session_id: data.session_id,
    config_path: data.config_path || 'settings.json',
    config_key: changedKeys.join(','),
    change_summary: summary,
  };
}

async function main(): Promise<void> {
  try {
    // P1: read + parse stdin, posture-neutral. Fail-OPEN (preserved): null → exit 0 before any write.
    const input = await readStdinJson<ConfigChangeInput>();
    if (input === null) { process.exit(0); }

    // Use file-diff to determine what actually changed
    const { changedKeys, summary } = readSettingsState();
    const configKey = changedKeys.join(',');
    const isSensitive = changedKeys.some((k) => SENSITIVE_KEYS.has(k));

    const event = buildEvent(input, changedKeys, summary, new Date(), TZ);

    // P2: ensureDir + size-rotation + best-effort append. OBSERVABILITY target preserved.
    appendJsonlEvent(OBS_DIR, AUDIT_FILE, event);

    const sensitivity = isSensitive ? ' [SENSITIVE]' : '';
    console.error(`[ConfigAudit] Logged: ${configKey}${sensitivity} — ${summary}`);
  } catch (err) {
    console.error(`[ConfigAudit] Error: ${err}`);
  }
  // Single exit 0 — flushes after the first `await` (P1) too.
  process.exit(0);
}

if (import.meta.main) { main(); }
