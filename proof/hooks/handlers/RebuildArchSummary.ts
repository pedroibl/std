#!/usr/bin/env bun
/**
 * RebuildArchSummary.ts - Regenerate DOCUMENTATION/ARCHITECTURE_SUMMARY.md when system files change
 *
 * PURPOSE:
 * Watches PAI system docs, hooks, Algorithm spec, Tools, user config, and security
 * policy for mtime changes. When any tracked file is newer than the current
 * DOCUMENTATION/ARCHITECTURE_SUMMARY.md, invokes Tools/ArchitectureSummaryGenerator.ts to
 * regenerate it.
 *
 * TRIGGER: called from DocIntegrity.hook.ts on Stop. Parent-invoked handler (no own stdin) — so
 * there is no main()/import.meta.main and NO stdin posture: the pure exported `decideRebuild` carries
 * all the logic and is unit-tested hermetically; the impure handler shell just wires real fs + spawn.
 *
 * Story 13.3 rewrite (consumer sweep) — the two re-hand-rolled fs/subprocess primitives now import
 * tested std slices, behavior + frozen contracts preserved:
 *   - the mtime dir-scan (readdirSync + statSync().mtimeMs over 7 tracked dirs, live :55-73) → std/fsx
 *     walkFiles + statMtime (P1). walkFiles is RECURSIVE by default; the live scan was NON-recursive
 *     (one level per dir), so it is PINNED to one level via `{ prune: () => true }` — see DELTA below.
 *   - the spawn('bun',[gen,'generate'], {cwd,stdio:'pipe'}) close/error promise (live :97-118) → std/proc
 *     spawnCapture (P2) — capturing, non-detached, never-reject already matches the hand-rolled Promise.
 *
 * Behavioral deltas recorded (not silent):
 *   - walkFiles recursion PINNED to one level (`prune: () => true`) to match the live non-recursive
 *     readdirSync. Edge nuance: the live scan used `dirent.isFile()` (does NOT follow symlinks); walkFiles
 *     uses statSync (FOLLOWS symlinks), so a symlinked file directly under a tracked dir would be counted
 *     here but skipped live. Tracked dirs (DOCUMENTATION/TOOLS/ALGORITHM/…) hold no symlinked .ts/.md, so
 *     no live effect.
 *   - cwd DROPPED: the live spawn passed `{ cwd: paiDir }`; spawnCapture has no cwd option. The generator
 *     resolves every path from `PAI_DIR`/`HOME` (never process.cwd()), so dropping cwd is behavior-
 *     preserving (verified in ArchitectureSummaryGenerator.ts).
 *   - spawn-launch failure: the live code logged "[RebuildArchSummary] Spawn error:" on the 'error' event;
 *     spawnCapture maps a launch failure to code 127 (never rejects), so it now flows through the
 *     `code !== 0` branch → "[RebuildArchSummary] Regeneration failed (exit 127): <message>". Never-reject
 *     and the stderr log are preserved; only the log wording for the launch-failure case changes.
 *
 * KEEP-AS-IS (frozen, verbatim): the 7-tracked-dir + 2-extra-file lists, the trackedExtensions set, the
 * mtime-newer-than-output trigger, and the output path DOCUMENTATION/PAI_ARCHITECTURE_SUMMARY.md (live :27)
 * even though the log strings say ARCHITECTURE_SUMMARY.md.
 */

import { join } from "path";
import { exists, statMtime, walkFiles } from "std/fsx";
import { spawnCapture } from "std/proc";
import { getPaiDir, getClaudeDir } from "../lib/paths";

// Caller-local identity (D4): the tracked-extension set, verbatim from the live scan.
const trackedExtensions = new Set([".ts", ".md", ".yaml", ".yml", ".sh", ".json"]);

export type RebuildReason = "missing-output" | "system-changed" | "current";

export interface RebuildProbe {
  /** Tracked FILES (absolute paths) directly under `dir`, ONE level, extension-filtered. */
  listTrackedFiles: (dir: string) => string[];
  /** mtime in ms; missing/unstatable → 0 (statMtime contract). */
  mtime: (path: string) => number;
  exists: (path: string) => boolean;
}

export interface RebuildDecision {
  rebuild: boolean;
  reason: RebuildReason;
  newestFile: string;
  newestMtime: number;
}

/**
 * The tracked-extension predicate, operating on the basename EXACTLY as the live scan did
 * (`name.slice(name.lastIndexOf("."))` — a no-dot name slices its last char, which is never a tracked
 * extension, so it is skipped, matching the live quirk). Pure.
 */
export function isTracked(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = name.slice(name.lastIndexOf("."));
  return trackedExtensions.has(ext);
}

