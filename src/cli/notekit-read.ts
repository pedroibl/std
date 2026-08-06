// Story 2.1 — the notekit CLI READ surface: `render` (preview), `validate`, `capabilities` (NK-7).
// Bun edge — `node:*` is allowed here; only `core` is pure (D1).
//
// THIS SURFACE CANNOT WRITE, and that is the story's headline claim. `render` previews; the sole-writer
// path (`render --apply`) is Story 2.2's, and lives behind its own ACs. Concretely: no `--apply` flag,
// no fence-mutating helper "ready for 2.2", and no write API imported at all. The test file scans this
// module's source for sixteen fs tokens, so the claim is checkable rather than asserted.
//
// ⚠ STORY 2.2 CHANGED NOTHING ABOUT THAT. It extracted `renderPlan` (the rows-1–6 computation) and
// exported `emit`, so `src/cli/notekit-write.ts` previews and writes from the SAME plan and prints
// through the SAME printer — NK-4 rule 3 is a shared computation here, not a promise. The dependency
// runs ONE WAY, `notekit-write.ts` → `notekit-read.ts`: this file gained two exports and still contains
// zero write tokens and zero knowledge that a writer exists (both asserted).
//
// IT IMPORTS ONLY THE PURE HALF of the notekit slice (`../notekit/index`), NEVER `../notekit/edge/**`.
// This file is root-typechecked, and the root tsconfig has no DOM lib by design — a single edge import
// drags `HTMLElement` in and fails `bun run typecheck` with TS2304 (Story 1.4 ⚠️-1, proven there).
//
// IDENTITY-FREE (D4/NFR3): no vault path, no vault name, no note-type literal. Every path arrives as
// `--config` or as the `<note>` positional.
//
// EXIT CODES — the estate's universal contract, `0` ok / `1` fail-loud / `2` usage. NK-7's table lists
// only ok/fail/SKIP; `2` is orthogonal to that triad rather than a third failure verdict, and SKIP has
// no occurrence here at all: SKIP is the environment-probe verdict ("the plugin is not installed, so
// this check did not run"), and none of these three verbs probes an environment. That is `doctor`'s
// job, in Epic 3. So the read surface's complete exit set is {0, 1, 2}.

import { basename } from "node:path";
import { readFileSync } from "node:fs";

import {
  dispatchAsync,
  flagValue,
  hasFlag,
  parseFrontmatterBlock,
  slugify,
} from "../core/index";
import {
  capabilities,
  createFence,
  locateFence,
  noteToRenderSpec,
  parseFenceBody,
  resolveTemplate,
  serializeFenceBody,
  renderCardHtml,
  validate,
  type FenceFields,
  type LocatedFence,
  type NoteTypeRegistry,
  type RenderSpec,
  type RenderSpecErrorCode,
  type Rubric,
} from "../notekit/index";
import { readStdinJson } from "../stdio/index";

/** The frontmatter key whose PRESENCE opts a note in (NK-1.8 rule 2) — the value is never consulted. */
const OPT_IN_KEY = "nk-type";

/**
 * The CLI-level failure codes, new to this story. They are EDGE-level and deliberately not in `core`:
 * "this note is unreadable" is a fact about a filesystem, which `core` may not know about.
 */
export type NotekitReadErrorCode =
  | "nk-note-unreadable"
  | "nk-no-opt-in"
  | "nk-no-fence"
  | "nk-unknown-type";

/**
 * The CLOSED set Story 2.3's dispatcher branches on — SIX members, because `render`'s validation row
 * emits `RenderSpecError` verbatim rather than re-coding it. Exported so 2.3 imports it instead of
 * restating it. ⚠ The two halves carry different shapes: the four codes above come with
 * `{code, message}`, the two from `core` come with `{code, message, field}`.
 */
export type NotekitErrorCode = NotekitReadErrorCode | RenderSpecErrorCode;

/** Every effect injectable, so the whole surface is unit-testable with no fs, no stdin and no clock. */
export interface NotekitReadDeps {
  log?: (line: string) => void;
  err?: (line: string) => void;
  /** Resolves `unknown`; `null` means "no usable input" and the CLI branches on it VISIBLY. */
  readStdin?: () => Promise<unknown>;
  now?: () => string;
  loadRegistry?: (path: string) => Promise<NoteTypeRegistry>;
  /** `null` is the unreadable/absent note — row 2 of the exit table, never a throw. */
  readNote?: (path: string) => string | null;
}

/** The one envelope shape every verb and every exit point emits. */
export type Envelope = { ok: true; value: unknown } | { ok: false; error: unknown };

const USAGE = [
  "usage: std notekit <render|validate|capabilities>",
  // ⚠ "writes nothing" was FALSE from the moment 2.2 shipped `--apply`, and this USAGE is the block a
  // FAILING `render --apply` invocation prints — `runNotekitApply` reaches it through `renderPlan`. The
  // synopsis column is left unwidened deliberately: adding `[--apply]` to it realigns all three rows for
  // no gain, and the claim, not the synopsis, was the thing that lied. Corrected on the #83 follow-up.
  "  render <note> --config <path> [--at <iso>] [--json]   preview a note as an nk-card; writes only with --apply",
  "  validate --spec - [--json]                            check a RenderSpec read from stdin",
  "  capabilities --config <path> [--json]                 list the declared note types",
].join("\n");

/**
 * Emit an envelope. Under `--json` the serialized union is the ONLY thing on stdout (NK-7); otherwise a
 * human rendering goes to stdout on success and to stderr on failure, so a piping caller never has to
 * separate logs from payload.
 *
 * A `function` DECLARATION, which hoists, and module-scoped so every verb and every exit point can
 * reach it. Both properties are load-bearing rather than stylistic: a helper local to `render` could
 * not satisfy the `validate`/`capabilities` ACs, and a `const emit = () => …` would be in its temporal
 * dead zone for any module-scope reference above it — compiling clean and dying at runtime with
 * `ReferenceError: Cannot access 'emit' before initialization`.
 *
 * EXPORTED at Story 2.2 so the write surface emits through this one printer rather than a second
 * near-identical copy. Two emitters is exactly how a preview and the write that follows it drift, and
 * NK-4 rule 3 is the rule that forbids the drift.
 */
export function emit(
  env: Envelope,
  json: boolean,
  out: (line: string) => void,
  err: (line: string) => void,
): void {
  if (json) {
    out(JSON.stringify(env));
    return;
  }
  if (env.ok) {
    out(humanValue(env.value));
    return;
  }
  err(humanError(env.error));
}

