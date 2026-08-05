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
  parseFrontmatter,
  slugify,
} from "../core/index";
import {
  capabilities,
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
  "  render <note> --config <path> [--at <iso>] [--json]   preview a note as an nk-card; writes nothing",
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

/** The human rendering of a success payload — one shape per verb, never a second renderer. */
function humanValue(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  const record = value as Record<string, unknown>;

  if (typeof record.html === "string") {
    const diff = typeof record.diff === "string" ? record.diff : "";
    // The diff's EMPTINESS is the FR-16 parity signal — reported here, never enforced. Enforcement is
    // `notekit lint`, Story 3.1.
    return diff.length === 0
      ? `${record.html}\n\n✓ fence body is canonical (FR16 parity holds)`
      : `${record.html}\n\n${diff}`;
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
 * ⚠ THIS MUST MATCH the `arity: "value"` flags declared for notekit's read verbs in `surface.ts`. A
 * flag added there and missed here silently eats the `<note>` positional — the exact defect
 * `notePositional` exists to fix, re-introduced by omission. Exported so `notekit-read.test.ts` can
 * assert the two agree: `check:surface-drift` will NOT catch this (it checks that every flag READ is
 * declared, not that this set is complete), so the drift gate for it is that test. A comment would not
 * have gone red.
 */
export const VALUE_FLAGS = new Set(["config", "at", "spec"]);

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
    err(`std notekit: cannot load the note-type registry — ${(e as Error).message}`);
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
  | { kind: "usage" }
  | { kind: "error"; error: unknown };

/**
 * Compute the render plan: rows 1–6 of the exit table, in order, without printing a single result.
 *
 * Extracted from `runRender` at Story 2.2 with NO behaviour change — the usage lines, the codes, the
 * messages and the ORDER of the checks are 2.1's, byte for byte, and 2.1's tests staying green
 * UNEDITED is the proof of that.
 */
export async function renderPlan(
  argv: string[],
  deps: NotekitReadDeps,
  err: (line: string) => void,
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
  const frontmatter = parseFrontmatter(source);
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
    // row 4
    return { kind: "error", error: { code: "nk-no-fence", message: "note has no nk-fence" } };
  }

  const template = resolveTemplate(fence.type, registry);
  if (template === null) {
    // row 5
    return {
      kind: "error",
      error: { code: "nk-unknown-type", message: `no template registered for '${fence.type}'` },
    };
  }

  const fields = parseFenceBody(fence.body);
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
 * `render <note>` — preview a note as an nk-card and report the round-trip diff. Writes nothing.
 *
 * Seven returns, and every one goes through `emit`: one usage path (`2`), five failure rows (`1`, each
 * carrying a typed `code`), one success (`0`). No row falls out of the envelope. The rows themselves
 * are computed by `renderPlan`, which `render --apply` (Story 2.2) calls too — one computation, so the
 * preview and the write cannot disagree.
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
    err(`std notekit: ${(e as Error).message ?? String(e)}`);
    return 1;
  }
}
