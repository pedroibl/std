// The `std` command surface, stated ONCE as data (Story 3.1; design note §4, D-1).
//
// Before this module the surface was stated three times and checked zero times: `HELP` in `main.ts`,
// `BMAD_USAGE` in `bmad/cli.ts`, and the dispatch maps that actually route — each guarded by a comment
// asking the next dev to keep them in sync. `cn`, `dashkit` and `bmad` all registered without the
// completion generator noticing (it is still passed `commands: ["alias"]`). A hand-written completer
// would have made it four. This file is the one statement the other renderings derive from.
//
// PURE AND IDENTITY-FREE (D1/D4/NFR3): serializable data plus total functions over it. No filesystem, no
// env, no DOM, no network, and no module-scope validation call — the round-trip and shape checks are
// invoked by `surface.test.ts`, never at import. The only two strings that look like machine paths
// (`~/.config/std/repos.ts`, `$XDG_CONFIG_HOME/std/estate.toml`) are std's OWN config home, which is
// what the usage text has always printed.
//
// ⚠ AC8's purity grep does NOT mask comments — keep the banned tokens out of the prose here too.
//
// `--format`'s enum is READ from `CN_SPEC`, never restated (design note §2 correction 4): dashkit has no
// `formats`, so the engine does not parse `--format` for it, and the model must not offer one.

import { CN_SPEC } from "./cn-deploy";

/** `bool` takes no value (`--watch`); `value` takes one (`--vault <dir>`). */
export type FlagArity = "bool" | "value";

/** The SEMANTIC shape of a value, for a completer. Orthogonal to `metavar`, which is display-only. */
export type FlagValueKind = "path" | "list" | "enum";

/**
 * Where a `value: 'list'` flag's values come from AT COMPLETION TIME.
 *
 * The estate list is the machine owner's identity, not std's — it lives at
 * `$XDG_CONFIG_HOME/std/estate.toml` precisely so publishing this package never ships a consumer's
 * filesystem. So the model names a SOURCE and the completer emits a reader keyed on it; std never
 * emits the values themselves (D4/NFR3).
 */
export type FlagValueSource = "estate.repos" | "estate.tools";

export interface FlagSpec {
  readonly name: string;
  readonly arity: FlagArity;
  /** Display string in the usage row (`<dir>`, `a,b`, `m.k=v`). Never parsed — see `value`. */
  readonly metavar?: string;
  readonly value?: FlagValueKind;
  /** See {@link FlagValueSource}. Orthogonal to `value`: `--repos` IS a comma list AND its items come
   *  from the estate, and collapsing the two facts into one field would make 3.2's `'list'` tail rule
   *  branch twice on the same key. */
  readonly source?: FlagValueSource;
  /** Values this flag always offers regardless of the caller's estate — std's own vocabulary, not the
   *  caller's. Unioned with whatever the reader finds. */
  readonly defaults?: readonly string[];
  readonly enum?: readonly string[];
  readonly repeatable?: boolean;
  readonly short?: string;
  /** The `BMAD_USAGE` heading this flag renders under (`safety flags` / `selectors` / `output`). */
  readonly group?: string;
  readonly desc: string;
}

export interface SubcommandSpec {
  readonly name: string;
  /** Canonical description — non-empty for every subcommand. A help group with no `desc` inherits it. */
  readonly desc: string;
  readonly flags: readonly FlagSpec[];
}

/**
 * One row of `HELP`'s `commands:` block. The row labels are NOT command names (`alias --install`,
 * `bmad install|update|deploy`), so they are modelled rather than derived from `name` alone.
 *
 * `desc` is OPTIONAL, and the omission is where the sub's own `desc` shows through: a group that wraps
 * exactly one sub renders that sub's text. A group with several subs — or with `flags` instead of subs —
 * has nothing to inherit and must state its own. `bmad verify` states one even though it is 1:1, because
 * `HELP` and `BMAD_USAGE` genuinely ship two different strings for it; making the field optional records
 * that divergence in the data instead of hiding it behind an exemption list.
 */
