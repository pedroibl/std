// The BMAD estate Manifest — the enumeration + selection leg of the `bmad-manager` command family
// (Story 2.1, FR-3/FR-4). This module ships exactly three things: the ONE canonical `BmadRepo` record
// (BM-5/AD-2 — every later command converges on it, nobody forks it), the fail-loud loader for the
// caller-local `estate.toml`, and the `--repos`/`--tools`/`--set` selector helpers as pure functions
// over `BmadRepo[]`. It builds NO command surface and performs NO mutation — `std bmad` wiring is 2.2,
// `--set` shelling is 2.3, and every git behavior that reads `claudeTracked`/`hasUpstream`/`role` is 2.4.
//
// IDENTITY-FREE (D4/NFR3, enforced by the live `check:no-consumer-ids` gate which scans `src/**/*.ts`):
// the estate DATA is caller-local and never committed here. This file exports the TYPE and the LOADER;
// the repo list lives at `$XDG_CONFIG_HOME/std/estate.toml` (default `~/.config/std/estate.toml`), which
// is the machine owner's file, not std's. Baking a repo list into published `@pedroibl/std` would be an
// identity violation AND would trip that gate. See BM-2, which resolves the epic's OQ-1 this way.
//
// D3/AD-1 — the Manifest is validated serializable DATA, never logic: `estate.toml` carries no function
// values and no load-time computation. The loader is the only code, and it branches on data shape, never
// on a repo's identity.
//
// D1 core purity — this is a Bun-EDGE slice (`src/bmad/`), so `Bun.TOML` / `node:path` / `node:os` are
// legal here and forbidden in `src/core`. Nothing from this file belongs in core (no second caller).
//
// std reuse (NFR-4, build less): `readIfExists` from `src/fsx` is the absent-tolerant read (ENOENT → null,
// a real fs fault re-throws); `flagValue` from `src/core` parses both `--n v` and `--n=v`. The ONE thing
// core cannot do is a REPEATABLE flag — `flagValue` returns only the FIRST hit — so `collectFlagValues`
// below is a local collector. That is a runtime need of `--set`, not a gap in core: it has exactly one
// caller, so by Rule-of-Three it stays local. Do not delete it, and do not promote it until a third
// caller exists.

import { homedir } from "node:os";
import { basename, join } from "node:path";

import { flagValue } from "../core/index";
import { readIfExists } from "../fsx/index";

/**
 * One repo in the BMAD estate — the single canonical record every `bmad-manager` command shares
 * (BM-5/AD-2). There is exactly ONE definition of this type; later commands import it, never fork it.
 *
 * The required/optional split is load-bearing for git safety, not stylistic. `claudeTracked` and
 * `hasUpstream` are REQUIRED and never defaulted: *guessing* whether a repo's `.claude` is gitignored
 * or whether an upstream exists is unsafe — a wrong default could stage a gitignored tree or push to
 * the wrong remote. So the loader fails loud when either is absent (AC3). `tools` is safely defaulted
 * (AC4), and an absent `role` means `'target'`.
 */
export interface BmadRepo {
  /** REQUIRED — filesystem path. May be `"~/…"`; expansion is a consumer concern, not this module's. */
  path: string;
  /** Always present post-load; defaults to {@link DEFAULT_TOOLS} when the TOML entry omits it (AC4). */
  tools: string[];
  /** Optional, informational only — the git-safety spine (2.4) reads the LIVE branch, never this. */
  branch?: string;
  /** REQUIRED — `false` ⇒ `.claude` is gitignored ⇒ working-copy-only, commit skipped (FR-13/BM-17). */
  claudeTracked: boolean;
  /** REQUIRED — `false` ⇒ report no-upstream; `--push` uses `git push -u` (FR-14). */
  hasUpstream: boolean;
  /** Optional — absent ⇒ target. `'source-only'` is excluded from the default set AND the commit loop (BM-11). */
  role?: "target" | "source-only";
  /** Optional — free text. */
  notes?: string;
  /** Optional — explicit repo name; otherwise `basename(path)` is the `--repos` match key (AC6). */
  name?: string;
}

