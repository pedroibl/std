// The shared `bmad-manager` run options — the flag framework every `std bmad <sub>` command parses
// through (Story 2.2, FR-5/AC2). ONE parser, ONE record: `install`/`update`/`deploy` (2.3/2.5/2.7) and
// `verify` (2.6) all call `parseBmadOpts`, so the dry-run default and the `--apply`/`--push` separation
// can never drift between subcommands.
//
// THE SAFETY CONTRACT (FR-5/BM-6, and the whole reason this module is separate from the effect layer):
//   - `apply` defaults FALSE. Absent `--apply`, every command is a dry run that mutates nothing.
//   - `push` is derived from `--push` ALONE. It is never set as a side effect of `--apply`. SM-6 calls a
//     mutation without `--apply` a regression; an implied push is the same class of fault one step out.
// Both are plain reads of the argv, deliberately with no cleverness between them — there is no code path
// here that could couple the two flags.
//
// WHY THIS IS ITS OWN MODULE (deviation from the Story-2.2 text, which placed `BmadOpts`/`parseBmadOpts`
// in `cli.ts`): `cli.ts` holds the `runBmad` router, which value-imports `runBmadInstall|Update|Deploy`
// from `install.ts`/`update.ts`/`deploy.ts` — and each of those must parse its own argv. Keeping the
// parser in `cli.ts` therefore forms a REAL import cycle (`cli.ts ⇄ install.ts`), which the live
// `check:dep-root` gate rejects (its graph includes type-only edges by design: "a type-only re-export
// still forms a cycle and is deliberately included"). Splitting the parser out of the router makes the
// slice a DAG: `opts → deps → pipeline → batch → {install,update,deploy} → cli → src/cli/main`. `cli.ts`
// re-exports both names so the story's declared surface still holds; NEW code should import from here.
//
// D1 core purity: this is a Bun-edge slice; nothing here belongs in `src/core` (no second caller).
// D4 identity-free: no repo, path, or machine literal — only the BM-12 loop-family SKILL names, which
// are the product's own vocabulary, not a consumer's identity.

import { flagValue, hasFlag } from "../core/index";
import { parseSelectors, type SetOption } from "./manifest";

/**
 * The loop-family skills a `bmad-manager` run installs when `--skills` is absent (BM-12). Exported so
 * the parser, the tests, and the 2.3 install leg share ONE source for the pair rather than three copies.
 * `--skills` is ADDITIVE onto this default (see {@link parseBmadOpts}), never a replacement.
 */
export const DEFAULT_SKILLS: readonly string[] = [
  "bmad-agent-jhon-the-loop",
  "bmad-agent-epic-the-loop",
];

/**
 * One parsed `std bmad <sub>` invocation. Shared by every command (BM-5/AD-2 — one definition, nobody
 * forks it). `repos`/`tools` absent means "no restriction"; `set` and `skills` are always arrays.
 */
export interface BmadOpts {
  /** `--apply`. FALSE by default — the dry-run gate (BM-6). Nothing mutates unless this is true. */
  apply: boolean;
  /** `--push`. Derived ONLY from `--push`; `--apply` never implies it (FR-5/AC2). */
  push: boolean;
  /** `--force-track`. A manual per-invocation override for a gitignored `.claude` (consumed in 2.4). */
  forceTrack: boolean;
  /** `--repos a,b` — absent ⇒ the whole Manifest minus `source-only` (2.1's `selectRepos`). */
  repos?: string[];
  /** `--tools a,b` — absent ⇒ each repo's own `tools` (2.1's `DEFAULT_TOOLS` when it declared none). */
  tools?: string[];
  /** Repeatable `--set <module>.<key>=<value>`, parsed by 2.1. Shelled onto `bmad install` in 2.3. */
  set: SetOption[];
  /** {@link DEFAULT_SKILLS} plus anything `--skills` added, de-duplicated, in first-seen order. */
  skills: string[];
}

/**
 * Parse a subcommand's argv into {@link BmadOpts} (AC2).
 *
 * The three booleans are independent `hasFlag` reads — in particular `push` does NOT consult `apply`.
 * `repos`/`tools`/`set` come from 2.1's `parseSelectors` (the single selector contract; `--set` is
 * repeatable and fails loud on a malformed token, which the router maps to exit 1).
 *
 * `skills` is parsed HERE, not by `parseSelectors` — 2.1's selector record has no `skills` key (2.1 AC7),
 * and adding one there would have widened a shipped contract for one consumer.
 */
export function parseBmadOpts(argv: string[]): BmadOpts {
  const selectors = parseSelectors(argv);

  const opts: BmadOpts = {
    apply: hasFlag(argv, "apply"),
    // Read from `--push` and nothing else. Do NOT rewrite this as `hasFlag(argv,"push") || apply` or
    // any variant that consults `apply`: that is precisely the FR-5/AC2 regression this line guards.
    push: hasFlag(argv, "push"),
    forceTrack: hasFlag(argv, "force-track"),
    set: selectors.set,
    skills: mergeSkills(flagValue(argv, "skills")),
  };
  // Assigned conditionally rather than as `repos: selectors.repos` so an absent selector stays ABSENT
  // rather than becoming an explicit `undefined` key — `selectRepos` branches on `=== undefined`, and
  // this mirrors how 2.1's own loader builds its optional fields.
  if (selectors.repos) opts.repos = selectors.repos;
  if (selectors.tools) opts.tools = selectors.tools;
  return opts;
}

/**
 * Merge a comma-separated `--skills` value onto {@link DEFAULT_SKILLS}, de-duplicated and order-stable.
 *
 * ADDITIVE by design (BM-12): `--skills dev-the-loop` installs the two defaults PLUS `dev-the-loop`. A
 * replacing semantic would let a single flag silently drop the loop family a run is supposed to carry.
 */
function mergeSkills(value: string | undefined): string[] {
  const extra = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return [...new Set([...DEFAULT_SKILLS, ...extra])];
}
