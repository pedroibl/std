#!/usr/bin/env bun
/**
 * doc-check.ts — the narrow curated-doc entrypoint over the unified ref-check engine (Story 12.3).
 *
 * Was `~/.claude/PAI/TOOLS/DocCheck.ts`. Same behavior, envelope, flags, and exit policy; the
 * ref-extraction / resolution / freshness loop now lives in the shared `runRefCheck` engine, and this
 * file is just DocCheck's config over it: the curated `findDocs()` file source, the `PATH_PATTERNS`
 * subset, DocCheck's resolution ladder, and the `{ docsChecked, refsChecked, findings }` envelope with
 * exit `1` iff any missing.
 *
 * All PAI identity (CLAUDE_DIR / PAI_DIR / HOOKS_DIR, the anchor union, the curated doc set) lives HERE,
 * injected into the engine — nothing PAI enters `std/src`. Roots are injected via `env` so tests are
 * hermetic (no real `~/.claude` reads).
 */

import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hasFlag } from "std/core";
import { exists, resolveFrameworkDir } from "std/fsx";
import { type RefCheckConfig, type RefFinding, runRefCheck } from "./ref-check";

/** Injected estate roots (identity, D4) — defaulted from $HOME, overridden by tests. */
export interface DocCheckEnv {
  claudeDir: string;
  paiDir: string;
  hooksDir: string;
}

export function defaultEnv(home = process.env.HOME || ""): DocCheckEnv {
  const paiDir = resolveFrameworkDir(home);
  const claudeDir = dirname(paiDir);
  return { claudeDir, paiDir, hooksDir: join(claudeDir, "hooks") };
}

// ── DocCheck's PATH_PATTERNS (verbatim from DocCheck.ts:34-47), labelled for the engine. ──
const PATH_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /`((?:PAI|hooks|skills|agents|Pulse|USER|MEMORY|Components|Algorithm|Tools)\/[\w/.@-]+\.\w+)`/g, label: "backtick-anchored" },
  { re: /`~\/\.claude\/([\w/.@-]+\.\w+)`/g, label: "backtick-home" },
  { re: /`\$HOME\/\.claude\/([\w/.@-]+\.\w+)`/g, label: "backtick-env-home" },
  { re: /^@(PAI\/[\w/.@-]+\.md)/gm, label: "at-import" },
  { re: /\|\s*`?((?:PAI|hooks|skills|Pulse|USER)\/[\w/.@-]+\.\w+)`?\s*\|/g, label: "table-cell" },
  { re: /→\s+[\w\s]+:\s+`([\w/.@-]+\.\w+)`/g, label: "arrow" },
];

/** DocCheck's curated file source (DocCheck.ts:149-184): PAI docs, DOCUMENTATION, security, hooks README, CLAUDE.md. */
export function findDocs(env: DocCheckEnv): string[] {
  const docs: string[] = [];
  const listMd = (dir: string, exts: string[]) => {
    try {
      for (const f of readdirSync(dir)) {
        if (exts.some((e) => f.endsWith(e))) docs.push(join(dir, f));
      }
    } catch {
      /* dir absent — skip */
    }
  };
  listMd(env.paiDir, [".md"]);
  listMd(join(env.paiDir, "DOCUMENTATION"), [".md"]);
  listMd(join(env.paiDir, "USER", "PAISECURITYSYSTEM"), [".md", ".yaml"]);
  const hooksReadme = join(env.hooksDir, "README.md");
  if (exists(hooksReadme)) docs.push(hooksReadme);
  const claudeMd = join(env.claudeDir, "CLAUDE.md");
  if (exists(claudeMd)) docs.push(claudeMd);
  return docs;
}