/**
 * The fail-loud error type for every Manifest fault — a malformed file, a missing required field, an
 * unknown `--repos` name, a malformed `--set` token. Modeled on `src/cli/edge-verify.ts:EdgeVerifyError`:
 * a message-carrying `Error` subclass that sets `this.name`, which the command layer (2.2) maps to exit 1.
 * Every message names the offending thing — the entry, the repo name, or the bad token — so a fault is
 * actionable without re-reading the file.
 */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/**
 * The tool set applied when an entry omits `tools` (AC4) and the default Tool set for a run when
 * `--tools` is absent (AC5). Exported so the loader, the selectors, and the 2.2 command layer share ONE
 * source for the default rather than three copies of the same literal pair.
 */
export const DEFAULT_TOOLS: readonly string[] = ["claude-code", "antigravity-cli"];

/**
 * The single canonical path of the estate Manifest: `$XDG_CONFIG_HOME/std/estate.toml`, falling back to
 * `<home>/.config/std/estate.toml`. Deliberately the exact shape of `src/cli/main.ts:globalReposPath()`
 * with the basename swapped (AD-7 mirror; BM-2) — std already resolves ONE caller-local config this way,
 * and the estate list is the second, so it resolves identically.
 *
 * This function IS the shared cross-tool contract (AC8). `bmad-manager` reads it today; `bmad-lifeos-sync`
 * — which currently works one `--directory <target>` at a time and reads no estate list at all — MUST
 * resolve this same path when it later gains a batch-across-the-estate mode. There is no separate
 * "constant" to define and keep in sync: this resolver is the single source.
 *
 * `env` is a parameter (not a `process.env` read inside) so tests pin both branches without mutating the
 * process environment.
 */
export function resolveManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "std", "estate.toml");
}

/** Injection seam for {@link loadManifest} — tests pass a temp `manifestPath` and/or a fake `fs`. */
export interface LoadManifestDeps {
  /** Absent-tolerant reader; defaults to `src/fsx`'s `readIfExists` (missing file → `null`). */
  fs?: { readIfExists(path: string): string | null };
  /** Explicit Manifest path; defaults to `resolveManifestPath(env)`. Tests inject an `os.tmpdir()` file. */
  manifestPath?: string;
  /** Environment for the default path resolution. Ignored when `manifestPath` is given. */
  env?: NodeJS.ProcessEnv;
}

/** A raw parsed TOML row, before validation. Every field is `unknown` — the file is data we do not trust. */
type RawRepo = Record<string, unknown>;

/**
 * Read + parse + validate the caller-local `estate.toml` into `BmadRepo[]` (AC3, AC4).
 *
 * Fail-loud at every seam, each error naming the offender: a missing file names the path, an unparseable
 * file names the path, a file that parses but carries no `[[repos]]` array names the path, and a row
 * missing a required field names the entry (its `path`, or `entry #N` when `path` itself is what is
 * missing). Nothing is silently skipped or left `undefined` — the fields this returns gate git behavior
 * in Story 2.4, so a quiet hole here becomes an unsafe stage or push there.
 *
 * The no-`[[repos]]` guard is not defensive padding: `Bun.TOML.parse("")` returns `{}` and
 * `Bun.TOML.parse("foo=1")` returns `{foo:1}` — both leave `.repos === undefined`, so iterating it
 * directly would surface a raw `TypeError` instead of the named `ManifestError` the contract requires.
 */
export function loadManifest(deps: LoadManifestDeps = {}): BmadRepo[] {
  const path = deps.manifestPath ?? resolveManifestPath(deps.env);
  const read = deps.fs?.readIfExists ?? readIfExists;

  const text = read(path);
  if (text === null) {
    throw new ManifestError(`estate manifest not found at ${path} — create it (a [[repos]] TOML list)`);
  }

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (err) {
    throw new ManifestError(`estate.toml at ${path} is not valid TOML: ${(err as Error).message}`);
  }

  const repos = (parsed as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(repos)) {
    throw new ManifestError(`estate.toml at ${path} has no [[repos]] entries`);
  }

  const entries = repos.map((raw, i) => normalizeEntry(raw, i));

  // Duplicate match keys fail loud. `selectRepos({repos:[n]})` filters by `repoName`, so two entries
  // resolving to the same name would BOTH be returned for one requested repo — a batch run touching a
  // repo the caller never named. Ambiguity here is the same class of quiet wrong as an unknown name.
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = repoName(entry);
    if (seen.has(name)) {
      throw new ManifestError(
        `estate.toml at ${path}: duplicate repo name "${name}" — two entries resolve to the same --repos key`,
      );
    }
    seen.add(name);
  }
  return entries;
}

