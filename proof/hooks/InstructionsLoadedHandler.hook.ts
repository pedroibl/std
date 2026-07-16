#!/usr/bin/env bun
/**
 * InstructionsLoadedHandler.hook.ts - PAI Instruction Integrity Audit (InstructionsLoaded)
 *
 * Computes SHA-256 hashes of critical PAI instruction files and compares against
 * stored known-good baselines. Logs any changes for audit trail. Read-only — never
 * blocks session start.
 *
 * TRIGGER: InstructionsLoaded (fires when CLAUDE.md and rules files are loaded)
 *
 * INPUT:
 * - event: Loaded instruction details (from stdin JSON)
 *
 * OUTPUT:
 * - No stdout (read-only audit hook, no additionalContext)
 * - Always exits 0 (never blocks session start)
 *
 * SIDE EFFECTS:
 * - Creates/updates: MEMORY/STATE/instruction-hashes.json (baseline hashes)
 * - Appends to: MEMORY/STATE/instruction-integrity.jsonl (change log)
 *
 * PERFORMANCE: <20ms typical. Non-blocking.
 *
 * Story 13.8 rewrite (context & prompt lifecycle cluster — dormant hook, InstructionsLoaded):
 *   - appendIntegrityLog → std/report.appendJsonlEvent (a durability/atomicity upgrade over the prior
 *     read-whole-file + Bun.write rewrite): appendJsonlEvent is best-effort (never throws), size-rotated,
 *     and ensures the parent dir itself — so the local STATE_DIR mkdir guard is now redundant. The state
 *     path (MEMORY/STATE/instruction-integrity.jsonl) stays caller-local. It is SYNC, so appendIntegrityLog
 *     becomes sync and its call-sites drop `await` (fail-open unaffected — every path still exits 0).
 *   - DEFER SHA-256 (:71-82, Bun.CryptoHasher) — a DIFFERENT algorithm from core.contentHash (djb2); a
 *     file hash, not a dedup hash → kept caller-local (sibling, not a consumer).
 *   - DEFER the stdin read-and-discard (:128-135, value unused) — low-value swap, kept caller-local per
 *     the story's per-file map. main() stays async, main().catch(()=>exit 0) → fail-open by construction.
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { appendJsonlEvent } from 'std/report';

// ========================================
// Configuration
// ========================================

const HOME = homedir();
const PAI_DIR = process.env.PAI_DIR || join(HOME, '.claude', 'PAI');
const STATE_DIR = join(PAI_DIR, 'MEMORY', 'STATE');
const HASHES_FILE = join(STATE_DIR, 'instruction-hashes.json');
const INTEGRITY_LOG_FILE = 'instruction-integrity.jsonl';

/** Critical PAI instruction files to monitor */
const CRITICAL_FILES: Record<string, string> = {
  'CLAUDE.md': join(HOME, '.claude', 'CLAUDE.md'),
  'SYSTEM-PROMPT': join(PAI_DIR, 'PAI_SYSTEM_PROMPT.md'),
  'DA_IDENTITY': join(PAI_DIR, 'USER', 'DA_IDENTITY.md'),
  'PRINCIPAL_IDENTITY': join(PAI_DIR, 'USER', 'PRINCIPAL_IDENTITY.md'),
};

// ========================================
// Types
// ========================================

interface StoredHashes {
  created: string;
  updated: string;
  hashes: Record<string, string>;
}

interface IntegrityLogEntry {
  timestamp: string;
  event: 'hash_changed' | 'file_missing' | 'baseline_created';
  file: string;
  path: string;
  old_hash?: string;
  new_hash?: string;
  message?: string;
}

// ========================================
// Hashing
// ========================================

async function hashFile(path: string): Promise<string | null> {
  try {
    const file = Bun.file(path);
    if (!await file.exists()) return null;
    const content = await file.arrayBuffer();
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(new Uint8Array(content));
    return hasher.digest('hex');
  } catch {
    return null;
  }
}

// ========================================
// State Management
// ========================================

async function loadStoredHashes(): Promise<StoredHashes | null> {
  try {
    const file = Bun.file(HASHES_FILE);
    if (!await file.exists()) return null;
    return await file.json() as StoredHashes;
  } catch {
    return null;
  }
}

async function saveHashes(hashes: Record<string, string>): Promise<void> {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  const now = new Date().toISOString();
  const stored = await loadStoredHashes();
  const data: StoredHashes = {
    created: stored?.created || now,
    updated: now,
    hashes,
  };
  await Bun.write(HASHES_FILE, JSON.stringify(data, null, 2) + '\n');
}

// report.appendJsonlEvent(dir, file, record): best-effort, size-rotated, ensures the dir itself —
// a durability upgrade over the prior read-whole-file + Bun.write append. Never throws (FR9).
function appendIntegrityLog(entry: IntegrityLogEntry): void {
  appendJsonlEvent(STATE_DIR, INTEGRITY_LOG_FILE, entry);
}

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  // Read and discard stdin (hook contract requires consuming it).
  // DEFER (13.8): stdin-discard swap is low-value (value unused) → kept caller-local.
  try {
    const reader = Bun.stdin.stream().getReader();
    const readLoop = (async () => {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    })();
    await Promise.race([readLoop, new Promise<void>(r => setTimeout(r, 200))]);
  } catch {
    // Stdin read failure is fine — we only need to audit files
  }

  const now = new Date().toISOString();

  // Compute current hashes for all critical files
  const currentHashes: Record<string, string> = {};
  const missingFiles: string[] = [];

  for (const [label, path] of Object.entries(CRITICAL_FILES)) {
    const hash = await hashFile(path);
    if (hash) {
      currentHashes[label] = hash;
    } else {
      missingFiles.push(label);
    }
  }

  // Load stored baseline
  const stored = await loadStoredHashes();

  if (!stored) {
    // First run — create baseline
    await saveHashes(currentHashes);
    appendIntegrityLog({
      timestamp: now,
      event: 'baseline_created',
      file: '*',
      path: HASHES_FILE,
      message: `Baseline created with ${Object.keys(currentHashes).length} files`,
    });
    process.exit(0);
    return;
  }

  // Compare against stored hashes
  let changed = false;

  for (const [label, path] of Object.entries(CRITICAL_FILES)) {
    const oldHash = stored.hashes[label];
    const newHash = currentHashes[label];

    if (oldHash && !newHash) {
      // File was present before but is now missing
      appendIntegrityLog({
        timestamp: now,
        event: 'file_missing',
        file: label,
        path,
        old_hash: oldHash,
        message: `WARNING: Critical file missing — was previously tracked`,
      });
      changed = true;
    } else if (oldHash && newHash && oldHash !== newHash) {
      // Hash changed
      appendIntegrityLog({
        timestamp: now,
        event: 'hash_changed',
        file: label,
        path,
        old_hash: oldHash,
        new_hash: newHash,
      });
      changed = true;
    }
    // New file appearing (no oldHash, has newHash) — just add to baseline silently
  }

  // Update stored hashes if anything changed or new files appeared
  if (changed || Object.keys(currentHashes).length !== Object.keys(stored.hashes).length) {
    await saveHashes(currentHashes);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
