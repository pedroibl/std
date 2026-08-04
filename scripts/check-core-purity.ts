// Enforcement harness — D1 / NFR1 / CM3: `src/core/**` is runtime-neutral.
//
// core is the only slice that crosses the Bun<->Obsidian boundary, so it must import nothing
// runtime-specific: no `node:*` / fs / DOM / network imports, and no reference to `process`
// or `document`. This check is TOOLING (not part of core), so it may use Bun/node APIs freely.
//
// Pure scanner (`scanSource`) is unit-tested beside this file; `main()` globs the pure sources and
// gates CI. The scanned set is `PURE_GLOBS`, and the SCOPE is guarded twice over, because a gate that
// reads nothing passes just as green as one that reads everything: `coversFile` exposes the
// membership decision as a testable predicate, and `scanScope`/`emptyGlobs` fail the gate outright
// when any configured pattern matches zero files on disk.
//
// The import-specifier regexes + comment/string masking live in scripts/lib/specifiers.ts (the
// Rule-of-Three home, extracted at 1.4's third caller) — imported here, no longer re-declared.

import {
  FROM_IMPORT,
  SIDE_EFFECT_IMPORT,
  REQUIRE_CALL,
  DYNAMIC_IMPORT,
  stripStringsAndComments,
  lineOf,
} from "./lib/specifiers";

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "crypto", "dgram", "dns",
  "events", "fs", "http", "http2", "https", "net", "os", "path", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "timers",
  "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
]);

// DOM/network also reach the source as bare globals (no import): `document` (DOM) and
// `fetch`/`XMLHttpRequest`/`WebSocket` (network). With `process`, these are scanned per-line below.
// A pure core may not pull a DOM library by import either.
const FORBIDDEN_BARE = new Set(["jsdom", "happy-dom", "linkedom"]);
const FORBIDDEN_GLOBALS = ["process", "document", "fetch", "XMLHttpRequest", "WebSocket"];

export type Violation = { line: number; kind: string; detail: string };

/** Pure: return every runtime-purity violation in a core source file's text. */
export function scanSource(src: string): Violation[] {
  const out: Violation[] = [];
  const clean = stripStringsAndComments(src);

  const flag = (spec: string, index: number) => {
    const line = lineOf(clean, index);
    if (spec.startsWith("node:")) { out.push({ line, kind: "node-import", detail: spec }); return; }
    // Match on the root segment so builtin subpaths (`fs/promises`, `stream/web`) are caught too.
    const root = spec.split("/")[0]!;
    if (NODE_BUILTINS.has(root)) out.push({ line, kind: "node-builtin-import", detail: spec });
    else if (FORBIDDEN_BARE.has(spec)) out.push({ line, kind: "forbidden-import", detail: spec });
  };

  for (const re of [FROM_IMPORT, SIDE_EFFECT_IMPORT, REQUIRE_CALL, DYNAMIC_IMPORT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) flag(m[1]!, m.index);
  }

  clean.split("\n").forEach((line, i) => {
    for (const g of FORBIDDEN_GLOBALS) {
      // A *bare* global read only: reject member access (`client.fetch`), longer identifiers,
      // and property keys (`{ fetch: … }`) — none of those read the forbidden global, so flagging
      // them would be a false positive in a merge-blocking gate.
      if (new RegExp(`(?<![.\\w$])${g}\\b(?!\\s*:)`).test(line)) {
        out.push({ line: i + 1, kind: "global-ref", detail: g });
      }
    }
  });

  return out;
}

// Every pure source in the estate. `src/core/**` is the shared vocabulary; `src/notekit/core-*.ts`
// is notekit's pure half (Story 1.1) — the `core-` filename prefix IS the fence there, so the
// notekit edge (`src/notekit/edge/**`, which legitimately builds DOM) stays out of scope.
export const PURE_GLOBS = ["src/core/**/*.ts", "src/notekit/core-*.ts"] as const;

// Compiled once and shared by `coversFile` and `main`, so the membership test and the file walk can
// never be driven by two separately-built sets of patterns.
const PURE_MATCHERS = PURE_GLOBS.map((pattern) => new Bun.Glob(pattern));

/**
 * Does the gate actually scan this path? Same decision `main()` makes, exposed so the SCOPE is
 * tested and not just the scanner. Tests are excluded — they are not shipped and may import bun:test.
 */
export function coversFile(file: string): boolean {
  if (file.endsWith(".test.ts")) return false;
  return PURE_MATCHERS.some((glob) => glob.match(file));
}

/** What one `PURE_GLOBS` entry actually found on disk. */
export type GlobScan = { pattern: string; files: string[] };

/**
 * The eligible files each `PURE_GLOBS` entry matches, in `PURE_GLOBS` order. Exported so the
 * NON-VACUITY contract is testable against the real filesystem: `Glob.match` only evaluates a path
 * string, so `coversFile` assertions alone cannot prove a pattern reaches any file that exists.
 */
export async function scanScope(root: string = "."): Promise<GlobScan[]> {
  const scans: GlobScan[] = [];
  for (const [i, glob] of PURE_MATCHERS.entries()) {
    const files: string[] = [];
    for await (const file of glob.scan(root)) if (coversFile(file)) files.push(file);
    scans.push({ pattern: PURE_GLOBS[i]!, files });
  }
  return scans;
}

/**
 * The patterns that matched nothing. A gate whose glob finds zero files passes without reading a
 * line of the slice it claims to cover — the same false-green class as the story's Dev Note ⚠️-1,
 * except reached by a typo instead of a missing pattern. Any non-empty result must FAIL the gate.
 */
export function emptyGlobs(scans: readonly GlobScan[]): string[] {
  return scans.filter((s) => s.files.length === 0).map((s) => s.pattern);
}

async function main(): Promise<void> {
  const scans = await scanScope(".");
  const empty = emptyGlobs(scans);

  const findings: Array<{ file: string; v: Violation }> = [];
  const scanned = new Set<string>();
  for (const { files } of scans) {
    for (const file of files) {
      if (scanned.has(file)) continue;
      scanned.add(file);
      const src = await Bun.file(file).text();
      for (const v of scanSource(src)) findings.push({ file, v });
    }
  }

  if (empty.length > 0) {
    console.error("✗ core purity scope is vacuous (D1/NFR1):");
    for (const pattern of empty) console.error(`  ${pattern}  matched 0 files`);
    console.error(
      `\n${empty.length} glob(s) matched nothing — the gate would pass without reading the slice ` +
        "it claims to cover. Fix PURE_GLOBS (typo? moved tree?) rather than the gate.",
    );
  }

  if (findings.length > 0) {
    console.error("✗ core purity violations (D1/NFR1):");
    for (const { file, v } of findings) console.error(`  ${file}:${v.line}  ${v.kind}: ${v.detail}`);
    console.error(`\n${findings.length} violation(s) — core must be runtime-neutral.`);
  }

  if (empty.length > 0 || findings.length > 0) process.exit(1);

  console.log(
    `✓ core is pure across ${scanned.size} file(s) (${PURE_GLOBS.join(", ")}) — ` +
      "no node:*/fs/DOM/network imports, no process/document refs (D1/NFR1)",
  );
}

if (import.meta.main) await main();