/**
 * The text of a CAUGHT value, for a value that `catch` binds as `unknown` and that JavaScript lets be
 * literally anything.
 *
 * ⚠ IT REPLACES `(e as Error).message ?? String(e)`, WHICH IS NOT A FALLBACK AT ALL. The property read
 * runs BEFORE `??` can apply, so a thrown `null`/`undefined` raises `TypeError: null is not an object`
 * out of the very catch block that exists to stop a throw from escaping. Reproduced 2026-08-06 against
 * this file and `notekit-write.ts`: a `readNote` that threw `undefined` left `runNotekitApply` by
 * TypeError, so `main.ts` reported an unhandled rejection instead of exit 1. `??` also cannot cover a
 * non-Error object with no `message` at all — `throw {code:"x"}` yields `undefined ?? String(e)` →
 * `"[object Object]"`, i.e. the fallback fires but tells the reader nothing the raw value did not.
 *
 * `instanceof Error` first, `String(e)` otherwise. Same shape as `core/result.ts`'s `classify`,
 * `src/proc/index.ts`'s `message`, and `src/http/index.ts` — this is the estate's existing idiom, not
 * a new one.
 *
 * ⚠ IT LIVES HERE, NOT IN `notekit-write.ts`, and not duplicated into both. Four call sites across the
 * two CLI files (two here, two there) is past D2's Rule of Three, and the dependency already runs one
 * way — `notekit-write.ts` imports this module and never the reverse — so one owner costs no new edge.
 * It is EXPORTED for that import and for a direct unit test; a local copy per file is how the two
 * halves of one contract drift.
 */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The human rendering of a success payload — one shape per verb, never a second renderer. */
function humanValue(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  const record = value as Record<string, unknown>;

  if (typeof record.html === "string") {
    const diff = typeof record.diff === "string" ? record.diff : "";
    // ⚠ THE GAP ADVISORY IS RENDERED FROM THE SAME `gaps` ARRAY THE JSON ENVELOPE CARRIES, in the ONE
    // printer — this is where FR-9's "reports the gap in the preview" is observable, and nothing in
    // `core` will produce it. An exit code alone tells the human nothing about WHICH field to add. A
    // second printer for the human form is exactly how the two modes would drift.
    const gaps = Array.isArray(record.gaps) ? record.gaps.map(String) : [];
    const advisory = gaps.length === 0 ? "" : `\n\n${gaps.map((k) => `⚠ no value for '${k}'`).join("\n")}`;
    // The diff's EMPTINESS is the FR-16 parity signal — reported here, never enforced. Enforcement is
    // `notekit lint`, Story 3.1.
    return diff.length === 0
      ? `${record.html}\n\n✓ fence body is canonical (FR16 parity holds)${advisory}`
      : `${record.html}\n\n${diff}${advisory}`;
  }

  if (Array.isArray(record.noteTypes)) {
    const rows = record.noteTypes.map((entry) => {
      const row = entry as Record<string, unknown>;
      const fields = Array.isArray(row.fields)
        ? row.fields.map((f) => (f as Record<string, unknown>).key).join(", ")
        : "";
      return `${String(row.nkType)}  ${String(row.templateId)}  ${String(row.renderer)}  [${fields}]`;
    });
    return [`${String(record.catalogVersion)}`, ...rows].join("\n");
  }

  return "✓ nk-v1 RenderSpec valid";
}

/** The human rendering of a failure payload. Never a stack trace. */
function humanError(error: unknown): string {
  if (typeof error !== "object" || error === null) return `✗ ${String(error)}`;
  const record = error as Record<string, unknown>;
  const at = typeof record.field === "string" && record.field.length > 0 ? ` at ${record.field}` : "";
  return `✗ ${String(record.code)}${at}: ${String(record.message)}`;
}

/**
 * Read a value flag, distinguishing "absent" from "present with no value".
 *
 * `flagValue` returns `undefined` for BOTH, so a `?? default` hands the user something they did not ask
 * for at exit 0 — the silent substitution `edge-deploy.ts` documents and answers with this same
 * `hasFlag`-first shape. A trailing `--at` is a usage error, not a fall-back to the clock.
 *
 * The space form returns the following token UNCONDITIONALLY, so `--at --json` yields the literal
 * `"--json"`; a value that looks like a flag is rejected for the same reason.
 */
function valueFlag(argv: string[], name: string): { present: boolean; value?: string } {
  if (!hasFlag(argv, name) && flagValue(argv, name) === undefined) return { present: false };
  const value = flagValue(argv, name);
  if (value === undefined || value.startsWith("--")) return { present: true };
  return { present: true, value };
}

/**
 * Value flags whose SPACE form consumes the following token. That token is a flag's value, never a
 * positional.
 *
 * ⚠ `body` JOINED THE SET AT STORY 2.7 AND IT CHANGES A TRACED BEHAVIOUR, so it is worth a sentence.
 * Without it, `render --body - --apply <note>` would hand `notePositional` the literal `-` as the
 * `<note>` path — `-` does not start with `--`, so it reads as a positional — and the run would exit `1`
 * with `nk-note-unreadable`. Loud and safe, but wrong: `-` is `--body`'s VALUE. With `body` in the set
 * the value is skipped with its flag and BOTH flag orderings resolve the same `<note>`. The membership
 * is not optional either — `notekit-read.test.ts`'s drift test below requires this set to equal the
 * declared `arity: "value"` flags exactly, so declaring `--body` in `surface.ts` forces it.
 *
 * ⚠ THIS MUST MATCH the `arity: "value"` flags declared for notekit's read verbs in `surface.ts`. A
 * flag added there and missed here silently eats the `<note>` positional — the exact defect
 * `notePositional` exists to fix, re-introduced by omission. Exported so `notekit-read.test.ts` can
 * assert the two agree: `check:surface-drift` will NOT catch this (it checks that every flag READ is
 * declared, not that this set is complete), so the drift gate for it is that test. A comment would not
 * have gone red.
 */
export const VALUE_FLAGS = new Set(["config", "at", "spec", "body"]);

/**
 * The `<note>` positional.
 *
 * ⚠ NOT `positional(argv.slice(1))`. `positional` returns the first token not starting with `--`, and
 * it cannot know that a token is some flag's value: `render --config cfg.ts note.md` hands back
 * **`cfg.ts`**, so every invocation that puts a flag before the path silently renders the config file
 * as a note. `positional(argv)` is worse still — `argv[0]` is the subcommand, so it returns
 * `"render"` — but slicing the subcommand off only fixes the shallower half of the same trap.
 *
 * Space-form value flags are therefore skipped WITH their value. The equals form (`--config=cfg.ts`)
 * is one token and consumes nothing.
 */
function notePositional(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith("--")) return token;
    if (VALUE_FLAGS.has(token.slice(2))) i++;
  }
  return "";
}

/** Load the caller-local registry — the `await import` + `default ?? config` shape `alias` uses. */
async function defaultLoadRegistry(path: string): Promise<NoteTypeRegistry> {
  const mod = (await import(path)) as { default?: NoteTypeRegistry; config?: NoteTypeRegistry };
  const config = mod.default ?? mod.config;
  if (!config) throw new Error(`no default export (expected a NotekitConfig)`);
  return config;
}

