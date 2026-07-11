/**
 * ref-check.ts — the ONE path-reference engine behind DocCheck and ReferenceCheck (Story 12.3).
 *
 * `ReferenceCheck.ts` was already a documented "Superset of DocCheck.ts", and their section-root
 * matcher was byte-identical. This collapses the two hand-kept copies onto a single parameterized
 * engine: `runRefCheck(config)` does the ref-extraction → resolution → existence/freshness →
 * classification loop, and every PAI-specific value — the roots, the ref patterns, the file source, the
 * exclusion lists, the resolution ladder, the output shape, the exit policy — is INJECTED by the caller
 * (D4). The two thin entrypoints `doc-check.ts` (curated-doc scope) and `reference-check.ts` (full-tree
 * scope) are just two configs over this engine.
 *
 * Substrate it rides (Story 12.3 promotions + the AD-9 plumbing edges):
 *   - `std/core`   sectionRoots / sectionRootAt  (the byte-identical section-root matcher, now in core)
 *   - `std/fsx`    exists / statMtime / readIfExists / walkFiles(+prune)  (the fs-resolution primitives)
 *   - `std/git`    git()  (the fail-soft git-dirty read — ~/.claude is not a git repo, so it degrades)
 *
 * INJECTED, never baked (this file is identity-free apart from what the config carries): CLAUDE_DIR /
 * PAI_DIR, the top-level anchor union, every exclusion list, the curated doc set, the output envelopes,
 * and the exit policy all live in the entrypoint configs, not here. `proof/` is a legitimate home for
 * that estate identity (the `check-no-consumer-ids` gate scopes to `src/**`).
 *
 * SEMANTIC-PARITY invariants preserved verbatim (Story 12.3 AC5): per-occurrence dedup keyed on
 * `raw@index` (never `raw` alone — the same path under a different `## … (paths under X)` heading
 * resolves against a different root); `.md`-only fence-skip; `.ts`-only import-narrowing; resolution
 * order + fallbacks (owned by each config's `resolveRef`); the noise filters; and the freshness rule.
 */

import { dirname, relative, resolve } from "node:path";
import { sectionRootAt, sectionRoots } from "std/core";
import { readIfExists, statMtime } from "std/fsx";
import { git } from "std/git";

/** A resolved reference occurrence pulled out of one referring file. */
export interface RefHit {
  raw: string;
  label: string;
  line: number;
  referringFile: string;
  resolved: string;
  exists: boolean;
}

/** A classified finding in the engine's canonical (superset) shape; each entrypoint maps it to its own envelope. */
export interface RefFinding {
  type: "missing" | "stale" | "orphan";
  /** Path of the referring file, relative to `claudeDir`. */
  file: string;
  line: number | null;
  ref: string | null;
  resolved: string;
  detail?: string;
  label?: string;
}

/** The engine's raw result. Entrypoints add `elapsedMs`/`summary`/envelope on top. */
export interface RefCheckResult {
  scannedFiles: number;
  scannedRefs: number;
  findings: RefFinding[];
}

/**
 * Everything the engine needs, injected by the caller. The behavior toggles (`fenceSkip`, `tsNarrow`,
 * `sectionAware`, `noiseFilters`, `staleMinDays`) are exactly the documented divergences between the two
 * originals — DocCheck's narrower extraction vs ReferenceCheck's superset — expressed as data so ONE
 * engine reproduces both byte-for-byte.
 */
export interface RefCheckConfig {
  /** ~/.claude — findings are reported relative to this, and git-dirty runs `-C` here. Injected (D4). */
  claudeDir: string;
  /** The ref patterns to run (labelled). DocCheck's PATH_PATTERNS subset or ReferenceCheck's REF_PATTERNS superset. */
  patterns: Array<{ re: RegExp; label: string }>;
  /** Produce the absolute file paths to scan (curated `findDocs()` set, or a pruned full-tree `walkFiles`). */
  fileSource: () => string[];
  /** The per-mode resolution ladder: resolve `raw` (given the referrer dir + active section root) to `{ resolved, exists }`. */
  resolveRef: (raw: string, refDir: string, sectionRoot: string) => { resolved: string; exists: boolean };
  /** `.md` fenced-code refs are illustrative — skip them (ReferenceCheck: true; DocCheck: false). */
  fenceSkip: boolean;
  /** For `.ts`/`.tsx` referrers, extract ONLY `ts-import` (`from "…"`) patterns (ReferenceCheck: true; DocCheck: false). */
  tsNarrow: boolean;
  /** `"always"` computes section roots for every file (DocCheck); `"md-only"` only for `.md` (ReferenceCheck). */
  sectionAware: "always" | "md-only";
  /** `true` runs ReferenceCheck's full noise-filter set; `false` runs DocCheck's `vX.Y.Z`-only skip. */
  noiseFilters: boolean;
  /** Include stale findings (ref mtime > referrer mtime). DocCheck always true; ReferenceCheck = `--stale`. */
  includeStale: boolean;
  /** Minimum whole-days-stale to report. DocCheck reports any newer ref (`0`); ReferenceCheck requires `1`. */
  staleMinDays: number;
  /** Include orphan findings (an existing candidate that nothing references). ReferenceCheck = `--orphans`; DocCheck false. */
  includeOrphans: boolean;
  /** Which files are orphan CANDIDATES, tested on the `claudeDir`-relative path (ReferenceCheck: PAI-top `.md` only). */
  isOrphanCandidate: (relPath: string) => boolean;
  /** `--changed`: only report refs from git-dirty files (or refs whose target changed). */
  changedOnly: boolean;
}