export interface HelpGroup {
  readonly subs?: readonly string[];
  readonly flags?: readonly string[];
  readonly desc?: string;
}

export interface CommandSpec {
  readonly name: string;
  /**
   * Command-level description. `HELP` renders none — its `commands:` block is keyed by help GROUP, not
   * by command — so 3.1 shipped no such field and the completer (3.2) is its first consumer: the
   * top-level `_describe` needs one line per command. REQUIRED, so a fifth command cannot land without
   * one and complete as a bare name.
   *
   * ⚠ These four strings are scanned by `check:no-consumer-ids`, which globs `src/**` and skips only
   * `*.test.ts`. Naming a vault here (two of the six denylisted names are vaults) is a RED BUILD, not a
   * style question. Describe what the command does to a vault, never which vault.
   */
  readonly desc: string;
  readonly subcommands: readonly SubcommandSpec[];
  /** Command-level flags for a command with no subcommands (`alias --install`). */
  readonly flags?: readonly FlagSpec[];
  readonly helpGroups: readonly HelpGroup[];
}

export interface CommandSurface {
  readonly commands: readonly CommandSpec[];
  /** Root-level flags — `-h, --help`. */
  readonly flags: readonly FlagSpec[];
}

// ── the bmad family's eight flags, authored ONCE ──────────────────────────────────────────────────
// `BMAD_USAGE` documents them flat while the model states them per-subcommand (AC6 demands that), so the
// usage block is a union over the four subs. Composing each sub's array from these shared references is
// what makes identical descriptions true by construction rather than by discipline — and therefore what
// makes the union order-independent rather than dependent on which sub happens to be visited first.

const APPLY = {
  name: "--apply",
  arity: "bool",
  group: "safety flags",
  desc: "actually execute the plan. WITHOUT IT NOTHING MUTATES (dry-run is the default)",
} as const;

const PUSH = {
  name: "--push",
  arity: "bool",
  group: "safety flags",
  desc: "push after committing. Separate from --apply and never implied by it",
} as const;

const FORCE_TRACK = {
  name: "--force-track",
  arity: "bool",
  group: "safety flags",
  desc: "stage a repo whose .claude is gitignored (manual, never routine)",
} as const;

// `--repos` and `--tools` are the only two selectors with an enumerable value space, which is why they
// are the only two carrying a `source`. `--skills` is NOT one: its vocabulary is the estate MODULE's
// `skills/` directory, resolved from the installed package rather than from the caller's estate file, and
// each skill has two accepted spellings (the `bmad-agent-` shorthand). `--set` (`m.k=v`) has no
// enumerable source anywhere in the repo. Both keep the empty action 3.2 emits, asserted as an absence.
const REPOS = {
  name: "--repos",
  arity: "value",
  metavar: "a,b",
  value: "list",
  source: "estate.repos",
  group: "selectors",
  desc: "only these repos (by name; default is the Manifest minus source-only entries)",
} as const;

// `defaults` RESTATES `src/bmad/manifest.ts`'s `DEFAULT_TOOLS` — the effective tool set of every estate
// entry that omits `tools`, i.e. the common case, without which an estate where nobody declares `tools`
// completes nothing here. It is restated rather than imported because `manifest.ts` pulls `node:os` +
// `node:path` + `src/fsx`, and this module is fs-free and env-free by contract. `surface.test.ts` holds
// the two in parity — a test file may import anything.
const TOOLS = {
  name: "--tools",
  arity: "value",
  metavar: "a,b",
  value: "list",
  source: "estate.tools",
  defaults: ["claude-code", "antigravity-cli"],
  group: "selectors",
  desc: "only these tools",
} as const;

const SET = {
  name: "--set",
  arity: "value",
  metavar: "m.k=v",
  repeatable: true,
  group: "selectors",
  desc: "repeatable module setting, passed through to bmad",
} as const;

const SKILLS = {
  name: "--skills",
  arity: "value",
  metavar: "a,b",
  value: "list",
  group: "selectors",
  desc: "additional skills, ADDED to the loop-family default",
} as const;