/**
 * Resolve `--config` to a registry, or `null` when the flag is missing, valueless, or unloadable.
 *
 * ⚠ The exit code deliberately DIFFERS from `alias --install`, which returns `1` for an unreadable or
 * default-less registry. For these verbs the config is a required ARGUMENT, so its absence is a usage
 * error (`2`), not a runtime fault. Do not copy `alias`'s `1`.
 */
async function resolveRegistry(
  argv: string[],
  deps: NotekitReadDeps,
  err: (line: string) => void,
): Promise<NoteTypeRegistry | null> {
  const flag = valueFlag(argv, "config");
  if (!flag.present || flag.value === undefined) {
    err(`std notekit: --config <path> is required\n\n${USAGE}`);
    return null;
  }
  try {
    return await (deps.loadRegistry ?? defaultLoadRegistry)(flag.value);
  } catch (e) {
    err(`std notekit: cannot load the note-type registry — ${errorText(e)}`);
    return null;
  }
}

/** Read a note from disk. `null` on any fs fault — the modeled "unreadable note" outcome. */
function defaultReadNote(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Everything `render` computes before it prints anything — the note's text, its fence, its fields, the
 * validated spec, the HTML, and the FR-16 parity diff.
 *
 * ⚠ ONE PLAN COMPUTATION, TWO CALLERS (Story 2.2). `render` previews it and `render --apply` writes
 * from it, and they must be the same bytes: NK-4 rule 3 requires the write to be preceded by *the same*
 * preview, and two computations is precisely how a preview and a write drift apart. `noteText` is the
 * exact string the fence offsets index into, so the writer's splice runs against the string its fence
 * was located in — which is what makes `spliceFence`'s stale-offset throw unreachable from the CLI.
 */
export type RenderPlan = {
  notePath: string;
  noteText: string;
  fence: LocatedFence;
  fields: FenceFields;
  spec: RenderSpec;
  html: string;
  /** `serializeFenceBody(fields)` — the diff's proposed side, WITHOUT a trailing newline. */
  proposedBody: string;
  /** Empty when the body is already canonical; that emptiness is the FR-16 parity signal. */
  diff: string;
};

/**
 * A plan, a usage exit, or a modeled failure.
 *
 * `usage` carries no message because the usage line has ALREADY been written to `err` by the time it is
 * returned — the three usage conditions each phrase their own line, and re-deriving them here would be
 * a second statement of text the caller already printed.
 */
export type PlanOutcome =
  | { kind: "plan"; plan: RenderPlan }
  /** Story 2.5 — an opted-in note with no fence, and a fence that can be seeded from its frontmatter. */
  | { kind: "seed"; seed: SeedPlan }
  | { kind: "usage" }
  | { kind: "error"; error: unknown };

// ── author mode: the frontmatter → fence derivation (Story 2.5) ─────────────────────────────────

/**
 * The rubric's keys, in render order: the title first, then every declared field. The ONE notion of
 * "what this note type wants" — the derivation projects the fields and collects the gaps in ONE pass
 * over it, so a derived record and its gap report can never disagree about what was being looked for.
 *
 * ⚠ THE GUARD IS A RUNTIME GUARD, NOT A COMPILER ONE. The rubric arrives from `resolveTemplate` over a
 * `--config` module the CLI `await import`s, so tsc's `Rubric` type is a claim about a value it never
 * saw. Two skips are applied here rather than at each caller:
 *
 *   `nk-type` — the OPT-IN SIGNAL. NK-1.8 rule 2 pins routing to the fence INFO STRING, so writing it
 *   into the body duplicates the signal into a region the dispatcher never reads and pollutes the
 *   rubric field set. A naïve `serializeFenceBody(parseFrontmatter(text))` does exactly that.
 *
 *   the EMPTY key — an FR-16 requirement, not tidiness. `parseFrontmatter` KEEPS a trim-empty key (a
 *   ` : orphan` line yields `""`); `parseFenceBody` SKIPS it. So an empty key riding through would
 *   serialize to `: orphan`, which the parser then drops — `serialize(parse(body)) !== body` on a fence
 *   this story just created, failing Story 3.1's parity gate. The rubric projection means only a rubric
 *   key can reach the output, so an empty one is a malformed caller-local config, and skipping is the
 *   codec's own answer for a line it cannot represent (normalization rule 2).
 */
function rubricKeys(rubric: Rubric): string[] {
  if (rubric === null || typeof rubric !== "object" || !Array.isArray(rubric.fields)) {
    throw new Error("nk-derive: rubric must be an object with a fields array");
  }
  const wanted = [rubric.titleField, ...rubric.fields.map((field) => field.key)];
  return wanted.filter((key) => key !== OPT_IN_KEY && key !== "");
}

/**
 * 🔴 THE ONE PLACE FRONTMATTER INFLUENCES WHAT A FENCE SAYS (NK-1.8 rule 3). Everything downstream is
 * the render path unchanged: `noteToRenderSpec(fields, rubric, injected)` → `validate` →
 * `renderCardHtml`. A second frontmatter read in the render or write path forks the seam rule 1 exists
 * to keep single — "`core` never reads frontmatter for card field VALUES".
 *
 * ⚠ IT TAKES THE PARSED RECORD, NOT THE MARKDOWN, and that is what makes AC #1's gate reach its stated
 * value rather than a softened one. The first shape took `markdown: string` and parsed it here — which
 * put a SECOND `parseFrontmatter(` call in the slice beside `renderPlan`'s opt-in read, and the gate
 * was then written to accept two "because the opt-in read is sanctioned". It is sanctioned, but that
 * was never the argument: `renderPlan` already holds the whole record when it checks the opt-in, so
 * threading it costs nothing and the slice reads frontmatter EXACTLY ONCE. A projection over a record
 * is also the more honest signature — nothing about this function needs note text.
 *
 * ⚠ IT LIVES AT THE EDGE, AND THAT IS A SOURCE CONSTRAINT RATHER THAN TASTE. `core-fence.ts` states its
 * own scope in terms: the lines inside the fence, NEVER the note's YAML frontmatter, and
 * `parseFrontmatter` "stays the CALLER's tool … outside core". NK-1.8 rule 3 puts only
 * `serializeFenceBody` in `core`; the frontmatter read and the rubric projection are the caller's.
 * Promoting it would mean rewriting that SCOPE paragraph a second time and dragging a `src/core/parse`
 * import into the pure notekit half.
 *
 * ⚠ AND IT LIVES IN THIS FILE RATHER THAN `notekit-write.ts`, WHERE THE STORY PLACED IT — because the
 * story's own reason for the write side ("it has exactly one caller") is false in the shipped design.
 * The author-mode PREVIEW is a read-surface path and the WRITE is a write-surface path, so it has two,
 * and THE DEPENDENCY RUNS ONE WAY (`notekit-write.ts` → this file). Composing the block in both places
 * is exactly the preview/write drift NK-4 rule 3 forbids. This is 2.2's own `errorText` ruling applied
 * a second time: shared by both halves of one contract ⇒ one owner, in the lower module. It carries
 * ZERO write tokens, so 2.1's AC #4 gate over this file is unaffected. `notekit-write.ts` re-exports it
 * so 2.2's imports keep resolving unedited.
 *
 * ⚠ THE TWO CODECS ARE NOT INTERCHANGEABLE, though they return the same TypeScript type — which is what
 * makes `serializeFenceBody(parseFrontmatter(text))` typecheck perfectly and be wrong five ways. Two of
 * the five are closed in `rubricKeys`; the other three are INHERITED and DECLARED, because "fixing"
 * them here would break parity rather than restore it:
 *   1. `parseFrontmatter` STRIPS surrounding quotes; `parseFenceBody` does not (rule 6). So
 *      `title: "Some: Thing"` derives to `title: Some: Thing`, which re-parses whole (only the first
 *      `:` splits — rule 7) and is CORRECT. But `name: '[a, b]'` unquotes to the literal `[a, b]`,
 *      which the fence codec reads back as a TWO-ELEMENT LIST — a type change the round trip cannot
 *      see. Re-quoting on the way out would make the body non-canonical and break FR-16 parity, which
 *      Story 3.1 enforces, so the limit is declared rather than papered over.
 *   2. `serializeFenceBody` drops array-index keys (rule 8) while `parseFrontmatter` keeps them, so a
 *      frontmatter `1:` derives to nothing. Inherited behaviour, one layer down.
 *   3. `parseFrontmatter` builds a PLAIN `{}` where `parseFenceBody` builds `Object.create(null)`, so a
 *      `__proto__:` line hits the prototype SETTER and the key VANISHES, while `fm["toString"]`
 *      resolves to an inherited FUNCTION on a record that never carried the key. Every read below is
 *      therefore `hasOwnProperty` — a `if (!fm[k])` required-field check passes on `toString` and fails
 *      on `__proto__`, both wrong.
 *
 * The output is `Object.create(null)` deliberately, mirroring `parseFenceBody`, so a derived record and
 * a parsed one behave identically downstream. A plain `{}` would reintroduce hazard 3 one layer later
 * and harder to see.
 */
export function deriveFenceFields(
  frontmatter: Record<string, string | string[]>,
  rubric: Rubric,
): DerivedFields {
  const wanted = rubricKeys(rubric);
  const fields: FenceFields = Object.create(null);
  const gaps: string[] = [];
  for (const key of wanted) {
    // PRESENT-BUT-EMPTY is a gap on the same footing as absent: the human still has to fill it in, and
    // `validate` will not tell them — a non-title empty is `ok:true` with `value: ""`. It is still
    // DERIVED, because omitting it would change what the card renders (no row versus an empty row).
    if (isGap(frontmatter, key)) gaps.push(key);
    if (!Object.prototype.hasOwnProperty.call(frontmatter, key)) continue;
    // ⚠ THE CAST IS UNSOUND AND KEEPS ITS GUARD FOR A RUNTIME REASON. `parseFrontmatter`'s return type
    // says `string | string[]`, but the record is a plain `{}` and the value came from arbitrary note
    // text; the `hasOwnProperty` check above is what makes the read sound. Do not delete it because
    // tsc is happy — tsc never saw the note.
    fields[key] = frontmatter[key] as string | string[];
  }
  return { fields, gaps };
}

/**
 * THE ONE GAP RULE: a rubric key the record leaves absent, or answers with an empty string.
 *
 * ⚠ EXTRACTED AT STORY 2.7 SO IT IS STATED ONCE. That story gave the advisory a second field origin
 * (stdin), and two field origins with two inlined copies of "what counts as a gap" is a rule that drifts
 * on the first edit to either.
 * ⚠ MEMBERSHIP IS `hasOwnProperty.call`, NEVER truthiness and never `in`: the stdin/derived records are
 * `Object.create(null)` and a frontmatter record is a plain `{}`, so one read form has to be correct on
 * both — `in` walks the prototype chain and `!record[k]` passes on `toString` while failing on
 * `__proto__`.
 */
function isGap(record: Record<string, string | string[]>, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return true;
  return record[key] === "";
}

/**
 * The rubric keys a record of ALREADY-RESOLVED fields leaves unanswered — the advisory's `fields`-first
 * form (Story 2.7).
 *
 * ⚠ A SECOND ENTRY POINT, NOT A SECOND NOTION. It walks the SAME `rubricKeys` and applies the SAME
 * `isGap` rule as `deriveFenceFields`; what differs is only where the fields came from. The derivation
 * keeps its single pass — the property its own comment declares load-bearing — because this form is for
 * the origin that never had a frontmatter pass to ride on.
 */
function rubricGaps(fields: FenceFields, rubric: Rubric): string[] {
  return rubricKeys(rubric).filter((key) => isGap(fields, key));
}

/** The stdin arm's `DerivedFields`: fields already resolved by the codec, gaps measured against them. */
function fromBody(fields: FenceFields, rubric: Rubric): DerivedFields {
  return { fields, gaps: rubricGaps(fields, rubric) };
}

/**
 * The derivation's two outputs, from ONE frontmatter read.
 *
 * 🔴 THE GAPS RIDE THE SAME PASS AS THE FIELDS, AND THAT IS THE POINT. A separate `rubricGaps(markdown,
 * rubric)` was the first shape and it re-read the frontmatter — a SECOND read in the very path AC #1
 * exists to keep single, planted by the function whose job was to keep it single. It also gave "the
 * rubric's keys" two notions that could drift on the first edit to either. One pass, one read, one
 * notion.
 *
 * ⚠ `gaps` IS AN ADVISORY, NEVER A REFUSAL, and the PRD pins that: "a field absent in the note is
 * omitted gracefully, not rendered as `undefined`" (FR-5). `validate` agrees by construction — it
 * rejects only a missing or empty TITLE (`requireNonEmptyString`); an absent non-title rubric key
 * yields no row and an empty one yields an empty row, both `ok:true`. So this is where FR-9's "reports
 * the gap in the preview" actually lives; nothing in `core` will produce it, and it never changes an
 * exit code.
 */
export type DerivedFields = { fields: FenceFields; gaps: string[] };

/**
 * 🔴 THE NEWLINE CONTRACT, IN ONE FUNCTION. Getting it wrong destroys the fence on EVERY apply.
 *
 * The two sides do not meet: a located body CARRIES its trailing newline whenever it is non-empty
 * (`locateFence`'s `[bodyStart, bodyEnd)` excludes both delimiter LINES, and a line owns its own
 * terminator), while `serializeFenceBody` is a `.join("\n")` and emits NONE. Splicing raw codec output
 * therefore glues the closing ``` onto the last `key: value` line, and the fence stops being a fence —
 * the epic's headline promise, inverted.
 *
 * The empty case must stay `""` and not `"\n"`: an empty record has to splice back to
 * `bodyStart === bodyEnd`, i.e. to a fence whose two delimiter lines are adjacent.
 *
 * ⚠ IT MOVED HERE AT STORY 2.5, FROM `notekit-write.ts`, FOR THE REASON 2.2 STATED WHEN IT PUT IT
 * THERE — "it has exactly one caller". It now has two: the author-mode preview (this file) composes
 * the proposed block, and the write composes the bytes it lands. One contract, two halves, dependency
 * running one way ⇒ ONE owner, in the lower module. A second copy is precisely how a preview and the
 * write that follows it drift, which is what NK-4 rule 3 forbids. `notekit-write.ts` RE-EXPORTS it, so
 * every 2.2 import and every 2.2 test resolves unedited — the additive proof that this is a move and
 * not a rewrite. It is EXPORTED for the same reason 2.2 exported it: an inline expression inside the
 * write sequence would be untestable, and would leave the negative case (raw output breaks the fence)
 * with nothing to call.
 */
export function composeBody(fields: FenceFields): string {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    // (d) of the four input classes: a non-object never reaches the codec. The writer's only source of
    // fields is `parseFenceBody` output or `deriveFenceFields` output, both records — so this cannot
    // fire from the CLI, and it FAILS LOUD rather than emitting text if a later caller hands it
    // something else.
    throw new Error(`nk-fence compose: fields must be a record, got ${describeNonRecord(fields)}`);
  }
  const serialized = serializeFenceBody(fields);
  return serialized === "" ? "" : `${serialized}\n`;
}

