#!/usr/bin/env bun
/**
 * reference-check.ts — the full-surface entrypoint over the unified ref-check engine (Story 12.3).
 *
 * Was `~/.claude/PAI/TOOLS/ReferenceCheck.ts` — the documented superset of DocCheck. Same behavior,
 * flags, exit policy, and (load-bearing) JSON envelope; the shared ref-extraction / resolution /
 * freshness / classification loop now lives in `runRefCheck`, and this file is ReferenceCheck's config
 * over it: the pruned full-tree file source (`fsx.walkFiles` + the exclusion lists as a `prune`
 * predicate), the `REF_PATTERNS` superset, the full resolution ladder, orphan detection, and the
 * `{ scannedFiles, scannedRefs, elapsedMs, findings, summary }` envelope.
 *
 * ⚠ The JSON envelope is a LIVE contract: `IntegrityMaintenance.ts` runs this with `--json` and parses
 * `scannedFiles` / `scannedRefs` / `findings` (keying each finding on `type` / `file` / `resolved`). Its
 * shape and the per-finding field names are frozen. All PAI identity (roots, anchor union, the five
 * exclusion lists, the archived-Algorithm convention, the orphan policy) lives HERE and is injected —
 * nothing PAI enters `std/src`. Roots are injected via `env` so tests stay hermetic.
 */

import { readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { hasFlag } from "std/core";
import { exists, resolveFrameworkDir, walkFiles } from "std/fsx";
import { type RefCheckConfig, type RefFinding, runRefCheck } from "./ref-check";

const HELP = `ReferenceCheck — validate every reference across ~/.claude

Usage: bun reference-check.ts [flags]

Flags:
  --json       Structured JSON output
  --quiet      Suppress OK lines; issues only
  --changed    Only scan git-dirty files + their dependents
  --stale      Include stale findings (ref mtime > referrer mtime)
  --orphans    Include orphan findings (file exists, nothing refs it)
  --help       This message

Exit codes: 0 clean, 1 missing refs, 2 scan error`;

/** Injected estate roots (identity, D4) — defaulted from $HOME, overridden by tests. */
export interface RefCheckEnv {
  claudeDir: string;
  paiDir: string;
}

export function defaultEnv(home = process.env.HOME || ""): RefCheckEnv {
  const paiDir = resolveFrameworkDir(home);
  const claudeDir = dirname(paiDir);
  return { claudeDir, paiDir };
}

// ── Exclusion rules (verbatim from ReferenceCheck.ts:63-169) ──

const EXCLUDE_DIR_NAMES = new Set([
  "node_modules", ".git", ".next", ".turbo", ".cache", "dist", "build", "logs",
]);

const EXCLUDE_PATH_PREFIXES = [
  "PAI/MEMORY", "PAI/PULSE/Observability/.next", "PAI/PULSE/Observability/node_modules",
  "PAI/PULSE/state", "PAI/PAI_RELEASES", "PAI_RELEASES", "PAI/USER/ACTIONS", "PAI/USER/ARBOL",
  "PAI/USER/Daemon", "PAI/USER/SKILLCUSTOMIZATIONS", "PAI/USER/SHARED", "PAI/ARBOL", "MEMORY",
  "Projects", "projects", "Plans", "plan", "plans", "plugins", "cache", "tasks", "teams",
  "sessions", "session-env", "shell-snapshots", "statsig", "todos", "ide", "telemetry",
  "usage-data", "test-results", "downloads", "backups", "paste-cache", "file-history", "History",
  "commands", ".prd", ".venv", ".vscode", ".wrangler", ".next", ".claude",
];

const EXCLUDE_SUBSTRINGS = ["/Patterns/", "/MigrationNotes.md", "/Templates/"];

const EXCLUDE_FILE_SUFFIXES = [".backup", ".old", ".retired", ".bak", ".orig", ".log", ".jsonl", ".lock"];

const EXCLUDE_FILE_NAMES = new Set(["package-lock.json", "bun.lockb", "bun.lock", "yarn.lock", "pnpm-lock.yaml"]);

/** Archived Algorithm snapshots reference renamed doctrine intentionally — exclude all but the latest. */
function makeArchivedAlgorithmVersion(paiDir: string): (relPath: string) => boolean {
  let latestCache: string | null = null;
  const latest = (): string => {
    if (latestCache !== null) return latestCache;
    try {
      const algDir = join(paiDir, "ALGORITHM");
      const versions = readdirSync(algDir)
        .map((f) => f.match(/^v(\d+\.\d+\.\d+)\.md$/)?.[1])
        .filter((v): v is string => !!v)
        .sort((a, b) => {
          const pa = a.split(".").map(Number);
          const pb = b.split(".").map(Number);
          for (let i = 0; i < 3; i++) {
            const d = (pa[i] || 0) - (pb[i] || 0);
            if (d !== 0) return d;
          }
          return 0;
        });
      latestCache = versions[versions.length - 1] || "";
    } catch {
      latestCache = "";
    }
    return latestCache;
  };
  return (relPath: string) => {
    const m = relPath.match(/^PAI\/ALGORITHM\/v(\d+\.\d+\.\d+)\.md$/);
    if (!m) return false;
    return m[1] !== latest();
  };
}

function isExcludedDir(absPath: string, claudeDir: string): boolean {
  const base = absPath.split(sep).pop() || "";
  if (EXCLUDE_DIR_NAMES.has(base)) return true;
  const rel = relative(claudeDir, absPath);
  if (rel.startsWith("..")) return true;
  for (const pref of EXCLUDE_PATH_PREFIXES) {
    if (rel === pref || rel.startsWith(pref + sep)) return true;
  }
  // Private (underscore) skills are deleted from the staging tree before release — not a public concern.
  if (rel.startsWith(`skills${sep}_`)) return true;
  return false;
}

function makeIsScannableFile(claudeDir: string, isArchived: (rel: string) => boolean): (absPath: string) => boolean {
  return (absPath: string) => {
    const base = absPath.split(sep).pop() || "";
    if (EXCLUDE_FILE_NAMES.has(base)) return false;
    for (const suf of EXCLUDE_FILE_SUFFIXES) if (base.endsWith(suf)) return false;
    if (base.includes(".backup-")) return false;
    for (const sub of EXCLUDE_SUBSTRINGS) if (absPath.includes(sub)) return false;
    const rel = relative(claudeDir, absPath);
    if (isArchived(rel)) return false;
    const ext = extname(absPath);
    return ext === ".md" || ext === ".ts" || ext === ".tsx" || ext === ".json";
  };
}

// ── ReferenceCheck's REF_PATTERNS superset (verbatim from ReferenceCheck.ts:260-281) ──
const EXT = "\\.\\w+(?:\\.\\w+)*";
const REF_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: new RegExp("`((?:PAI|hooks|skills|agents|Pulse|USER|MEMORY|Components|Algorithm|Tools|Workflows|References)\\/[\\w/@.-]+?" + EXT + ")`", "g"), label: "backtick-anchored" },
  { re: new RegExp("`~\\/\\.claude\\/([\\w/@.-]+?" + EXT + ")`", "g"), label: "backtick-home" },
  { re: new RegExp("`\\$(?:HOME|\\{HOME\\})\\/\\.claude\\/([\\w/@.-]+?" + EXT + ")`", "g"), label: "backtick-env-home" },
  { re: /^@(PAI\/[\w/@.-]+\.md)/gm, label: "at-import" },
  { re: /\[[^\]]+\]\((\.?\.?\/?[\w/@.-]+?\.(?:md|ts|tsx|json|yaml|yml))\)/g, label: "md-link" },
  { re: new RegExp("→\\s+[\\w\\s]+:\\s+`([\\w/@.-]+?" + EXT + ")`", "g"), label: "arrow" },
  { re: new RegExp("\\|\\s*`?((?:PAI|hooks|skills|agents|Pulse|USER|Components|Algorithm|Tools)\\/[\\w/@.-]+?" + EXT + ")`?\\s*\\|", "g"), label: "table-cell" },
  { re: /from\s+["'](\.\.?\/[\w/@.-]+?)["']/g, label: "ts-import" },
  { re: new RegExp("\\$\\{?HOME\\}?\\/\\.claude\\/((?:hooks|PAI|skills|agents)\\/[\\w/@.-]+?" + EXT + ")", "g"), label: "json-home" },
];

/** ReferenceCheck's full resolution ladder (ReferenceCheck.ts:396-443). */
function refResolve(env: RefCheckEnv, raw: string, refDir: string, sectionRoot: string): { resolved: string; exists: boolean } {
  let resolved: string | null = null;
  const candidates: string[] = [];
  if (raw.startsWith("/")) {
    candidates.push(raw);
  } else if (raw.startsWith("./") || raw.startsWith("../")) {
    candidates.push(resolve(refDir, raw));
  } else {
    candidates.push(resolve(env.claudeDir, raw));
    candidates.push(resolve(env.paiDir, raw));
    candidates.push(resolve(refDir, raw));
    const skillM = refDir.match(/^(.*\/skills\/[^/]+)(\/(?:Workflows|Tools|References))?/);
    if (skillM) candidates.push(resolve(skillM[1], raw));
    if (sectionRoot) candidates.push(resolve(env.claudeDir, sectionRoot, raw));
  }
  for (const cand of candidates) {
    if (exists(cand)) { resolved = cand; break; }
    const jsExt = /\.(js|mjs|cjs)$/;
    if (jsExt.test(cand)) {
      const tsCand = cand.replace(jsExt, ".ts");
      if (exists(tsCand)) { resolved = tsCand; break; }
      const tsxCand = cand.replace(jsExt, ".tsx");
      if (exists(tsxCand)) { resolved = tsxCand; break; }
    }
    let found: string | null = null;
    for (const ext of [".ts", ".tsx", ".js", ".mjs"]) {
      if (exists(cand + ext)) { found = cand + ext; break; }
    }
    if (found) { resolved = found; break; }
    if (!extname(cand)) {
      const idx = join(cand, "index.ts");
      if (exists(idx)) { resolved = idx; break; }
    }
  }
  if (!resolved) resolved = candidates[0] || raw;
  return { resolved, exists: exists(resolved) };
}

export function buildRefConfig(
  env: RefCheckEnv,
  opts: { changedOnly: boolean; includeStale: boolean; includeOrphans: boolean },
): RefCheckConfig {
  const isArchived = makeArchivedAlgorithmVersion(env.paiDir);
  const isScannableFile = makeIsScannableFile(env.claudeDir, isArchived);
  return {
    claudeDir: env.claudeDir,
    patterns: REF_PATTERNS,
    fileSource: () => walkFiles(env.claudeDir, isScannableFile, { prune: (d) => isExcludedDir(d, env.claudeDir) }),
    resolveRef: (raw, refDir, sectionRoot) => refResolve(env, raw, refDir, sectionRoot),
    fenceSkip: true, // ReferenceCheck skips fenced refs in .md
    tsNarrow: true, // .ts/.tsx referrers → only ts-import patterns
    sectionAware: "md-only", // section roots only for .md
    noiseFilters: true, // full noise-filter set
    includeStale: opts.includeStale,
    staleMinDays: 1, // ReferenceCheck reports only ≥1-day-stale
    includeOrphans: opts.includeOrphans,
    isOrphanCandidate: (rel) => /^PAI\/[^/]+\.md$/.test(rel),
    changedOnly: opts.changedOnly,
  };
}

/** ReferenceCheck's frozen `{ scannedFiles, scannedRefs, elapsedMs, findings, summary }` envelope. */
export interface RefEnvelope {
  scannedFiles: number;
  scannedRefs: number;
  elapsedMs: number;
  findings: RefFinding[];
  summary: { missing: number; stale: number; orphan: number };
}

export function refEnvelope(result: { scannedFiles: number; scannedRefs: number; findings: RefFinding[] }, elapsedMs: number): RefEnvelope {
  const missing = result.findings.filter((f) => f.type === "missing").length;
  const stale = result.findings.filter((f) => f.type === "stale").length;
  const orphan = result.findings.filter((f) => f.type === "orphan").length;
  return {
    scannedFiles: result.scannedFiles,
    scannedRefs: result.scannedRefs,
    elapsedMs,
    findings: result.findings,
    summary: { missing, stale, orphan },
  };
}

export function main(argv: string[] = process.argv.slice(2), env: RefCheckEnv = defaultEnv(), now: () => number = Date.now): number {
  if (hasFlag(argv, "help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const jsonOutput = hasFlag(argv, "json");
  const quiet = hasFlag(argv, "quiet");
  const changedOnly = hasFlag(argv, "changed");
  const includeStale = hasFlag(argv, "stale");
  const includeOrphans = hasFlag(argv, "orphans");

  const startedAt = now();
  let envelope: RefEnvelope;
  try {
    const result = runRefCheck(buildRefConfig(env, { changedOnly, includeStale, includeOrphans }));
    envelope = refEnvelope(result, now() - startedAt);
  } catch (e) {
    console.error(`ReferenceCheck: scan error — ${(e as Error)?.message || e}`);
    return 2;
  }

  const { summary } = envelope;
  if (jsonOutput) {
    console.log(JSON.stringify(envelope, null, 2));
  } else {
    const missing = envelope.findings.filter((f) => f.type === "missing");
    const stale = envelope.findings.filter((f) => f.type === "stale");
    const orphan = envelope.findings.filter((f) => f.type === "orphan");
    if (missing.length > 0) {
      console.error(`\n❌ MISSING REFERENCES (${missing.length}):`);
      for (const f of missing) console.error(`  ${f.file}:${f.line} → ${f.ref}`);
    }
    if (stale.length > 0) {
      console.error(`\n⚠️  STALE (${stale.length}):`);
      for (const f of stale) console.error(`  ${f.file}:${f.line} → ${f.ref}  (${f.detail})`);
    }
    if (orphan.length > 0) {
      console.error(`\n📦 ORPHANS (${orphan.length}):`);
      for (const f of orphan) console.error(`  ${f.file}`);
    }
    if (!quiet || envelope.findings.length > 0) {
      console.error(
        `\nReferenceCheck: ${envelope.scannedFiles} files, ${envelope.scannedRefs} refs, ${summary.missing} missing, ${summary.stale} stale, ${summary.orphan} orphan — ${envelope.elapsedMs}ms`,
      );
    }
    if (envelope.findings.length === 0 && !quiet) {
      console.error("✅ All references valid.");
    }
  }

  return summary.missing > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exit(main());
}