const JSON_FLAG = {
  name: "--json",
  arity: "bool",
  group: "output",
  desc: "emit the machine-readable ledger; it is then the only thing on stdout",
} as const;

// ---------------------------------------------------------------------------------------------
// THE EDGE-FAMILY `--vault`, STATED ONCE PER MEANING.
//
// Every Obsidian edge takes a `--vault`, and it means two different things: for `deploy` it is the
// WRITE target, for `verify` it is the READ target. So there are two consts, not one — collapsing them
// would be the opposite error, a single description that fits neither command.
//
// Within each meaning the declaration was byte-identical across cn, dashkit and (at 1.4) notekit, and
// this file already keeps the `bmad` family's shared flags as consts for exactly this reason. Three
// copies of one string is three places for the shipped help to drift; one const is none.
//
// ⚠ THE EXTRACTION IS PROVABLY INERT, and that is the only reason it belongs in a review follow-up:
// `FROZEN_HELP` in `main.test.ts` is a byte-identity oracle over the rendered help, so if hoisting had
// changed one character of shipped text that test goes red. `--watch` is deliberately NOT hoisted —
// its description names each command's own watch directories, so the three are not the same string.
// ---------------------------------------------------------------------------------------------
const DEPLOY_VAULT = {
  name: "--vault",
  arity: "value",
  metavar: "<dir>",
  value: "path",
  desc: "the Obsidian vault to deploy into (required — std bakes in no vault path)",
} as const;

// The notekit READ-surface flags (Story 2.1). Stated as consts beside the `--vault` pair for the same
// reason: `--config` is declared by two subcommands, and one const is one place for the shipped help
// to say it. `check:surface-drift` matches on flag NAME, and `config`/`at`/`spec` are the three names
// genuinely new to its global union — `json` is already in it via JSON_FLAG.
const NOTEKIT_CONFIG = {
  name: "--config",
  arity: "value",
  metavar: "<path>",
  value: "path",
  desc: "the caller-local note-type registry to read (required — std bakes in no registry)",
} as const;

const NOTEKIT_AT = {
  name: "--at",
  arity: "value",
  metavar: "<iso>",
  desc: "stamp the card with this timestamp instead of the clock, making the output byte-reproducible",
} as const;

const NOTEKIT_SPEC_STDIN = {
  name: "--spec",
  arity: "value",
  metavar: "-",
  desc: "read the candidate RenderSpec from stdin; `-` is the only accepted value",
} as const;

const VERIFY_VAULT = {
  name: "--vault",
  arity: "value",
  metavar: "<dir>",
  value: "path",
  desc: "the Obsidian vault to check (required)\ndrift is reported and never fatal; a missing foundation exits 1",
} as const;

/**
 * The whole `std` surface.
 *
 * 🔴 `as const satisfies CommandSurface`, NEVER `: CommandSurface`. A wide annotation widens every `name`
 * to `string`, and then `Extract<…, { name: "bmad" }>` — the derivation {@link BmadSub} is built on —
 * resolves to `never`. `Record<never, …>` accepts a handler map with missing AND extra keys, so
 * `bmad/cli.ts`'s typed map goes silently vacuous: deleting `verify` from it would compile clean. The
 * `satisfies` form still checks the data against `CommandSurface`, so nothing is given up.
 *
 * The flag matrix below was re-verified empirically, not copied from the usage prose: `deploy` REFUSES
 * `--repos` (three guards at `deploy.ts:51-59`, exit 2 — the BM-1 usage code, not 1), and `verify` reads
 * only `{repos, skills}` (`verify.ts:45-50`) plus a render-only `--json` (`verify.ts:147`). ⚠ `cli.ts`
 * calls `parseBmadOpts` for `verify` too, so `--apply` is literally PARSED on a verify run and then never
 * read — the model records the ACCEPTED set, not the parsed set.
 */
