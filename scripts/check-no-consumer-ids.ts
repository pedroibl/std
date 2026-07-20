// Enforcement harness — NFR3 assertion 2 / D3 / D4: std bakes in NO consumer identity.
//
// std's committed `src/**` source must contain no LITERAL consumer identifier — no owner/repo slug
// naming a non-std repo (the canonical `pedroibl/loom`, any `*/loom`, `*/sesh-harvest`, …), no bare
// known-consumer repo name used as an identity/branch literal (`"loom"`, `"sesh-harvest"`), and no
// absolute/`~`-rooted filesystem path into a consumer tree (`/Users/.../loom`, `~/Dev/loom`). This is
// the standing CI form of 1.4's one-off "std names no consumer" observation; it protects Epic 4, where
// `cli` core lands and AD-1 rule 2 ("cli core has zero literal consumer identifiers") first has surface.
//
// This is TOOLING (scripts/, not src/) — it may use Bun/node APIs freely; only `src/core/**` is held
// to D1 purity. The pure analyzer (`scanConsumerIds`) is unit-tested beside this file.
//
// MASKER (load-bearing, AC3): comments are masked with `stripComments` — NOT `stripStringsAndComments`.
// Consumer identifiers hide INSIDE string literals (`pedroibl/loom` was a hardcoded default), so the
// string content must survive the mask to be scanned; a `pedroibl/loom` in a `//` comment is a benign
// mention and is masked away. The import/specifier regexes + the maskers live in scripts/lib/specifiers.ts
// (the Rule-of-Three home, extracted at 1.4) — reused here, never re-declared.
//
// SCOPE FENCE: this is ONLY the no-consumer-identifiers scan (NFR3 assertion 2 / D3+D4). It is
// COMPLEMENTARY to dep-root (1.3), which catches consumer names as import/dependency EDGES; 1.5 catches
// them in non-import positions (string defaults, branch conditions, path constants). Overlap is
// acceptable and double-safe; 1.5 does NOT re-implement the import-edge/cycle scan.

import { stripComments, lineOf } from "./lib/specifiers";

export type Hit = { identifier: string; line: number; detail: string };

// Known consumers of std. This denylist is legitimate TOOLING (scripts/), exactly as check-dep-root.ts
// names loom/PAI-Tools here — tooling is not shipped library surface, so the D4/NFR3 invariant (about
// src/ / cli core) is not breached. The scan TARGET is src/** and NEVER scripts/, so this denylist can
// never self-flag. A small static set is the simplest green path (AC4); it MAY be enriched at runtime
// from STD_CONSUMERS basenames later (left out here to avoid coupling — flagged as a future option).
// The two Obsidian VAULT consumers were added in Story 7.1 (Epic 7). Its Dev Notes had already flagged
// the hole — "a `zDrafts` literal would NOT trip it today; that is a gap in the gate, not permission" —
// and a cross-LLM review then demonstrated it: a `const DEFAULT_VAULT = "…/note-report"` in
// src/cli/cn-deploy.ts passed this gate untouched. A vault path is consumer identity exactly as a repo
// path is; std takes it as `--vault`, never baked in.
const CONSUMER_NAMES = new Set([
  "loom",
  "sesh-harvest",
  "zsh-planning",
  "zshstd",
  "zDrafts",
  "note-report",
]);

// std's own identity is allowlisted BY CONSTRUCTION: `std`, `pedroibl/std`, `@pedroibl/std`, `std/<slice>`
// share no path/slug segment with the denylist, so a denylist-driven match never flags them.

/** A token char: identifier chars plus the slug/path joiners that bind `pedroibl/loom`, `~/Dev/loom`. */
function isTokenChar(c: string): boolean {
  return (
    (c >= "A" && c <= "Z") ||
    (c >= "a" && c <= "z") ||
    (c >= "0" && c <= "9") ||
    c === "_" ||
    c === "$" ||
    c === "@" ||
    c === "~" ||
    c === "." ||
    c === "-" ||
    c === "/" ||
    c === "\\"
  );
}

/** Classify a flagged token for the CI message. */
function describe(token: string, name: string): string {
  const hasSep = token.includes("/") || token.includes("\\");
  let kind: string;
  if (hasSep && (token.startsWith("/") || token.startsWith("~") || token.startsWith("."))) {
    kind = "filesystem path into consumer tree";
  } else if (hasSep) {
    kind = "owner/repo slug";
  } else {
    kind = "bare consumer name";
  }
  return `${kind} — names consumer "${name}"`;
}

/**
 * Pure: flag every literal consumer identifier in a source file's text. Comments are masked first
 * (`stripComments`), then the comment-free text is tokenised; a token whose `/`-or-`\`-separated
 * segments contain a known consumer name is a baked consumer identifier. The match is SEGMENT-AWARE
 * (mirrors dep-root's `isLoom` `.split(/[\\/]/).includes(...)`): `bloomfilter`/`heirloom`/`loomis` are
 * a single segment ≠ "loom", so they never match; std's own identity shares no segment with the denylist.
 */
export function scanConsumerIds(src: string, names: Set<string> = CONSUMER_NAMES): Hit[] {
  const clean = stripComments(src);
  const hits: Hit[] = [];
  const n = clean.length;
  let i = 0;
  while (i < n) {
    if (!isTokenChar(clean[i]!)) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && isTokenChar(clean[i]!)) i++;
    const token = clean.slice(start, i);
    const name = token.split(/[\\/]/).find((seg) => names.has(seg));
    if (name) hits.push({ identifier: token, line: lineOf(clean, start), detail: describe(token, name) });
  }
  return hits;
}

async function main(): Promise<void> {
  const glob = new Bun.Glob("src/**/*.ts");
  const findings: Array<{ file: string; hit: Hit }> = [];
  for await (const file of glob.scan(".")) {
    if (file.endsWith(".test.ts")) continue; // fixtures plant identifiers deliberately (sibling-gate parity)
    const src = await Bun.file(file).text();
    for (const hit of scanConsumerIds(src)) findings.push({ file, hit });
  }

  if (findings.length > 0) {
    console.error("✗ consumer-identifier violations (NFR3 assertion 2 / D3 / D4):");
    for (const { file, hit } of findings) {
      console.error(`  ${file}:${hit.line}  ${hit.identifier}: ${hit.detail}`);
    }
    console.error(
      `\n${findings.length} consumer identifier(s) — std src must bake in no consumer identity.`,
    );
    process.exit(1);
  }

  console.log("✓ std src bakes in no consumer identity — no literal consumer identifiers (NFR3/D3/D4)");
}

if (import.meta.main) await main();