/** Validate one raw row and apply defaults. Throws `ManifestError` naming the entry on any fault. */
function normalizeEntry(raw: unknown, index: number): BmadRepo {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ManifestError(`estate.toml entry #${index}: expected a [[repos]] table, got ${typeof raw}`);
  }
  const row = raw as RawRepo;

  // `path` is validated first because every later message identifies the entry BY path.
  if (row.path === undefined) {
    throw new ManifestError(`estate.toml entry #${index}: missing required field "path"`);
  }
  if (typeof row.path !== "string" || row.path.trim() === "") {
    throw new ManifestError(`estate.toml entry #${index}: field "path" must be a non-empty string`);
  }
  const path = row.path;

  const claudeTracked = requireBoolean(row, "claudeTracked", path);
  const hasUpstream = requireBoolean(row, "hasUpstream", path);

  let tools: string[];
  if (row.tools === undefined) {
    tools = [...DEFAULT_TOOLS]; // AC4 — a fresh copy per entry; the exported default stays immutable.
  } else if (Array.isArray(row.tools) && row.tools.every((t) => typeof t === "string")) {
    tools = row.tools as string[];
  } else {
    throw new ManifestError(`estate.toml entry "${path}": field "tools" must be an array of strings`);
  }

  // `role` is type-checked rather than coerced: a typo'd `"sourceonly"` silently read as a target would
  // pull a source repo into the default set AND the 2.4 commit loop — exactly the class of quiet
  // misbehavior the fail-loud contract exists to prevent.
  let role: BmadRepo["role"];
  if (row.role !== undefined) {
    if (row.role !== "target" && row.role !== "source-only") {
      throw new ManifestError(
        `estate.toml entry "${path}": field "role" must be "target" or "source-only", got ${JSON.stringify(row.role)}`,
      );
    }
    role = row.role;
  }

  const entry: BmadRepo = { path, tools, claudeTracked, hasUpstream };
  if (role !== undefined) entry.role = role;
  const branch = optionalString(row, "branch", path);
  if (branch !== undefined) entry.branch = branch;
  const notes = optionalString(row, "notes", path);
  if (notes !== undefined) entry.notes = notes;
  // An empty `name` is rejected, not just wrong-typed-checked: `repoName` is `name ?? basename(path)`,
  // and `""` is not nullish, so it would win the `??` and silently blank the `--repos` match key rather
  // than falling back. `path` is already held to the same non-empty rule.
  const name = optionalString(row, "name", path);
  if (name !== undefined) {
    if (name.trim() === "") {
      throw new ManifestError(`estate.toml entry "${path}": field "name" must be a non-empty string`);
    }
    entry.name = name;
  }
  return entry;
}

/** A required boolean field — absent OR wrong-typed both fail loud, naming the entry and the field. */
function requireBoolean(row: RawRepo, field: string, path: string): boolean {
  const value = row[field];
  if (value === undefined) {
    throw new ManifestError(`estate.toml entry "${path}": missing required field "${field}"`);
  }
  if (typeof value !== "boolean") {
    throw new ManifestError(`estate.toml entry "${path}": field "${field}" must be a boolean`);
  }
  return value;
}

/** An optional string field — absent is fine, wrong-typed is not. */
function optionalString(row: RawRepo, field: string, path: string): string | undefined {
  const value = row[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ManifestError(`estate.toml entry "${path}": field "${field}" must be a string`);
  }
  return value;
}

/** One `--set <module>.<key>=<value>` selector, parsed into structured data. Consumed in Story 2.3. */
export interface SetOption {
  module: string;
  key: string;
  value: string;
}