export const SURFACE = {
  commands: [
    {
      name: "alias",
      desc: "(re)generate repo-nav + the _std completion from ~/.config/std/repos.ts",
      subcommands: [],
      flags: [
        {
          name: "--install",
          arity: "bool",
          desc: "(re)generate repo-nav + the _std completion from ~/.config/std/repos.ts",
        },
      ],
      helpGroups: [
        {
          flags: ["--install"],
          desc: "(re)generate repo-nav + the _std completion from ~/.config/std/repos.ts",
        },
      ],
    },
    {
      name: "cn",
      desc: "bundle and verify the cn Obsidian edge",
      subcommands: [
        {
          name: "deploy",
          desc: "bundle src/cn -> <vault>/Scripts/cn.js (one-way; the vault is build output only)",
          flags: [
            DEPLOY_VAULT,
            {
              name: "--format",
              arity: "value",
              metavar: "<fmt>",
              value: "enum",
              // Read from cn's own EdgeSpec — the engine's parser reads the same array, so the model
              // cannot offer a format the build would reject.
              enum: CN_SPEC.formats!,
              desc: "bundle format: esm (default) or cjs",
            },
            {
              name: "--watch",
              arity: "bool",
              desc: "deploy once, then stay resident and redeploy on every save under src/cn, src/core",
            },
          ],
        },
        {
          name: "verify",
          desc: "check a vault against cn's declared plugin envelope (AD-6)",
          flags: [
            VERIFY_VAULT,
          ],
        },
      ],
      helpGroups: [{ subs: ["deploy"] }, { subs: ["verify"] }],
    },
    {
      name: "dashkit",
      desc: "bundle and verify the dashkit Obsidian edge",
      subcommands: [
        {
          name: "deploy",
          desc: "bundle src/dashkit -> <vault>/Scripts/dashkit.js (one-way; the vault is build output only)",
          // No `--format`: DASHKIT_SPEC declares no `formats`, so `edge-deploy` never parses one.
          flags: [
            DEPLOY_VAULT,
            {
              name: "--watch",
              arity: "bool",
              desc: "deploy once, then stay resident and redeploy on every save under src/dashkit, src/core",
            },
          ],
        },
        {
          name: "verify",
          desc: "check a vault against dashkit's declared plugin envelope (AD-6)",
          flags: [
            VERIFY_VAULT,
          ],
        },
      ],
      helpGroups: [{ subs: ["deploy"] }, { subs: ["verify"] }],
    },
    {
      name: "notekit",
      // ⚠ NO `verify` SIBLING — unlike cn and dashkit. notekit v1 ships no plugin envelope (Story 1.4
      // ⚠️-2: the contract + `notekit verify`/`doctor` are FR18, Epic 3), so the model must not offer a
      // subcommand the CLI would reject. That absence is the decision, and it survives Story 2.1's
      // three read verbs landing beside `deploy` — the invariant is "no `verify`", never "deploy alone".
      // ⚠ Naming a vault in this `desc` is a RED BUILD (check:no-consumer-ids scans src/**).
      desc: "render, check, and bundle the notekit Obsidian edge",
      subcommands: [
        {
          name: "deploy",
          desc: "bundle src/notekit -> <vault>/Scripts/notekit.js (one-way; the vault is build output only)",
          // No `--format`: NOTEKIT_SPEC declares no `formats`, so `edge-deploy` never parses one.
          flags: [
            DEPLOY_VAULT,
            {
              name: "--watch",
              arity: "bool",
              desc: "deploy once, then stay resident and redeploy on every save under src/notekit, src/core",
            },
          ],
        },
        {
          name: "render",
          // ⚠ THIS `desc` AND THE `--apply` ROW BELOW RENDER IN THE SAME `--help` OUTPUT. It used to read
          // "writes nothing (the sole-writer path is a later story)", which Story 2.2 falsified the
          // moment it added `APPLY` — the user read that the command writes nothing directly above the
          // flag that makes it write. Corrected on the #83 follow-up.
          desc: "preview a note as an nk-card; writes only with --apply (the sole writer)",
          // `APPLY` is the bmad family's const, REUSED rather than re-authored (Story 2.2): its text
          // ("WITHOUT IT NOTHING MUTATES (dry-run is the default)") IS NK-4 rule 3's contract, and the
          // JSON_FLAG / DEPLOY_VAULT / VERIFY_VAULT hoists are the precedent. Stated consequence:
          // `bmad`'s and `notekit render`'s --apply rows render identical help text, and an edit to
          // that desc moves both. That is the point of the hoist.
          // ⚠ Declaring it is a CORRECTNESS requirement, not a gate catch: check:surface-drift's union
          // is global and name-level, and `apply` is already in it via bmad — so a read of that flag
          // passes that gate whether or not this row exists. The gate that bites is FROZEN_HELP.
          flags: [NOTEKIT_CONFIG, NOTEKIT_AT, APPLY, JSON_FLAG],
        },
        {
          name: "validate",
          // ⚠ NO `--config`, deliberately. `validate` checks a candidate against std's OWN branch table
          // (NK_BRANCHES) and never reads the caller's registry, so declaring one "for consistency"
          // would ship a silent lie: check:surface-drift cannot catch a SURFACE entry that no code
          // reads (its own header says so), and the flag would render in --help, be offered by the
          // `_std` completer, be accepted from the user, and then be ignored. Declare only what the
          // code parses.
          desc: "check a RenderSpec read from stdin, returning the Result union",
          flags: [NOTEKIT_SPEC_STDIN, JSON_FLAG],
        },
        {
          name: "capabilities",
          // No `--at` (nothing here is time-varying) and no `--spec`.
          desc: "list the declared note types, generated from the one registry",
          flags: [NOTEKIT_CONFIG, JSON_FLAG],
        },
      ],
      // Every subcommand must appear in exactly ONE helpGroups entry (surface.test.ts), and a group
      // with no `desc` must wrap exactly one sub — so these are four single-sub groups, each inheriting
      // its sub's own desc. `renderHelp` builds the `commands:` block from here, so an ungrouped verb
      // would be invisible in --help even though the subcommand exists.
      helpGroups: [
        { subs: ["deploy"] },
        { subs: ["render"] },
        { subs: ["validate"] },
        { subs: ["capabilities"] },
      ],
    },
    {
      name: "bmad",
      desc: "manage the BMAD estate",
      subcommands: [
        {
          name: "install",
          desc: "install the loop-family skills across the estate",
          flags: [APPLY, PUSH, FORCE_TRACK, REPOS, TOOLS, SET, SKILLS, JSON_FLAG],
        },
        {
          name: "update",
          desc: "update the installed modules across the estate",
          flags: [APPLY, PUSH, FORCE_TRACK, REPOS, TOOLS, SET, SKILLS, JSON_FLAG],
        },
        {
          name: "deploy",
          desc: "compose and deploy the estate's leg across the Manifest",
          // `--repos` is ABSENT by contract, not by oversight (BM-19): deploy's scope IS its identity,
          // and it refuses the flag with exit 2 before reading anything.
          flags: [APPLY, PUSH, FORCE_TRACK, TOOLS, SET, SKILLS, JSON_FLAG],
        },
        {
          name: "verify",
          desc: "prove both Surfaces are byte-faithful to source (read-only, never mutates)",
          flags: [REPOS, SKILLS, JSON_FLAG],
        },
      ],
      helpGroups: [
        {
          subs: ["install", "update", "deploy"],
          desc: "dry-run by default; --apply to mutate, --push to push",
        },
        // 1:1, yet it states its own `desc`: HELP's wording is shorter than the subcommand's own.
        { subs: ["verify"], desc: "prove both Surfaces are byte-faithful to source (read-only)" },
      ],
    },
  ],
  flags: [{ name: "--help", short: "-h", arity: "bool", desc: "show this help" }],
} as const satisfies CommandSurface;