/** DocCheck's resolution ladder (DocCheck.ts:118-133): CLAUDE_DIR → PAI_DIR → section-root → referrer-dir. */
function docResolve(env: DocCheckEnv, raw: string, refDir: string, sectionRoot: string): { resolved: string; exists: boolean } {
  let resolved = resolve(env.claudeDir, raw);
  if (!exists(resolved)) {
    const paiResolved = resolve(env.paiDir, raw);
    if (exists(paiResolved)) {
      resolved = paiResolved;
    } else {
      if (sectionRoot) {
        const sectionResolved = resolve(env.claudeDir, sectionRoot, raw);
        if (exists(sectionResolved)) resolved = sectionResolved;
      }
      if (!exists(resolved)) {
        const refDirResolved = resolve(refDir, raw);
        if (exists(refDirResolved)) resolved = refDirResolved;
      }
    }
  }
  return { resolved, exists: exists(resolved) };
}

export function buildDocConfig(env: DocCheckEnv, opts: { changedOnly: boolean }): RefCheckConfig {
  return {
    claudeDir: env.claudeDir,
    patterns: PATH_PATTERNS,
    fileSource: () => findDocs(env),
    resolveRef: (raw, refDir, sectionRoot) => docResolve(env, raw, refDir, sectionRoot),
    fenceSkip: false, // DocCheck does NOT skip fenced refs
    tsNarrow: false, // DocCheck never scans .ts
    sectionAware: "always", // DocCheck computes section roots for every doc
    noiseFilters: false, // DocCheck applies only the vX.Y.Z skip
    includeStale: true, // DocCheck always computes freshness
    staleMinDays: 0, // ...and reports whenever the ref is newer at all
    includeOrphans: false,
    isOrphanCandidate: () => false,
    changedOnly: opts.changedOnly,
  };
}

/** DocCheck's `{ docsChecked, refsChecked, findings }` envelope. Each finding is `{ doc, ref, line, type, detail? }`. */
export interface DocFinding {
  doc: string;
  ref: string;
  line: number;
  type: "missing" | "stale";
  detail?: string;
}
export interface DocEnvelope {
  docsChecked: number;
  refsChecked: number;
  findings: DocFinding[];
}

export function docEnvelope(result: { scannedFiles: number; scannedRefs: number; findings: RefFinding[] }): DocEnvelope {
  const findings: DocFinding[] = result.findings.map((f) => ({
    doc: f.file,
    ref: f.ref ?? "",
    line: f.line ?? 0,
    type: f.type as "missing" | "stale",
    ...(f.detail ? { detail: f.detail } : {}),
  }));
  return { docsChecked: result.scannedFiles, refsChecked: result.scannedRefs, findings };
}

/** Exit `1` iff any missing ref (stale never fails) — DocCheck.ts:302. */
export function docExitCode(env: DocEnvelope): number {
  return env.findings.some((f) => f.type === "missing") ? 1 : 0;
}

export function main(argv: string[] = process.argv.slice(2), env: DocCheckEnv = defaultEnv()): number {
  const changedOnly = hasFlag(argv, "changed");
  const jsonOutput = hasFlag(argv, "json");
  const quiet = hasFlag(argv, "quiet");

  const result = runRefCheck(buildDocConfig(env, { changedOnly }));
  const envelope = docEnvelope(result);

  if (jsonOutput) {
    console.log(JSON.stringify(envelope, null, 2));
  } else {
    const missing = envelope.findings.filter((f) => f.type === "missing");
    const stale = envelope.findings.filter((f) => f.type === "stale");
    if (missing.length > 0) {
      console.error(`\n❌ MISSING REFERENCES (${missing.length}):`);
      for (const f of missing) console.error(`  ${f.doc}:${f.line} → ${f.ref}`);
    }
    if (stale.length > 0) {
      console.error(`\n⚠️  STALE DOCS (${stale.length}):`);
      for (const f of stale) console.error(`  ${f.doc}:${f.line} → ${f.ref} (${f.detail})`);
    }
    if (!quiet || envelope.findings.length > 0) {
      console.error(
        `\nDocCheck: ${envelope.docsChecked} docs, ${envelope.refsChecked} refs, ${missing.length} missing, ${stale.length} stale`,
      );
    }
    if (envelope.findings.length === 0 && !quiet) {
      console.error("✅ All references valid and fresh.");
    }
  }

  return docExitCode(envelope);
}

if (import.meta.main) {
  process.exit(main());
}