/**
 * The set of git-dirty files under `claudeDir` (working-tree + staged), as absolute paths. Uses the
 * fail-soft `git()` edge: a non-repo `~/.claude` (the documented reality) yields `""` for both diffs →
 * the empty set → `--changed` reports nothing, exactly as the original `execSync`+`try/catch` did.
 */
function getChangedFiles(claudeDir: string): Set<string> {
  const lines = [
    ...git(claudeDir, ["diff", "--name-only", "HEAD"]).split("\n"),
    ...git(claudeDir, ["diff", "--cached", "--name-only"]).split("\n"),
  ];
  const out = new Set<string>();
  for (const f of lines) {
    const t = f.trim();
    if (t) out.add(resolve(claudeDir, t));
  }
  return out;
}

/**
 * Build a bitmap of char positions inside a ```fenced``` block. Refs there are illustrative (sample
 * layouts / output), not live references. Verbatim from ReferenceCheck.ts:331-347.
 */
function fenceMap(content: string): Uint8Array {
  const inFence = new Uint8Array(content.length);
  const lines = content.split("\n");
  let inside = false;
  let pos = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      inside = !inside;
    } else if (inside) {
      for (let i = 0; i < line.length; i++) inFence[pos + i] = 1;
    }
    pos += line.length + 1; // +1 for \n
  }
  return inFence;
}