/**
 * PURE + INJECTABLE core: given the tracked dirs, the 2 extra files, the output path, and injected fs
 * probes, decide whether to regenerate and why. No spawning, no real fs — fully hermetic under test.
 * Mirrors the live control flow (:33-91): output missing → rebuild; else the newest tracked-dir/extra
 * file mtime vs the output mtime decides.
 */
export function decideRebuild(
  trackedDirs: string[],
  extraFiles: string[],
  outputPath: string,
  probe: RebuildProbe,
): RebuildDecision {
  if (!probe.exists(outputPath)) {
    return { rebuild: true, reason: "missing-output", newestFile: "", newestMtime: 0 };
  }
  const outputMtime = probe.mtime(outputPath);

  let newestFile = "";
  let newestMtime = 0;

  for (const dir of trackedDirs) {
    for (const filePath of probe.listTrackedFiles(dir)) {
      const mtime = probe.mtime(filePath);
      if (mtime > newestMtime) {
        newestMtime = mtime;
        newestFile = filePath;
      }
    }
  }

  for (const f of extraFiles) {
    if (!probe.exists(f)) continue;
    const mtime = probe.mtime(f);
    if (mtime > newestMtime) {
      newestMtime = mtime;
      newestFile = f;
    }
  }

  if (newestMtime > outputMtime) {
    return { rebuild: true, reason: "system-changed", newestFile, newestMtime };
  }
  return { rebuild: false, reason: "current", newestFile, newestMtime };
}

/**
 * Real-fs one-level tracked-file lister. walkFiles is recursive by default, so it is pinned to a single
 * level via `prune: () => true` (every subdir found is NOT descended; the root itself is always scanned) —
 * reproducing the live non-recursive readdirSync. walkFiles is fail-soft on a missing/unreadable dir (→ []),
 * matching the live `if (!existsSync(dir)) continue` + per-dir try/catch skip.
 */
function listTrackedFilesFs(dir: string): string[] {
  return walkFiles(dir, isTracked, { prune: () => true });
}

export async function handleRebuildArchSummary(): Promise<void> {
  const paiDir = getPaiDir();
  const claudeDir = getClaudeDir();
  // Verbatim (live :27): output path stays PAI_ARCHITECTURE_SUMMARY.md even though logs say ARCHITECTURE_SUMMARY.md.
  const output = join(paiDir, "DOCUMENTATION", "PAI_ARCHITECTURE_SUMMARY.md");
  const generator = join(paiDir, "Tools/ArchitectureSummaryGenerator.ts");

  if (!exists(generator)) return;

  try {
    // Frozen caller-local lists (D4) — 7 tracked dirs + 2 extra files, verbatim.
    const trackedDirs = [
      join(paiDir, ""),
      join(paiDir, "DOCUMENTATION"),
      join(claudeDir, "hooks"),
      join(paiDir, "ALGORITHM"),
      join(paiDir, "TOOLS"),
      join(paiDir, "USER", "Config"),
      join(paiDir, "USER", "SECURITY"),
    ];
    const extraFiles = [join(claudeDir, "settings.json"), join(claudeDir, "CLAUDE.md")];

    const decision = decideRebuild(trackedDirs, extraFiles, output, {
      listTrackedFiles: listTrackedFilesFs,
      mtime: statMtime,
      exists,
    });

    if (decision.reason === "missing-output") {
      console.error("[RebuildArchSummary] Architecture summary missing - regenerating");
      await rebuild(generator);
    } else if (decision.reason === "system-changed") {
      const rel = decision.newestFile.replace(claudeDir + "/", "");
      console.error(`[RebuildArchSummary] System file changed (${rel}) - regenerating`);
      await rebuild(generator);
    } else {
      console.error("[RebuildArchSummary] DOCUMENTATION/ARCHITECTURE_SUMMARY.md is current");
    }
  } catch (error) {
    console.error("[RebuildArchSummary] Error checking architecture summary:", error);
  }
}

async function rebuild(generator: string): Promise<void> {
  // cwd=paiDir dropped: generator resolves from PAI_DIR/HOME, not process.cwd() (see DELTA). spawnCapture
  // never rejects — a launch failure surfaces as code 127 with the message on stderr.
  const { code, stderr } = await spawnCapture("bun", [generator, "generate"]);
  if (code === 0) {
    console.error("[RebuildArchSummary] Regenerated DOCUMENTATION/ARCHITECTURE_SUMMARY.md");
  } else {
    console.error(`[RebuildArchSummary] Regeneration failed (exit ${code}): ${stderr.trim()}`);
  }
}