/** The parsed run selectors. `repos`/`tools` absent ⇒ "no restriction"; `set` is always an array. */
export interface Selectors {
  repos?: string[];
  tools?: string[];
  set: SetOption[];
}

/** `<module>.<key>=<value>` — `module` takes no dot, so `a.b.c=d` reads as module `a`, key `b.c`. */
const SET_TOKEN = /^([^.]+)\.([^=]+)=(.*)$/;

/**
 * Parse `--repos` / `--tools` / `--set` out of `argv` into structured data (AC7).
 *
 * This story ONLY parses. Shelling `SetOption[]` onto `bmad install --set <m>.<k>=<v>` is Story 2.3, and
 * calling this from a command entry is Story 2.2.
 *
 * `--set` is REPEATABLE and every occurrence is kept — that is the whole reason for the local collector.
 * A malformed token fails loud naming the token rather than being dropped, because a silently ignored
 * `--set` would make an install look configured when it is not.
 */
export function parseSelectors(argv: string[]): Selectors {
  const set = collectFlagValues(argv, "set").map((token) => {
    const m = SET_TOKEN.exec(token);
    if (!m) {
      throw new ManifestError(`--set: expected <module>.<key>=<value>, got "${token}"`);
    }
    return { module: m[1]!, key: m[2]!, value: m[3]! };
  });

  const selectors: Selectors = { set };
  const repos = splitList(flagValue(argv, "repos"));
  if (repos) selectors.repos = repos;
  const tools = splitList(flagValue(argv, "tools"));
  if (tools) selectors.tools = tools;
  return selectors;
}

/** Comma-split a flag value, dropping empties. An absent flag — or one with no real values — is `undefined`. */
function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return items.length > 0 ? items : undefined;
}

/**
 * Collect EVERY occurrence of a repeatable `--name value` / `--name=value` flag, in argv order.
 *
 * This exists because `core/args.flagValue` returns only the FIRST hit — correct for the single-valued
 * flags it was built for, wrong for `--set`, which the BMAD installer accepts many times in one run.
 * ONE caller (`parseSelectors`), so by Rule-of-Three it stays local: this is a runtime need of `--set`,
 * not a missing core primitive. Promote it to `src/core/args.ts` only at a third caller.
 */
function collectFlagValues(argv: string[], name: string): string[] {
  const eq = `--${name}=`;
  const bare = `--${name}`;
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith(eq)) {
      out.push(arg.slice(eq.length));
    } else if (arg === bare) {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new ManifestError(`--${name}: expected <module>.<key>=<value>, got no value`);
      }
      out.push(next);
      i++;
    }
  }
  return out;
}

/**
 * The `--repos` match key: the explicit `name` field when the entry declares one, else `basename(path)`.
 * Documented as the contract so later stories match repos the same way.
 */
export function repoName(repo: BmadRepo): string {
  return repo.name ?? basename(repo.path);
}

/**
 * Resolve the repo set for a run (AC5, AC6).
 *
 * With no `--repos`, the default set is the whole Manifest MINUS `role:'source-only'` entries (BM-11) —
 * a source repo is enumerated so 2.4 can see its flag, never operated on by default. With `--repos`, only
 * the named entries are returned, in MANIFEST DECLARATION ORDER (BM-16, not the order the flag listed
 * them), because batch runs iterate sequentially and their order must be the file's, reproducibly.
 * An unknown name fails loud naming it — a silently dropped `--repos foo` would report success over a
 * repo that was never touched.
 *
 * An explicit `--repos` CAN name a `source-only` entry: the exclusion in AC5 is about the DEFAULT set.
 * Asking for a repo by name is a deliberate act; 2.4 still reads `role` before it stages anything.
 */
export function selectRepos(manifest: BmadRepo[], opts: { repos?: string[] } = {}): BmadRepo[] {
  const requested = opts.repos;
  if (requested === undefined) {
    return manifest.filter((r) => r.role !== "source-only");
  }

  const known = new Set(manifest.map(repoName));
  for (const name of requested) {
    if (!known.has(name)) {
      throw new ManifestError(`unknown repo "${name}" — not in the estate manifest`);
    }
  }
  const wanted = new Set(requested);
  return manifest.filter((r) => wanted.has(repoName(r)));
}
