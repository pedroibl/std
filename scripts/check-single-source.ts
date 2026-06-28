// Enforcement harness — NFR4 / SM1: std/core is the SINGLE source of the shared vocabulary.
//
// `cite`, the severity vocabulary, `Stat`/`stat`, and `Counts`/`counts` must be *defined* in exactly
// one place — `src/core/**`. Every other slice (and every consumer) IMPORTS them. This gate fails the
// build if any of those symbols is *re-declared* anywhere outside `src/core/**` within std, and — when
// an external consumer registry is supplied at runtime — inside a non-mirror consumer tree too.
//
// "Definition" = a declaration that ORIGINATES the symbol at module top level
// (`export? const|let|var|function|class <name>`, `export? type|interface <Name>`). It is NOT:
//   - an import (`import { cite } from "std/core"` is the correct, required pattern → must pass),
//   - a re-export edge (`export { cite } from "./cite"` → an edge, not a definition),
//   - a mention in a comment or string literal,
//   - a nested local binding (e.g. `const counts = new Map()` inside a function — only top-level,
//     column-0 declarations are vocabulary; nested locals are private and can't be imported).
//
// This is TOOLING (scripts/, not src/) — it may use Bun/node APIs freely. The pure analyzers
// (`scanDefinitions`, `resolveConsumers`, `scanConsumerTrees`) are unit-tested beside this file.
//
// SCOPE FENCE: this is ONLY the single-source vocab gate (NFR4/SM1) plus the consumer-set read. The
// no-consumer-identifiers scan is Story 1.5 (NFR3 assertion 2) — std bakes in NO consumer identity;
// the consumer set comes from the external `STD_CONSUMERS` registry, never a hardcoded path.

import { existsSync, readFileSync } from "node:fs";

import { stripStringsAndComments, lineOf } from "./lib/specifiers";

// The shared-vocabulary symbols whose single source MUST be src/core/** (FR4/AD-2/SM1). Both the
// value form (`cite`/`severity`/`stat`/`counts`) and the type/record form (`Severity`/`Stat`/`Counts`)
// are tracked. `statusLine` is the renderer, not the record — deliberately NOT tracked.
const TRACKED = new Set(["cite", "Severity", "severity", "Stat", "stat", "Counts", "counts"]);

export type Hit = { symbol: string; line: number; detail: string };

// Top-level declarations only (anchored at line start, allowing `export`/`export default`). The
// line-start anchor is what excludes indented/nested locals like `  const counts = new Map()`.
const DECL_VALUE = /^(?:export\s+)?(?:default\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm;
const DECL_TYPE = /^(?:export\s+)?(?:default\s+)?(?:type|interface)\s+([A-Za-z0-9_$]+)/gm;

/** Pure: flag every top-level *definition* of a tracked vocabulary symbol in a source file's text. */
export function scanDefinitions(src: string): Hit[] {
  const out: Hit[] = [];
  const clean = stripStringsAndComments(src);
  for (const re of [DECL_VALUE, DECL_TYPE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) {
      const symbol = m[1]!;
      if (TRACKED.has(symbol)) {
        out.push({ symbol, line: lineOf(clean, m.index), detail: m[0]!.trim() });
      }
    }
  }
  return out;
}

export type Consumer = { path: string; mirror: boolean };

/**
 * Parse one registry entry/line into a consumer, or null for a blank/comment-only line. A `#mirror`
 * (env, no space) or `# mirror` (local file, with space) tag marks a by-design hand-mirror to skip.
 */
function parseConsumerEntry(raw: string): Consumer | null {
  const hash = raw.indexOf("#");
  const path = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
  if (!path) return null; // blank line or pure `# comment`
  const tag = hash >= 0 ? raw.slice(hash + 1).trim() : "";
  return { path, mirror: tag === "mirror" };
}

/**
 * Pure: resolve the consumer set from the EXTERNAL registry — `STD_CONSUMERS` (PATH-style,
 * `:`-separated absolute paths, each may carry a trailing `#mirror`) and/or the gitignored
 * `scripts/std.consumers.local` (one path per line, `#`-comments + `# mirror` honoured). No consumer
 * path is ever baked into std source (D4/NFR3) — absence ⇒ empty list ⇒ SKIP-as-green at the call site.
 */
export function resolveConsumers(
  env: Record<string, string | undefined>,
  readLocal: () => string | null,
): Consumer[] {
  const out: Consumer[] = [];
  const envVar = env.STD_CONSUMERS;
  if (envVar) {
    for (const part of envVar.split(":")) {
      const c = parseConsumerEntry(part);
      if (c) out.push(c);
    }
  }
  const local = readLocal();
  if (local) {
    for (const line of local.split("\n")) {
      const c = parseConsumerEntry(line);
      if (c) out.push(c);
    }
  }
  return out;
}

/**
 * Pure: scan each NON-mirror consumer tree for duplicate vocabulary definitions. `listFiles`/`readFile`
 * are injected so this stays pure and testable; `main()` supplies Bun.Glob/Bun.file. Mirror consumers
 * (the deliberate zsh hand-mirror across the runtime wall) are skipped entirely (AC3).
 */
export function scanConsumerTrees(
  consumers: Consumer[],
  listFiles: (dir: string) => string[],
  readFile: (file: string) => string,
): Array<{ file: string; hit: Hit }> {
  const out: Array<{ file: string; hit: Hit }> = [];
  for (const consumer of consumers) {
    if (consumer.mirror) continue;
    for (const file of listFiles(consumer.path)) {
      for (const hit of scanDefinitions(readFile(file))) out.push({ file, hit });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const findings: Array<{ file: string; hit: Hit }> = [];

  // Within-std scan (always): every src/**/*.ts that is neither in core nor a test.
  const glob = new Bun.Glob("src/**/*.ts");
  for await (const file of glob.scan(".")) {
    if (file.startsWith("src/core/")) continue; // core IS the single source — allowed
    if (file.endsWith(".test.ts")) continue;
    const src = await Bun.file(file).text();
    for (const hit of scanDefinitions(src)) findings.push({ file, hit });
  }

  // Consumer scan (conditional, opt-in via the external registry).
  const localPath = "scripts/std.consumers.local";
  const consumers = resolveConsumers(process.env, () =>
    existsSync(localPath) ? readFileSync(localPath, "utf8") : null,
  );
  if (consumers.length === 0) {
    console.log("↩ consumer scan skipped (STD_CONSUMERS unset)");
  } else {
    const listFiles = (dir: string): string[] => {
      const out: string[] = [];
      const g = new Bun.Glob("**/*.ts");
      for (const rel of g.scanSync({ cwd: dir })) {
        if (rel.includes("node_modules/") || rel.endsWith(".test.ts")) continue;
        out.push(`${dir.replace(/\/$/, "")}/${rel}`);
      }
      return out;
    };
    const readFile = (file: string): string => readFileSync(file, "utf8");
    for (const f of scanConsumerTrees(consumers, listFiles, readFile)) findings.push(f);
  }

  if (findings.length > 0) {
    console.error("✗ single-source vocabulary violations (NFR4/SM1):");
    for (const { file, hit } of findings) {
      console.error(`  ${file}:${hit.line}  ${hit.symbol}: ${hit.detail}`);
    }
    console.error(`\n${findings.length} duplicate definition(s) — core must be the only source.`);
    process.exit(1);
  }

  console.log("✓ core is the single source of the shared vocabulary — no duplicate definitions (NFR4/SM1)");
}

if (import.meta.main) await main();