/**
 * The `bmad` subcommand names as a string-literal union, derived from {@link SURFACE}.
 *
 * This is what makes `bmadHandlers`' `Record<BmadSub, …>` a real gate: deleting `verify` from the map
 * fails `tsc`. ⚠ If `SURFACE` were annotated instead of `satisfies`-checked, this resolves to `never`
 * (not to `string`) and the gate goes vacuous — a dev checking "was it widened to `string`?" gets a
 * false all-clear. `surface.test.ts` pins it with a `@ts-expect-error` assert.
 */
export type BmadSub = Extract<
  (typeof SURFACE)["commands"][number],
  { name: "bmad" }
>["subcommands"][number]["name"];

// ── accessors ────────────────────────────────────────────────────────────────────────────────────
// Exported deliverables, not test scaffolding. AC6/AC7's load-bearing assertions are ABSENCE assertions,
// and an absence assertion is only as good as the reader underneath it — a `flagNames` that returns `[]`
// for an unresolved command would make `not.toContain("--repos")` pass for the wrong reason. Hence the
// unknown-name contract is SPECIFIED (`[]` / `undefined`, never a throw) and separately tested, and 3.2's
// completer can tell "no flags here" apart from "no such path".

/** The flags reachable at `cmd sub` — or `cmd`'s own flags when `sub` is omitted. */
function flagSpecs(s: CommandSurface, cmd: string, sub?: string): readonly FlagSpec[] {
  const c = s.commands.find((x) => x.name === cmd);
  if (!c) return [];
  if (sub === undefined) return c.flags ?? [];
  return c.subcommands.find((x) => x.name === sub)?.flags ?? [];
}

