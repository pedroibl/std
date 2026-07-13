/**
 * SystemIntegrity.ts - Automatic system integrity maintenance handler
 *
 * Detects PAI system changes from the transcript and spawns background
 * IntegrityMaintenance.ts to update references and document changes.
 *
 * TRIGGER: SessionEnd hook (via IntegrityCheck.hook.ts:47) — a HANDLER (invoked by its parent,
 *          no own stdin), so no main()/fire-test; the exported pure helper is unit-tested instead.
 *
 * Story 13.3 rewrite (consumer sweep) — ONE primitive swap, everything else byte-preserved:
 *   - updateIntegrityState (:51-68): existsSync(STATE_DIR)+mkdirSync guard + non-atomic
 *     writeFileSync(STATE_FILE, …)                    → std/fsx  ensureDir + atomicWrite   (P: durability)
 *
 * WHY atomicWrite, NOT saveJson: the AC pins integrity-state.json BYTE-IDENTICAL (it is read back by
 * change-detection). saveJson appends a trailing "\n" (JSON.stringify(…,2)+"\n") — a byte delta. So the
 * write stays `atomicWrite(STATE_FILE, JSON.stringify(state, null, 2))`: same bytes as the original
 * writeFileSync, plus the tmp+rename durability upgrade (a reader never sees a torn state file) and the
 * folded-in ensureDir (atomicWrite ensureDirs the parent). The explicit ensureDir(STATE_DIR) is kept to
 * mirror the original's dir guarantee 1:1 and match the AC's "ensureDir+atomicWrite" mapping.
 *
 * DEFERRED (do NOT force onto std/proc): the detached fire-and-forget
 *   spawn('bun',[SCRIPT],{detached:true,stdio:['pipe','ignore','inherit']}) + child.stdin.write + unref()
 * is a proc.spawnDetached VARIANT (no capture, outlives the parent) — 1 consumer → kept caller-local
 * (AC10). spawnCapture is the wrong shape (it captures + never detaches). Raw node child_process.spawn,
 * the exact child-stdin JSON contract, and the detach semantics are PRESERVED verbatim.
 *
 * PRESERVED (byte-for-byte): the throttle ORDER (cooldown → parse → filter → significance → dedup →
 * state-write → spawn), the integrity-state.json record shape { last_run, last_changes_hash,
 * cooldown_until }, the child-stdin JSON contract, and every ./lib/change-detection import (frozen
 * shared lib — its own collapse is AC6, not this handler's to touch).
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { paiPath } from '../lib/paths';
import { atomicWrite, ensureDir } from 'std/fsx';

import {
  parseToolUseBlocks,
  isSignificantChange,
  isInCooldown,
  isDuplicateRun,
  hashChanges,
  getCooldownEndTime,
  determineSignificance,
  inferChangeType,
  generateDescriptiveTitle,
  type FileChange,
  type IntegrityState,
} from '../lib/change-detection';
import type { ParsedTranscript } from '../../PAI/TOOLS/TranscriptParser';

interface HookInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
}

const STATE_DIR = paiPath('MEMORY', 'STATE');
const STATE_FILE = join(STATE_DIR, 'integrity-state.json');
const INTEGRITY_SCRIPT = paiPath('TOOLS', 'IntegrityMaintenance.ts');

/**
 * Build the integrity-state record. PURE + INJECTABLE (`now` and `cooldownUntil` are params, so no
 * ambient clock) — the byte-critical shape read back by change-detection lives here, hermetically
 * testable off the fs path. `last_run` stays `now.toISOString()` (UTC `…Z`) — NO isoOffset swap: this
 * file's only AC swap is the fs write, and the byte-identical constraint forbids reformatting the field.
 * hashChanges is deterministic, so it is called inside without breaking hermeticity.
 */
export function buildIntegrityState(
  changes: FileChange[],
  now: Date,
  cooldownUntil: string,
): IntegrityState {
  return {
    last_run: now.toISOString(),
    last_changes_hash: hashChanges(changes),
    cooldown_until: cooldownUntil,
  };
}

/**
 * Update the integrity state file.
 */
function updateIntegrityState(changes: FileChange[]): void {
  try {
    const state = buildIntegrityState(changes, new Date(), getCooldownEndTime());

    // P: ensureDir + atomic tmp+rename (durability upgrade). Bytes byte-identical to the original
    // writeFileSync — no trailing newline (that is why atomicWrite, not saveJson).
    ensureDir(STATE_DIR);
    atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
    console.error('[SystemIntegrity] Updated state file');
  } catch (error) {
    console.error('[SystemIntegrity] Failed to update state:', error);
  }
}