/** A readable name for whatever was handed to `composeBody` in place of a record. */
function describeNonRecord(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/** An nk-fence OPENING line, anywhere in the note — the check `locateFence`'s `null` cannot make. */
const FENCE_OPENING_LINE = /^[ \t]*`{3,}[ \t]*nk-[a-z]+[ \t]*$/m;

/**
 * Everything author mode computes for a note that opted in and has no fence — the proposed block, the
 * spec it was validated against, and the rubric gaps the human still has to fill in.
 *
 * ONE COMPUTATION, TWO CALLERS, exactly as `RenderPlan` is: `render` previews it and `render --apply`
 * creates from it. `block` is the bytes both of them use — the preview prints it and the write inserts
 * it — so they cannot disagree.
 */
export type SeedPlan = {
  notePath: string;
  noteText: string;
  /** The authored info-string type — `card`, not `nk-card`. */
  type: string;
  fields: FenceFields;
  spec: RenderSpec;
  html: string;
  /** The WHOLE proposed block, delimiters included: there is no current body to diff against. */
  block: string;
  insertAt: number;
  /** Rubric keys the note leaves absent or empty. Information, never a refusal (FR-5). */
  gaps: string[];
};

/**
 * Compute the render plan: rows 1–6 of the exit table, in order, without printing a single result.
 *
 * Extracted from `runRender` at Story 2.2 with NO behaviour change — the usage lines, the codes, the
 * messages and the ORDER of the checks are 2.1's, byte for byte, and 2.1's tests staying green
 * UNEDITED is the proof of that.
 *
 * ⚠ STORY 2.5 NARROWED ROW 4 AND ADDED NO ROW. `locateFence → null` used to be one outcome; it is now
 * a fork whose refusal arm keeps 2.1's code, message and exit VERBATIM. See `seedPlan` for the three
 * conditions that have to hold before the other arm is taken, and why each one is a refusal rather
 * than an invention.
 */
export async function renderPlan(
  argv: string[],
  deps: NotekitReadDeps,
  err: (line: string) => void,
  /**
   * Story 2.7 — the `--body -` enrichment channel. When present, the FIELDS come from
   * `parseFenceBody(bodyOverride)` instead of from the note's own fence body (or, on the author arm,
   * instead of the frontmatter derivation). Only the codec's INPUT BYTES gain a second origin.
   *
   * 🔴 IT REPLACES THE FIELDS SOURCE, NEVER THE REGION SOURCE. `locateFence(noteText)` still runs, still
   * governs which bytes are replaced, and still produces the `type` that routes. A stdin body carries
   * CONTENT: it carries no offsets, no info string and no region. `--body -` selects the content ORIGIN;
   * the note's fence state selects the region OPERATION (`spliceFence` | `createFence`) — the flag never
   * chooses a terminal. Reading "body from stdin" as "region from stdin" is the ONE way this channel
   * could breach NK-4, so it is written here rather than left to be inferred.
   *
   * ⚠ `""` IS A REAL BODY and must arrive as `""`, never coalesced to `undefined`: an empty body parses
   * to `{}`, fails `validate` with `nk-missing-field`/`title` and exits `1` with the note untouched.
   * Mapping it to `undefined` would silently restore the note's own fence and turn that loud refusal
   * into a successful no-op.
   */
  bodyOverride?: string,
): Promise<PlanOutcome> {
  const notePath = notePositional(argv.slice(1));

  const at = valueFlag(argv, "at");
  if (at.present && at.value === undefined) {
    err(`std notekit render: --at needs an ISO timestamp\n\n${USAGE}`); // row 1
    return { kind: "usage" };
  }
  if (notePath === "") {
    err(`std notekit render: a <note> path is required\n\n${USAGE}`); // row 1
    return { kind: "usage" };
  }
  const registry = await resolveRegistry(argv, deps, err);
  if (registry === null) return { kind: "usage" }; // row 1

  const source = (deps.readNote ?? defaultReadNote)(notePath);
  if (source === null) {
    // row 2
    return {
      kind: "error",
      error: { code: "nk-note-unreadable", message: `cannot read note '${notePath}'` },
    };
  }

  // PRESENCE of a non-empty `nk-type` string, nothing more — the routing type comes from the fence, so
  // a disagreement between the two is not an error (NK-1.8 rule 2, the edge's `hasOptIn` rule).
  //
  // 🔴 THE SLICE'S ONLY FRONTMATTER READ. The record threads from here to the opt-in check AND to
  // `deriveFenceFields`; the block's `end` threads to the insertion point. Every other notion of "what
  // the frontmatter says" or "where it stops" is derived from THIS ONE MATCH — a second read is what
  // AC #1 forbids, and a second end-of-block pattern is what silently wrecked a note (see
  // `parseFrontmatterBlock`).
  const { fields: frontmatter, end: frontmatterEnd } = parseFrontmatterBlock(source);
  const optIn = Object.prototype.hasOwnProperty.call(frontmatter, OPT_IN_KEY)
    ? frontmatter[OPT_IN_KEY]
    : undefined;
  if (typeof optIn !== "string" || optIn.length === 0) {
    // row 3
    return {
      kind: "error",
      error: { code: "nk-no-opt-in", message: `note has no '${OPT_IN_KEY}:' frontmatter opt-in` },
    };
  }

  const fence = locateFence(source);
  if (fence === null) {
    // row 4 — FORKED at Story 2.5. `seedPlan` returns `null` for every case that is NOT authorable,
    // and each of those falls through to 2.1's refusal below, byte for byte.
    const seed = seedPlan(
      notePath,
      source,
      optIn,
      frontmatter,
      frontmatterEnd,
      registry,
      at.value ?? deps.now?.() ?? new Date().toISOString(),
      bodyOverride,
    );
    if (seed !== null) return seed;
    // ⚠ THE MESSAGE DISTINGUISHES THE REFUSAL ARMS; THE CODE DOES NOT, DELIBERATELY. A second code
    // would be a widening SM-C2 counts against, and 2.3's/2.4's error-code inventories pin the count.
    // But "note has no nk-fence" alone is a dead end for the arm author mode declined: the reader needs
    // to know whether the note is malformed or simply has nothing to seed from. Message text is not in
    // any sibling's inventory, so this costs nothing and answers the question.
    //
    // 🔴 THE THIRD ARM IS STORY 2.7'S, AND IT EXISTS BECAUSE THE TWO-ARM FORM STATED A FALSE CAUSE —
    // cross-vendor review finding (grok, 2026-08-06), reproduced before it was believed. With
    // `--body -` the seed's field source is STDIN, so condition 3 fails when the STDIN BODY answered no
    // rubric key. The frontmatter wording then blamed a frontmatter that may answer every key it has,
    // and an operator (or an agent) following it would "fix" the frontmatter forever while the real
    // repair is to pipe a body or drop the flag. That is the exact class this story's own apply-skill
    // text warns about for JSON-on-stdin — a refusal that names the wrong thing — reproduced one layer
    // down. ⚠ The unterminated-fence arm still wins: it is a fact about the NOTE and outranks both.
    return {
      kind: "error",
      error: {
        code: "nk-no-fence",
        message: FENCE_OPENING_LINE.test(source)
          ? "note has no nk-fence — an opening delimiter is present but never closed, so nothing was created over it"
          : bodyOverride !== undefined
            ? "note has no nk-fence, and the fence body read from stdin answers no key of the note type's rubric — nothing to seed one from"
            : "note has no nk-fence, and its frontmatter answers no key of the note type's rubric — nothing to seed one from",
      },
    };
  }

  const template = resolveTemplate(fence.type, registry);
  if (template === null) {
    // row 5
    return {
      kind: "error",
      error: { code: "nk-unknown-type", message: `no template registered for '${fence.type}'` },
    };
  }

  // THE ONE SUBSTITUTION POINT OF STORY 2.7, and it is the fields source. Everything around it —
  // `locateFence` above, `resolveTemplate`, `noteToRenderSpec`, `validate`, the diff, and the splice the
  // writer performs — is untouched by the override.
  const fields = parseFenceBody(bodyOverride ?? fence.body);
  const generatedAt = at.value ?? deps.now?.() ?? new Date().toISOString();
  const spec = noteToRenderSpec(fields, template.rubric, {
    id: `nk-${slugify(basename(notePath))}`,
    generatedAt,
  });

  const checked = validate(spec);
  if (!checked.ok) {
    return { kind: "error", error: checked.error }; // row 6 — the RenderSpecError VERBATIM
  }

  // The FR-16 parity signal: the note's own fence body against its canonical form. EMPTY when they are
  // equal. Reported, never enforced — `notekit lint` (3.1) is what fails a build on drift.
  //
  // ⚠ WITH A `--body -` OVERRIDE THIS STOPS BEING A PARITY DIFF AND BECOMES A REAL ONE, and that is the
  // observable difference Story 2.7 exists for. The "before" side is unchanged — still the note's
  // CURRENT `fence.body` — while the "after" side is now the composed stdin proposal. Without an
  // override the two sides are the note's body and its canonical form, which is the FR-16 signal that
  // was here before. One expression, two meanings, because only the fields source moved.
  const proposed = serializeFenceBody(fields);
  const diff = diffFenceBody(fence.body, proposed);

  return {
    kind: "plan",
    plan: {
      notePath,
      noteText: source,
      fence,
      fields,
      spec: checked.value,
      html: renderCardHtml(checked.value),
      proposedBody: proposed,
      diff,
    },
  };
}

/**
 * AUTHOR MODE — seed a fence for an opted-in note that has none (FR-8 half ii, NK-1.8 rule 3, NK-4
 * rule 2's one allowed structural add). Returns `null` when the note is NOT authorable, and every
 * `null` falls through to 2.1's `nk-no-fence` refusal unchanged.
 *
 * ⚠ THERE IS NO FLAG, AND THAT IS A CONSEQUENCE RATHER THAN A FLOURISH. A `--create`/`--author` flag
 * is a `SURFACE` edit, a `FROZEN_HELP` re-freeze, and a write-surface widening SM-C2 counts against —
 * and Story 2.4's gated apply surface pins the literal command a human types, which already reaches
 * here. Author mode is selected by the NOTE'S STATE.
 *
 * THREE CONDITIONS, EACH A REFUSAL WHEN IT FAILS:
 *
 *   1. 🔴 THE NOTE CARRIES NO nk-FENCE OPENING LINE AT ALL. `locateFence` returns `null` for "no fence"
 *      AND for "an UNTERMINATED fence", and it cannot tell the caller which. Creating a second fence in
 *      a note that already has an unterminated opening run would produce two opening delimiters and no
 *      matching close — CORRUPTION, from the one operation this epic allows to add structure. So the
 *      check is made independently, on the raw text, and an unterminated fence stays `nk-no-fence`.
 *
 *   2. THE OPT-IN TYPE RESOLVES TO A REGISTERED TEMPLATE. There is no fence, so the routing type is
 *      being AUTHORED, and its value is the `nk-type:` frontmatter — the ONE place that is true (in the
 *      transform path the routing type is the fence info string, NK-1.8 rule 2). An unregistered type
 *      is `nk-unknown-type`, 2.1's row 5 code unchanged, NOT an invented rubric and NOT a default
 *      template: NFR5 generates the capabilities catalog from THIS registry, so a type absent from it
 *      is one notewright was never told about.
 *
 *   3. ⚠ THE FRONTMATTER ANSWERS AT LEAST ONE RUBRIC KEY. A note whose frontmatter carries nothing the
 *      rubric asks for has NOTHING TO SEED FROM, so there is no fence to author and the honest verdict
 *      is 2.1's `nk-no-fence` — unchanged, including for the bare `---\nnk-type: card\n---` note that
 *      2.1's and 2.2's own row-4 fixtures use, which is why both stay green UNEDITED.
 *      ⚠ THIS CONDITION IS A DECISION THIS STORY MAKES BECAUSE NO SOURCE MAKES ONE, and it is the
 *      thing that lets row 4 fork at all: the story's stated trigger ("no fence + opt-in present")
 *      matches those sibling fixtures exactly, so taking it literally would have flipped two sibling
 *      regressions the story requires to stay green. Emptiness of the derivation is the natural
 *      discriminator — author mode exists to carry frontmatter INTO a fence, and here there is none to
 *      carry. It is NOT a required-field check: a note that answers one key and gaps the rest IS
 *      authored, with the gaps reported (AC #6 row iii), and a note that answers a non-title key but
 *      gaps the TITLE is authored and then REFUSED by `validate` (row 6) — which is what makes the
 *      validate-before-write ordering observable at all.
 *
 * THE ORDER IS PINNED and it is the ordering proof: derive → `noteToRenderSpec` → `validate` → only on
 * `ok:true` → compose → `createFence`. Nothing is composed before the spec is validated, so a note
 * whose title is missing or empty exits `1` through row 6 with the note byte-identical — no fence was
 * created. If `validate` ran after the write, that note would carry a fence.
 */
function seedPlan(
  notePath: string,
  source: string,
  optIn: string,
  frontmatter: Record<string, string | string[]>,
  frontmatterEnd: number,
  registry: NoteTypeRegistry,
  generatedAt: string,
  /**
   * Story 2.7 — the created fence's body comes from stdin instead of from the frontmatter derivation.
   *
   * ⚠ HONOURING IT ON THIS ARM IS A RULED DECISION, not a story-level one (architect 2026-08-06, spine
   * NK-8 rule 1 amended): a fenceless note honours `--body -` and the pipeline terminates at
   * `createFence`. `--body -` selects the content ORIGIN; the note's fence state selects the region
   * OPERATION. Refusing the combination would buy no safety — rubric projection, `validate` and
   * refusal-on-invalid run identically on both terminals — while IGNORING it would be the silent no-op
   * at exit `0` that NK-8 rule 2 forbids by name.
   *
   * ⚠ ROUTING STILL NEVER COMES FROM STDIN: conditions 1 and 2 below are unchanged, so a fenceless note
   * with no resolvable `nk-type` still refuses exactly as it did before the flag existed.
   */
  bodyOverride?: string,
): PlanOutcome | null {
  if (FENCE_OPENING_LINE.test(source)) return null; // 1 — unterminated fence: refuse, never create

  const template = resolveTemplate(optIn, registry);
  if (template === null) {
    // 2 — row 5's code, on the authored type rather than a located one
    return {
      kind: "error",
      error: { code: "nk-unknown-type", message: `no template registered for '${optIn}'` },
    };
  }

  // ⚠ THE ADVISORY'S INPUT IS REROUTED TO THE FINAL FIELDS, AND NOTHING MORE (Story 2.7). With a stdin
  // body the frontmatter is no longer the field source, so a frontmatter-keyed advisory would name keys
  // the written fence does not reflect. Both arms go through `rubricGaps`, which walks the SAME
  // `rubricKeys` and applies the SAME gap rule as the derivation — one notion of "what this note type
  // wants", one notion of "a gap", two field origins.
  // ⚠ CONDITION 3 IS EVALUATED OVER THE FINAL FIELDS TOO. Author mode exists to carry content into a
  // first fence; with `--body -` that content is the stdin body, so an empty one has nothing to seed
  // from and refuses through 2.1's `nk-no-fence` exactly as an unanswering frontmatter does.
  const derived: DerivedFields =
    bodyOverride === undefined
      ? deriveFenceFields(frontmatter, template.rubric)
      : fromBody(parseFenceBody(bodyOverride), template.rubric);
  const { fields, gaps } = derived;
  if (Object.keys(fields).length === 0) return null; // 3 — nothing to seed from

  const spec = noteToRenderSpec(fields, template.rubric, {
    id: `nk-${slugify(basename(notePath))}`,
    generatedAt,
  });

  const checked = validate(spec);
  if (!checked.ok) {
    // row 6 — the RenderSpecError VERBATIM, BEFORE anything is composed. This is the ordering proof.
    return { kind: "error", error: checked.error };
  }

  // THE INSERTION POINT IS THE PARSER'S OWN BLOCK END, threaded from the one match `renderPlan` made.
  // It is never recomputed here: a caller-side pattern for "where the frontmatter stops" disagreed with
  // the parser on a glued closing delimiter and put the fence BEFORE the opening `---`, destroying the
  // opt-in on a note every other check had passed. See `parseFrontmatterBlock`.
  const insertAt = frontmatterEnd;
  const seeded = createFence(source, optIn, composeBody(fields), insertAt);
  const located = locateFence(seeded)!;

  return {
    kind: "seed",
    seed: {
      notePath,
      noteText: source,
      type: optIn,
      fields,
      spec: checked.value,
      html: renderCardHtml(checked.value),
      // The block is read back OUT of the seeded note through `locateFence` rather than re-assembled
      // from its parts, so the bytes the preview prints are the bytes the note will carry — one
      // computation, and an off-by-one in the framing shows up in the preview instead of on disk.
      block: seeded.slice(located.blockStart, located.blockEnd),
      insertAt,
      gaps,
    },
  };
}

/**
 * The author-mode payload, in the ONE shape both output modes render from (the rule 2.1 applies to
 * `capabilities` and 2.2 applies to its diff). `diff` carries the whole proposed block — 2.2's
 * transform preview diffs the current body against its canonical form, and that diff is meaningless
 * here because the "before" side is empty. `gaps` is the only key 2.2's payload did not have, and it
 * is ADDITIVE: no new code, no new flag, no new envelope variant. Without it, FR-9's "reports the gap
 * in the preview" is unsatisfiable under `--json`, where NK-7 rule 2 makes the envelope the only thing
 * on stdout.
 */
export function seedValue(seed: SeedPlan, written?: boolean): Record<string, unknown> {
  const value: Record<string, unknown> = {
    html: seed.html,
    diff: seed.block,
    spec: seed.spec,
    gaps: seed.gaps,
  };
  if (written !== undefined) value.written = written;
  return value;
}

/**
 * `render <note>` — preview a note as an nk-card and report the round-trip diff. Writes nothing.
 *
 * SEVEN ROWS, THREE RETURNS — the two counts are different things and the docblock used to conflate
 * them. `renderPlan` computes the rows (Story 2.2 extracted it); this function maps them to exit codes:
 * `usage` → `2` WITHOUT calling `emit`, because `renderPlan` already wrote the usage line to stderr;
 * `error` → `1` through `emit` (five failure rows, each carrying a typed `code`); `plan` → `0` through
 * `emit`. So every RESULT rides the envelope, and the one return that does not is the one that has no
 * result to carry.
 *
 * `render --apply` (Story 2.2) calls `renderPlan` too — one computation, so the preview and the write
 * cannot disagree.
 */
async function runRender(argv: string[], deps: NotekitReadDeps): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const json = hasFlag(argv, "json");

  const outcome = await renderPlan(argv, deps, err);
  if (outcome.kind === "usage") return 2; // row 1 — the line is already on stderr
  if (outcome.kind === "error") {
    emit({ ok: false, error: outcome.error }, json, log, err);
    return 1; // rows 2–6
  }

  // AUTHOR MODE, PREVIEW ONLY (Story 2.5, AC #4). `--apply` is opt-in and this path is not it: the
  // vault is byte-untouched, and this function holds no writer to touch it with. The preview shows the
  // WHOLE proposed block because there is no current body to diff against.
  if (outcome.kind === "seed") {
    emit({ ok: true, value: seedValue(outcome.seed) }, json, log, err);
    return 0; // row 7
  }

  const { html, diff, spec } = outcome.plan;
  emit({ ok: true, value: { html, diff, spec } }, json, log, err);
  return 0; // row 7
}

/**
 * The proposed-body diff, as a fenced unified-ish block — or the EMPTY STRING when the body is already
 * canonical. Emptiness is the signal, so it is computed rather than described.
 *
 * The comparison normalizes the current body's line endings before splitting, because
 * `serializeFenceBody` always emits LF: without that a CRLF note would report every line as changed
 * and the "canonical" case would be unreachable for half the corpus.
 */
function diffFenceBody(current: string, proposed: string): string {
  const currentBody = current.replace(/\r\n|\r/g, "\n").replace(/\n$/, "");
  if (currentBody === proposed) return "";
  const lines = ["```diff"];
  for (const line of currentBody.split("\n")) lines.push(`-${line}`);
  for (const line of proposed.split("\n")) lines.push(`+${line}`);
  lines.push("```");
  return lines.join("\n");
}