/** Subcommand names of `cmd`, in declaration order. Unknown command ⇒ `[]`. */
export function subNames(s: CommandSurface, cmd: string): readonly string[] {
  return s.commands.find((c) => c.name === cmd)?.subcommands.map((x) => x.name) ?? [];
}

/**
 * Flag names at `cmd sub`, in declaration order. `sub` is OPTIONAL because `alias` carries flags and no
 * subcommands — the same two-shape split the completer faces. Unknown command/sub ⇒ `[]`.
 */
export function flagNames(s: CommandSurface, cmd: string, sub?: string): readonly string[] {
  return flagSpecs(s, cmd, sub).map((f) => f.name);
}

/** The `enum` of `cmd sub flag`, if it has one. Unknown path, or a flag with no enum ⇒ `undefined`. */
export function flagEnum(
  s: CommandSurface,
  cmd: string,
  sub: string,
  flag: string,
): readonly string[] | undefined {
  return flagSpecs(s, cmd, sub).find((f) => f.name === flag)?.enum;
}

/** The `defaults` of `cmd sub flag`. Same contract as {@link flagEnum}: `undefined`, never a throw. */
export function flagDefaults(
  s: CommandSurface,
  cmd: string,
  sub: string,
  flag: string,
): readonly string[] | undefined {
  return flagSpecs(s, cmd, sub).find((f) => f.name === flag)?.defaults;
}

// ── renderers ────────────────────────────────────────────────────────────────────────────────────

/** Every description column in both constants, measured across all 29 label rows of the shipped text. */
const DESC_COL = 20;

/** One `  label<pad>desc` row. A `\n` inside `desc` starts a continuation line indented to DESC_COL. */
function row(label: string, desc: string): string {
  const head = `  ${label}`;
  const pad = head.length + 3 <= DESC_COL ? " ".repeat(DESC_COL - head.length) : "   ";
  return desc
    .split("\n")
    .map((d, i) => (i === 0 ? head + pad : " ".repeat(DESC_COL)) + d)
    .join("\n");
}

/** `-h, --help` · `--vault <dir>` · `--repos a,b` · `--watch`. */
function flagLabel(f: FlagSpec): string {
  return `${f.short ? `${f.short}, ` : ""}${f.name}${f.metavar ? ` ${f.metavar}` : ""}`;
}

function groupLabel(cmd: CommandSpec, g: HelpGroup): string {
  return [cmd.name, g.subs ? g.subs.join("|") : (g.flags ?? []).join(" ")].join(" ");
}

/** A group's rendered description: its own, else the single sub it wraps. */
function groupDesc(cmd: CommandSpec, g: HelpGroup): string | undefined {
  if (g.desc !== undefined) return g.desc;
  if (g.subs?.length !== 1) return undefined;
  return cmd.subcommands.find((s) => s.name === g.subs![0])?.desc;
}

