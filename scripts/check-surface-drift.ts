// Enforcement harness — the command surface knows every flag the code actually reads (Story 3.2 AC8).
//
// `SURFACE` (src/cli/surface.ts) collapses four statements of the std surface into one, but it is still
// HAND-MAINTAINED DATA: it does not derive from the parsers. This gate is the mitigation, not a proof.
// It answers exactly one question: *does any code read a flag the model has never heard of?* A flag
// added to a parser and forgotten in the model would otherwise ship a CLI that accepts an option its
// own `--help` and completion never mention — the D-a failure mode one level down.
//
// 🔴 NAME-LEVEL AND GLOBAL, NEVER PER-SUBCOMMAND. A gate demanding "the flag a subcommand reads must be
// in THAT subcommand's SURFACE entry" would fail the build on correct code, twice over:
//   - `src/bmad/deploy.ts:53` reads `hasFlag(argv, "repos")` IN ORDER TO REFUSE IT (exit 2, spine
//     BM-19). A per-subcommand gate would force `--repos` into deploy's flags — inverting the very
//     contract that story asserts.
//   - `src/cli/edge-deploy.ts:512` reads `"format"` from code shared by cn AND dashkit, while only cn
//     declares `formats`. There is no single subcommand that read belongs to.
// So the assertion is against the UNION of every flag name in the model.
//
// MASKER (load-bearing): comments are masked with `stripComments` — NOT `stripStringsAndComments`. The
// flag names live INSIDE string literals, exactly as in `check-no-consumer-ids.ts`, so string content
// must survive the mask to be scanned. A `hasFlag(argv,"push")` written in a `//` comment is prose and
// is masked away (there is one, at `src/bmad/opts.ts:75`).
//
// TWO LIMITATIONS — the honest ceiling of this gate, not oversights:
//   1. It does NOT catch the inverse: a `SURFACE` entry that no code reads. Nothing here would notice a
//      flag the model offers and the parser ignores.
//   2. It does NOT catch flags read by other mechanisms. `--install` is read as
//      `rest.includes("--install")` (`main.ts`, `repo-nav.ts`) and is invisible to every pattern below.
//      It IS in `SURFACE`; nothing enforces that it stays.
//
// This is TOOLING (scripts/, not src/) — it may use Bun/node APIs freely, and it is the repo's first
// `scripts/ → src/` import. That is correct and invisible to `check:dep-root`, which builds a
// FILE-LEVEL graph over `src/**/*.ts` only: gates are tooling, never library surface.

import { SURFACE, flagNames } from "../src/cli/surface";
import { stripComments, lineOf } from "./lib/specifiers";

export type Read = { name: string; line: number };

/**
 * The three readers, matched on their STRING-LITERAL argument.
 *
 * `collectFlagValues` is the third pattern and it is not optional: it is a PRIVATE function in
 * `src/bmad/manifest.ts`, not a `core/args` export (which exposes only `positional`/`flagValue`/
 * `hasFlag`/`dispatch`/`dispatchAsync`), so a gate matching the first two never sees `--set` at all.
 *
 * Matching the LITERAL rather than "the second argument as text" is also what makes the reader's own
 * DEFINITION line fall out for free: `manifest.ts:311` reads `function collectFlagValues(argv: string[],
 * name: string)`, which matches the pattern by its own name while its second argument is the identifier
 * `name`. A text-scraping gate would report `✗ manifest.ts:311  name` and fail the build on correct code.
 */
const READER = /\b(?:hasFlag|flagValue|collectFlagValues)\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*["']([^"']+)["']\s*\)/g;

/** Pure: every flag name this source READS, with its line. Comments are masked first. */
export function scanFlagReads(src: string): Read[] {
  const clean = stripComments(src);
  const reads: Read[] = [];
  for (const m of clean.matchAll(READER)) {
    reads.push({ name: m[1]!, line: lineOf(clean, m.index) });
  }
  return reads;
}

/** Every flag name the model declares anywhere, without the leading dashes. */
export function surfaceFlagNames(): Set<string> {
  const names = new Set<string>();
  const add = (n: string) => names.add(n.replace(/^--?/, ""));
  for (const f of SURFACE.flags) add(f.name);
  for (const c of SURFACE.commands) {
    for (const n of flagNames(SURFACE, c.name)) add(n);
    for (const sub of c.subcommands) for (const n of flagNames(SURFACE, c.name, sub.name)) add(n);
  }
  return names;
}

/** Pure: the reads in `src` that the model has never heard of. */
export function unknownReads(src: string, known: Set<string> = surfaceFlagNames()): Read[] {
  return scanFlagReads(src).filter((r) => !known.has(r.name));
}

async function main(): Promise<void> {
  const known = surfaceFlagNames();
  const findings: Array<{ file: string; read: Read }> = [];
  let scanned = 0;
  for (const pattern of ["src/bmad/**/*.ts", "src/cli/**/*.ts"]) {
    for await (const file of new Bun.Glob(pattern).scan(".")) {
      if (file.endsWith(".test.ts")) continue; // fixtures plant made-up flags deliberately
      scanned++;
      const src = await Bun.file(file).text();
      for (const read of unknownReads(src, known)) findings.push({ file, read });
    }
  }

  if (findings.length > 0) {
    console.error("✗ surface drift — code reads a flag the command surface does not declare (AC8):");
    for (const { file, read } of findings) console.error(`  ✗ ${file}:${read.line}  ${read.name}`);
    console.error(
      `\n${findings.length} undeclared flag read(s) — add it to SURFACE (src/cli/surface.ts) or stop reading it.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ every flag read across ${scanned} files is declared in the command surface (${known.size} names)`,
  );
}

if (import.meta.main) await main();