/**
 * `validate --spec -` — check a candidate RenderSpec read from stdin, and return the Result union.
 *
 * ⚠ Unusable stdin is a USAGE error, never `ok:false`. `readStdinJson` collapses empty, malformed and
 * timed-out input into one `null`, and a validation verdict on input that never arrived would be a lie.
 * A literal JSON `null` is indistinguishable from those by that reader and takes the same path —
 * declared here, not silently absorbed.
 */
async function runValidate(argv: string[], deps: NotekitReadDeps): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const json = hasFlag(argv, "json");

  // `-` is the whole v1 grammar. A future `--spec <file>` is a later widening, made deliberately.
  const spec = valueFlag(argv, "spec");
  if (!spec.present || spec.value !== "-") {
    err(`std notekit validate: --spec - is required (stdin is the only source)\n\n${USAGE}`);
    return 2;
  }

  const candidate = await (deps.readStdin ?? (() => readStdinJson()))();
  if (candidate === null) {
    err("std notekit validate: no usable JSON on stdin (empty, malformed, or timed out)");
    return 2;
  }

  const result = validate(candidate);
  // Both forms render from the ONE Result value — never two code paths reaching two shapes.
  emit(result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error }, json, log, err);
  return result.ok ? 0 : 1;
}

/**
 * `capabilities` — the generated catalog of declared note types (FR-11, NFR5).
 *
 * IT HAS NO FAILURE VERDICT — a property, not an omission. Every malformed registry class DEGRADES in
 * the generator (a non-object yields an empty `noteTypes`; an unresolvable entry is omitted), so there
 * is nothing for it to report as failed: its own returns are `0` and the usage `2` from a missing or
 * unloadable `--config`.
 *
 * ⚠ That is NOT the same as "the exit set is {0,2}", which is how this read before the 2.1 code review
 * and was strictly false: a caller's config is arbitrary TypeScript, so a throwing GETTER survives the
 * load and raises from INSIDE `capabilities(registry)`, and that unmodelled fault exits `1` through
 * `runNotekitRead`'s fail-loud catch. A `1` here therefore means a crash, never a verdict — and the
 * distinction is the whole point, because the first phrasing would have made the fail-loud fix look
 * like a regression. (A Proxy registry is a different case and exits `2`: `await`ing any object reads
 * `.then`, so it raises during the load and never reaches the generator. Both are pinned by tests.)
 */