/**
 * Spawn the IntegrityMaintenance script in the background.
 *
 * DEFERRED std/proc convergence (AC10) — this is the detached spawnDetached variant, kept caller-local.
 */
function spawnIntegrityMaintenance(
  changes: FileChange[],
  hookInput: HookInput
): void {
  try {
    // Check if script exists
    if (!existsSync(INTEGRITY_SCRIPT)) {
      console.error('[SystemIntegrity] IntegrityMaintenance.ts not found:', INTEGRITY_SCRIPT);
      return;
    }

    // Pre-compute title and metadata for logging
    const filteredChanges = changes.filter(c => c.category !== null);
    const title = generateDescriptiveTitle(filteredChanges);
    const significance = determineSignificance(filteredChanges);
    const changeType = inferChangeType(filteredChanges);

    console.error(`[SystemIntegrity] Title: ${title}`);
    console.error(`[SystemIntegrity] Significance: ${significance}`);
    console.error(`[SystemIntegrity] Change type: ${changeType}`);

    // Prepare input data
    const inputData = JSON.stringify({
      session_id: hookInput.session_id,
      transcript_path: hookInput.transcript_path,
      changes: filteredChanges.map(c => ({
        tool: c.tool,
        path: c.path,
        category: c.category,
        isPhilosophical: c.isPhilosophical,
        isStructural: c.isStructural,
      })),
    });

    // Spawn detached process
    const child = spawn('bun', [INTEGRITY_SCRIPT], {
      detached: true,
      stdio: ['pipe', 'ignore', 'inherit'],  // stdin for input, ignore stdout, inherit stderr for logging
      env: { ...process.env },
    });

    // Write input data to stdin
    child.stdin?.write(inputData);
    child.stdin?.end();

    // Detach from parent
    child.unref();

    console.error(`[SystemIntegrity] Spawned IntegrityMaintenance (pid: ${child.pid})`);
  } catch (error) {
    console.error('[SystemIntegrity] Failed to spawn IntegrityMaintenance:', error);
  }
}

/**
 * Handle system integrity check with pre-parsed transcript data.
 *
 * This handler:
 * 1. Parses the transcript for file modification tool_use blocks
 * 2. Filters for PAI system paths (excludes WORK/, LEARNING/)
 * 3. Checks throttle cooldown (max once per 5 min)
 * 4. Spawns background IntegrityMaintenance.ts if changes detected
 */
export async function handleSystemIntegrity(
  parsed: ParsedTranscript,
  hookInput: HookInput
): Promise<void> {
  console.error('[SystemIntegrity] Checking for system changes...');

  // Check cooldown
  if (isInCooldown()) {
    console.error('[SystemIntegrity] In cooldown period, skipping');
    return;
  }

  // Parse changes from transcript
  const changes = parseToolUseBlocks(hookInput.transcript_path);
  console.error(`[SystemIntegrity] Found ${changes.length} file changes in transcript`);

  // Filter to only PAI system changes
  const systemChanges = changes.filter(c => c.category !== null);
  console.error(`[SystemIntegrity] ${systemChanges.length} are PAI system changes`);

  if (systemChanges.length === 0) {
    console.error('[SystemIntegrity] No system changes detected, skipping');
    return;
  }

  // Check if significant
  if (!isSignificantChange(systemChanges)) {
    console.error('[SystemIntegrity] Changes not significant enough, skipping');
    return;
  }

  // Check for duplicate run
  if (isDuplicateRun(changes)) {
    console.error('[SystemIntegrity] Duplicate change set, skipping');
    return;
  }

  // Log what we found
  console.error('[SystemIntegrity] Significant changes detected:');
  for (const change of systemChanges.slice(0, 5)) {
    console.error(`  - [${change.category}] ${change.path}`);
  }
  if (systemChanges.length > 5) {
    console.error(`  ... and ${systemChanges.length - 5} more`);
  }

  // Update state before spawning
  updateIntegrityState(systemChanges);

  // Voice notification removed — the "documenting" message from IntegrityMaintenance
  // already implies the check happened. No need for a separate "checking" announcement.

  // Spawn background process
  spawnIntegrityMaintenance(systemChanges, hookInput);
  console.error('[SystemIntegrity] Background integrity check started');
}