/**
 * `HELP`'s option blocks, ordered BY SUBCOMMAND rather than by command — an explicit list, because the
 * order is shipped data and is not implied by the model's shape. `surface.test.ts` asserts each pair
 * resolves, and that the complement (subcommands with flags but no block) is exactly `alias` + the four
 * `bmad` subs, so a future `cn` subcommand cannot silently miss its block.
 */
export const HELP_OPTION_BLOCKS = [
  ["cn", "deploy"],
  ["dashkit", "deploy"],
  ["notekit", "deploy"],
  // Inserted immediately after `notekit deploy` so notekit's blocks stay contiguous — this list is
  // ORDERED SHIPPED DATA: its order is the rendered HELP bytes, and therefore the FROZEN_HELP delta.
  ["notekit", "render"],
  ["notekit", "validate"],
  ["notekit", "capabilities"],
  ["cn", "verify"],
  ["dashkit", "verify"],
] as const;

/** `BMAD_USAGE`'s flag headings, in shipped order. Every bmad flag's `group` must be one of these. */
export const BMAD_FLAG_GROUPS = ["safety flags", "selectors", "output"] as const;

const BMAD_FOOTER =
  "The estate Manifest is caller-local: $XDG_CONFIG_HOME/std/estate.toml (see estate.example.toml).";

/** Render `std --help`. Byte-identical to the constant it replaced — `main.test.ts` is the oracle. */
export function renderHelp(s: CommandSurface): string {
  const out: string[] = [
    "std — Pedro's standard CLI",
    "",
    "usage: std <command> [options]",
    "",
    "commands:",
  ];
  for (const cmd of s.commands) {
    for (const g of cmd.helpGroups) out.push(row(groupLabel(cmd, g), groupDesc(cmd, g) ?? ""));
  }
  for (const [cmd, sub] of HELP_OPTION_BLOCKS) {
    out.push("", `${cmd} ${sub} options:`);
    for (const f of flagSpecs(s, cmd, sub)) out.push(row(flagLabel(f), f.desc));
  }
  out.push("", "flags:");
  for (const f of s.flags) out.push(row(flagLabel(f), f.desc));
  return out.join("\n");
}

/**
 * Render the `std alias` usage line — the ONE statement of it (R-3, handed down from 3.1).
 *
 * It was hand-written twice and had already drifted: `main.ts` said "regenerate repo-nav + _std", while
 * `repo-nav.ts` said "(re)generate repo-nav + _std completion". Both existing assertions are loose
 * regexes (`/usage: std alias --install/`), so neither noticed — which is why `surface.test.ts` pins the
 * FULL line here rather than trusting them. The text is the `--install` flag's own `desc`, so the usage
 * line and the completer's explanation for the same flag cannot diverge again.
 */
export function renderAliasUsage(s: CommandSurface): string {
  const install = flagSpecs(s, "alias").find((f) => f.name === "--install");
  return `usage: std alias --install   # ${install?.desc ?? ""}`;
}

/**
 * Render `std bmad` usage. The flag block is a UNION over the four subcommands — deduped by name, in
 * first-seen order — which is what makes the family's flat documentation derivable from a per-subcommand
 * model at all. `install` contributes all eight, so the order is `install`'s.
 */
export function renderBmadUsage(s: CommandSurface): string {
  const bmad = s.commands.find((c) => c.name === "bmad");
  const subs = bmad?.subcommands ?? [];
  const out: string[] = [
    "std bmad — manage the BMAD estate",
    "",
    "usage: std bmad <subcommand> [options]",
    "",
    "subcommands:",
  ];
  for (const sub of subs) out.push(row(sub.name, sub.desc));

  const union: FlagSpec[] = [];
  for (const sub of subs) {
    for (const f of sub.flags) if (!union.some((u) => u.name === f.name)) union.push(f);
  }
  for (const group of BMAD_FLAG_GROUPS) {
    out.push("", `${group}:`);
    for (const f of union.filter((u) => u.group === group)) out.push(row(flagLabel(f), f.desc));
  }
  out.push("", BMAD_FOOTER);
  return out.join("\n");
}