async function runCapabilities(argv: string[], deps: NotekitReadDeps): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const json = hasFlag(argv, "json");

  const registry = await resolveRegistry(argv, deps, err);
  if (registry === null) return 2;

  emit({ ok: true, value: capabilities(registry) }, json, log, err);
  return 0;
}

/**
 * Dispatch the read surface. Returns a process exit code; `main.ts` routes the three known verbs here.
 *
 * A THROW MUST NOT ESCAPE. The seven rows are RETURNS; a throw would be an eighth path outside the
 * envelope, and `main.ts` would surface it as an unhandled rejection rather than an exit code. Two are
 * genuinely reachable — `cardTree` throws on a non-object spec, and `await import(config)` throws on a
 * module that fails at load — so the whole dispatch is wrapped and every escape lands on a usage exit.
 */
export async function runNotekitRead(
  argv: string[],
  deps: NotekitReadDeps = {},
): Promise<number> {
  const err = deps.err ?? ((l: string) => console.error(l));
  const [sub, ...rest] = argv;

  // `dispatchAsync`'s third parameter is REQUIRED — there is no two-arg form — so this arm cannot be
  // dropped. It is also unreachable from `main.ts` (only the three known verbs route in), which makes
  // it green by construction unless a test exercises it directly. One does.
  const onUnknown = (name: string): number => {
    err(name === "" ? USAGE : `std notekit: unknown subcommand '${name}'\n\n${USAGE}`);
    return 2;
  };

  try {
    return await dispatchAsync(
      sub ?? "",
      {
        render: () => runRender([sub ?? "", ...rest], deps),
        validate: () => runValidate(rest, deps),
        capabilities: () => runCapabilities(rest, deps),
      },
      onUnknown,
    );
  } catch (e) {
    // FAIL-LOUD `1`, NOT a usage `2`. Everything that reaches here is an UNMODELLED internal fault —
    // the modelled failures already returned through the envelope, and an unloadable `--config` (the
    // one genuinely-usage throw) is caught by `resolveRegistry` and returns 2 there. Reporting a crash
    // as "usage" tells the user they typed something wrong when they did not.
    //
    // The story prescribed routing every escape onto "row 1", which is the usage 2 — but the precedent
    // it cites for the shape, `src/bmad/cli.ts`, returns **1** for a classified fault and RE-THROWS an
    // unclassified one. Re-throwing is not available here (`main.ts` would surface it as an unhandled
    // rejection rather than an exit code, which is exactly what the no-escape rule forbids), so this
    // takes the other half of that precedent: report, and exit 1 per the estate's contract at
    // `main.ts` — 0 ok, 1 fail-loud, 2 usage.
    err(`std notekit: ${errorText(e)}`);
    return 1;
  }
}