/** Extract every (deduped, filtered, resolved) reference from one file's content. */
function extractRefs(content: string, referringFile: string, config: RefCheckConfig): RefHit[] {
  const refs: RefHit[] = [];
  const seen = new Set<string>();
  const refDir = dirname(referringFile);

  const isMd = referringFile.endsWith(".md");
  const isTs = referringFile.endsWith(".ts") || referringFile.endsWith(".tsx");

  // Fence-skip only for `.md`, and only when the config asks (ReferenceCheck yes, DocCheck no).
  const fences = config.fenceSkip && isMd ? fenceMap(content) : null;
  // Section-aware resolution: "always" (DocCheck) computes for every file; "md-only" (ReferenceCheck) only `.md`.
  const roots = config.sectionAware === "always" || isMd ? sectionRoots(content) : null;

  for (const { re, label } of config.patterns) {
    // TS-narrowing: `.ts`/`.tsx` referrers keep only `ts-import` — skip backtick/table/arrow patterns
    // that would hit regex/test-fixture string literals. (ReferenceCheck.ts:363-366.)
    if (config.tsNarrow && isTs && label !== "ts-import") continue;

    const regex = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
      const raw = m[1];
      if (!raw) continue;

      // Noise filters — the one place DocCheck and ReferenceCheck diverge on WHICH raws survive.
      if (config.noiseFilters) {
        // ReferenceCheck.ts:374-386 (its `vX.Y.Z` skip lives in this block).
        if (raw.startsWith("http") || raw.startsWith("mailto:") || raw.startsWith("#")) continue;
        if (raw.startsWith("/tmp/") || raw.startsWith("/var/") || raw.startsWith("/etc/") || raw.startsWith("/bin/")) continue;
        if (raw.includes("<") || raw.includes(">") || raw.includes("$SkillName")) continue;
        if (raw.includes("YYYY") || raw.includes("MM-DD") || raw.includes("vX.Y.Z") || raw.includes("{slug}")) continue;
        if (raw.includes("your-da")) continue;
        if (raw.includes("SKILLCUSTOMIZATIONS/")) continue;
        if (raw.length < 3 || raw.length > 200) continue;
      } else {
        // DocCheck.ts:113 — only the placeholder skip.
        if (raw.includes("vX.Y.Z")) continue;
      }

      // Skip refs inside ``` code fences (usually examples, not live refs).
      if (fences && fences[m.index] === 1) continue;

      // Per-occurrence dedup: key on raw + position, NEVER raw alone (AC5). Same `raw` under a different
      // section heading resolves against a different root, so a later broken occurrence must not be lost.
      const key = `${raw} ${m.index}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const sectionRoot = roots ? sectionRootAt(roots, m.index) : "";
      const { resolved, exists } = config.resolveRef(raw, refDir, sectionRoot);

      const line = content.substring(0, m.index).split("\n").length;
      refs.push({ raw, label, line, referringFile, resolved, exists });
    }
  }
  return refs;
}

/**
 * Run the unified reference check under `config`. Two passes (ReferenceCheck's superset model): pass 1
 * extracts refs from every source file and records which targets are referenced; pass 2 classifies
 * missing / stale (and, when asked, orphans). Deterministic given the filesystem — the entrypoint stamps
 * `elapsedMs` around this call so the engine itself stays test-friendly.
 */
export function runRefCheck(config: RefCheckConfig): RefCheckResult {
  const files = config.fileSource();
  const changed = config.changedOnly ? getChangedFiles(config.claudeDir) : null;

  // Pass 1 — extract every ref; remember what is referenced (for orphans).
  const fileRefs = new Map<string, RefHit[]>();
  const referenced = new Set<string>();
  let scannedFiles = 0;
  let scannedRefs = 0;

  for (const file of files) {
    const content = readIfExists(file);
    if (content === null) continue; // unreadable/absent → skip (was try/catch continue)
    scannedFiles++;
    const refs = extractRefs(content, file, config);
    if (refs.length > 0) fileRefs.set(file, refs);
    for (const r of refs) {
      scannedRefs++;
      if (r.exists) referenced.add(r.resolved);
    }
  }

  // --changed: keep only refs from changed files OR refs whose target changed.
  const filesToReport = changed
    ? new Set(
        [...fileRefs.keys()].filter((f) => {
          if (changed.has(f)) return true;
          return (fileRefs.get(f) || []).some((r) => changed.has(r.resolved));
        }),
      )
    : null;

  // Pass 2 — classify.
  const findings: RefFinding[] = [];
  for (const [file, refs] of fileRefs) {
    if (filesToReport && !filesToReport.has(file)) continue;
    const relFile = relative(config.claudeDir, file);
    let fileMtime: number | null = null; // lazy — only stale needs it

    for (const r of refs) {
      if (!r.exists) {
        findings.push({ type: "missing", file: relFile, line: r.line, ref: r.raw, resolved: r.resolved, label: r.label });
        continue;
      }
      if (config.includeStale) {
        if (fileMtime === null) fileMtime = statMtime(file);
        const targetMtime = statMtime(r.resolved);
        // statMtime is fail-soft (0 on unstatable) → `0 > mtime` is false → freshness silently skipped,
        // exactly the original try/catch-around-statSync behavior.
        if (targetMtime > fileMtime) {
          const daysStale = Math.round((targetMtime - fileMtime) / (1000 * 60 * 60 * 24));
          if (daysStale >= config.staleMinDays) {
            findings.push({
              type: "stale",
              file: relFile,
              line: r.line,
              ref: r.raw,
              resolved: r.resolved,
              detail: `ref modified ${daysStale}d after doc`,
              label: r.label,
            });
          }
        }
      }
    }
  }

  // Orphans — narrow to the caller's candidate set (ReferenceCheck: PAI-top `.md` only).
  if (config.includeOrphans) {
    for (const file of files) {
      const rel = relative(config.claudeDir, file);
      if (!config.isOrphanCandidate(rel)) continue;
      if (!referenced.has(file)) {
        findings.push({ type: "orphan", file: rel, line: null, ref: null, resolved: file });
      }
    }
  }

  // Dedup (type, file, line, ref) — a no-op within a single file's per-occurrence extraction, kept as
  // ReferenceCheck's end-of-run safety net.
  const key = (f: RefFinding) => `${f.type}|${f.file}|${f.line}|${f.ref}`;
  const uniq = new Map<string, RefFinding>();
  for (const f of findings) if (!uniq.has(key(f))) uniq.set(key(f), f);

  return { scannedFiles, scannedRefs, findings: [...uniq.values()] };
}
