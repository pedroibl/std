#!/usr/bin/env bun
/**
 * ISASync.hook.ts — Read-only ISA → work.json sync via PostToolUse
 *
 * TRIGGER: PostToolUse (Write, Edit) — DORMANT / not-wired (only TelosSummarySync is the live W/E hook).
 * Fired for proof via an exact-contract stdin pipe, like 13.3's ConfigAudit/FileChanged.
 *
 * v4.1.0 (PRD → ISA rename): the per-session artifact is now ISA.md.
 * Sessions created before v4.1.0 still ship a PRD.md; this hook reads either,
 * preferring ISA.md when both exist (legacy behavior — there should never be
 * both for a single session).
 *
 * v3.2.0: Hooks are READ-ONLY from the artifact's perspective.
 * The AI writes all ISA content directly (criteria, checkboxes, frontmatter).
 * This hook ONLY reads the ISA and syncs to work.json for the dashboard.
 *
 * - Write/Edit on ISA.md (or legacy PRD.md) → read frontmatter + criteria → sync to work.json
 *
 * ── Story 13.5 rewrite (consumer sweep onto the std substrate; AD-9.4) ──────────────────────────────
 * PRIMITIVE SWAPS:
 *   P1   JSON.parse(readFileSync(0, …)) stdin (:33) + top-level try/catch → std/stdio readStdinJson
 *   fsx  existsSync (:52) → fsx.exists; readFileSync (:54) → fsx.readIfExists
 * POSTURE (AD-9.4 Rule 2) — fail-OPEN, PRESERVED. readStdinJson maps empty/malformed/timeout → null; the
 *   visible `null → return` branch falls through to the single `.finally` that emits `{continue:true}` +
 *   exit 0 (the mandatory Rule-2 checkpoint). The old top-level `catch → process.exit(0)` becomes this null
 *   branch — same "continue" outcome, now with the explicit envelope.
 * FROZEN FACADE (AD-9.4 Rule 3): parseFrontmatter / syncToWorkJson / readRegistry are called THROUGH the
 *   frozen `./lib/isa-utils` facade — their internal collapse is that module's concern, not this hook's.
 *   `./lib/observability-transport` (13.3) + `./lib/tab-setter`/`./lib/tab-constants` (13.7) stay frozen.
 * CALLER-LOCAL identity (D4): the `'MEMORY/WORK/'` path fragment + the VALID_PHASES set stay HERE.
 */

import { parseFrontmatter, syncToWorkJson, readRegistry, ARTIFACT_FILENAME, LEGACY_ARTIFACT_FILENAME } from './lib/isa-utils';
import { pushStateToTargets, pushEventsToTargets } from './lib/observability-transport';
import { setPhaseTab } from './lib/tab-setter';
import type { AlgorithmTabPhase } from './lib/tab-constants';
import { readStdinJson } from 'std/stdio';
import { exists, readIfExists } from 'std/fsx';

interface HookInput {
  tool_input?: { file_path?: string };
  session_id?: string;
}

async function main() {
  // P1: read + parse stdin, posture-neutral. Fail-OPEN (AD-9.4 Rule 2): null (empty/malformed/timeout) →
  // return; the single `.finally` below emits `{continue:true}` + exit 0. Mirrors the old top-level
  // try/catch → process.exit(0).
  const input = await readStdinJson<HookInput>();
  if (input === null) return;

  const toolInput = input.tool_input || {};

  // Only trigger for ISA.md (or legacy PRD.md) files in MEMORY/WORK/
  const filePath = toolInput.file_path || '';
  if (!filePath.includes('MEMORY/WORK/')) return;
  const isISA = filePath.endsWith('/' + ARTIFACT_FILENAME) || filePath.endsWith(ARTIFACT_FILENAME);
  const isLegacyPRD = filePath.endsWith('/' + LEGACY_ARTIFACT_FILENAME) || filePath.endsWith(LEGACY_ARTIFACT_FILENAME);
  if (!isISA && !isLegacyPRD) return;

  // Use the actual file path that was just written/edited, not findLatestISA()
  // findLatestISA() scans all artifacts by mtime and can return the wrong file
  // when multiple sessions exist or when a file's mtime is bumped by git ops.
  const isaPath = filePath;
  if (!exists(isaPath)) return;

  const content = readIfExists(isaPath);
  if (content === null) return; // vanished between the exists probe and the read — nothing to sync

  const fm = parseFrontmatter(content);
  if (!fm) return;

  // Check existing phase before sync to detect phase changes
  const newPhase = (fm.phase || '').toUpperCase();
  let oldPhase = '';
  if (fm.slug) {
    try {
      const registry = readRegistry();
      const existing = registry.sessions[fm.slug];
      if (existing) oldPhase = (existing.phase || '').toUpperCase();
    } catch { /* silent */ }
  }

  // Sync frontmatter + criteria to work.json (pass session_id for session name lookup)
  syncToWorkJson(fm, isaPath, content, input.session_id);

  // Push to observability targets (awaited so process.exit doesn't kill the fetch)
  await Promise.all([pushStateToTargets(), pushEventsToTargets()]).catch(() => {});

  // Update tab color when algorithm phase changes
  const VALID_PHASES = new Set(['OBSERVE', 'THINK', 'PLAN', 'BUILD', 'EXECUTE', 'VERIFY', 'LEARN', 'COMPLETE']);
  if (newPhase !== oldPhase && VALID_PHASES.has(newPhase) && input.session_id) {
    try {
      setPhaseTab(newPhase as AlgorithmTabPhase, input.session_id);
    } catch (err) {
      console.error('[ISASync] setPhaseTab failed:', err);
    }
  }
}

if (import.meta.main) {
  main().catch(() => {}).finally(() => {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}
