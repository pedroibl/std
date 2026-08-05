// Story 2.2 — the notekit CLI WRITE surface: `render <note> --apply`, the SOLE filesystem writer of
// note bytes (NK-4 rule 1). Bun edge — `node:*` is allowed here; only `core` is pure (D1).
//
// THIS FILE IS THE ONE PERMITTED WRITE SITE IN THE WHOLE SLICE, and that is checkable rather than
// asserted: `src/notekit/sole-writer.test.ts` globs `src/notekit/**/*.ts` + `src/cli/notekit-*.ts`,
// masks strings and comments, and requires that EXACTLY ONE file carries a banned write CALL and that it
// carries EXACTLY ONE. Not "at most one" — an upper bound would pass on a writer that was never wired.
//
// WHAT MAKES PROSE INVIOLABLE IS A CODE PATH, NOT A PROMPT. The only thing that composes note text is
// `spliceFence` (`../notekit/core-fence`), one pure three-slice concat over `[bodyStart, bodyEnd)`, so
// every byte outside the located fence is identical by CONSTRUCTION (NK-4 rule 2). Nothing else in this
// module builds note text.
//
// IT IMPORTS ONLY THE PURE HALF of the notekit slice (`../notekit/index`), NEVER `../notekit/edge/**`.
// This file is root-typechecked and the root tsconfig has no DOM lib by design — a single edge import
// drags `HTMLElement` in and fails `bun run typecheck` with TS2304, and `import type` does not dodge it
// (Story 1.4 ⚠️-1, proven there). Concretely: `locateFence`/`spliceFence` from the codec, NEVER
// `edge/post-processor.ts`'s `findFence`, which walks a rendered DOM tree and could not locate a byte
// in a file even if importing it were legal.
//
// THE DEPENDENCY RUNS ONE WAY: this module imports `./notekit-read`, never the reverse. The read
// surface's own AC #4 gate (Story 2.1) scans it for write tokens, so putting the writer there would
// have meant deleting a gate to make a story pass.
//
// IDENTITY-FREE (D4/NFR3): no vault path, no vault name, no note-type literal. Every path arrives as
// `--config` or as the `<note>` positional.

import { hasFlag } from "../core/index";
import { atomicWrite, readIfExists } from "../fsx";
import { serializeFenceBody, spliceFence, type FenceFields } from "../notekit/index";
import { emit, errorText, renderPlan, type NotekitReadDeps } from "./notekit-read";

/**
 * The write-path failure codes, new to this story. EDGE-level, never in `core`: "the file changed under
 * me" is a fact about a filesystem, which `core` may not know about. Rows 2–6 keep Story 2.1's codes
 * VERBATIM and are not restated here.
 */
export type NotekitWriteErrorCode =
  | "nk-note-changed"
  | "nk-write-failed"
  | "nk-write-unverified";

/** Every effect injectable, so the whole path is unit-testable with no real fs and no clock. */
export interface NotekitApplyDeps extends NotekitReadDeps {
  /**
   * ⚠ DEFAULTS TO THE REAL `atomicWrite`, AND THE DEFAULT IS EXERCISED BY THE SUITE. A writer that only
   * ever runs injected means the single permitted write site is never executed, and the sole-writer gate
   * would be guarding dead code. `notekit-write.test.ts` drives the default against a tmp dir.
   */
  writeNote?: (path: string, content: string) => void;
}

/** A future code that ships without a branch is a COMPILE error, not a silent fall-through. */
function assertNever(code: never): never {
  throw new Error(`std notekit: unhandled write error code '${String(code)}'`);
}

/** The one human sentence per write-failure code — read from the code, never hand-written per site. */
function writeErrorMessage(code: NotekitWriteErrorCode, notePath: string, detail: string): string {
  switch (code) {
    case "nk-note-changed":
      return `note '${notePath}' changed on disk between the preview and the write — nothing written`;
    case "nk-write-failed":
      return `cannot write note '${notePath}' — ${detail}`;
    case "nk-write-unverified":
      return `wrote '${notePath}' but the bytes read back are not the bytes written — the note may be neither its old nor its new content`;
    default:
      return assertNever(code);
  }
}

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
 * ⚠ IT LIVES HERE, NOT IN `core-fence.ts`. It has exactly one caller, so D2's Rule of Three says it has
 * not earned a home in the pure module — and keeping it edge-side keeps the codec's exported surface to
 * the things 2.1 and 2.2 genuinely contract on. It is EXPORTED so the test can call it directly: an
 * inline expression inside the write sequence would be untestable and would leave the negative case
 * (raw output breaks the fence) with nothing to call.
 */
export function composeBody(fields: FenceFields): string {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    // (d) of the four input classes: a non-object never reaches the codec. The writer's only source of
    // fields is `parseFenceBody`, which always returns a record — so this cannot fire from the CLI, and
    // it FAILS LOUD rather than emitting text if some later caller hands it something else.
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

/**
 * `render <note> --apply` — preview, then splice the fence body and write the note atomically.
 *
 * THE SEQUENCE IS `src/cli/edge-deploy.ts`'s WRITE DISCIPLINE, CLONED (never imported — `EdgeSpec` has
 * no concept of a second subcommand): re-read before writing, skip on an identical byte compare, write
 * atomically, then read back and verify. The reason it states for the last step holds here word for
 * word: never claim a write we did not confirm landed.
 *
 * TEN OUTCOMES (AC #5), of which this function owns nine — `--apply` on a non-`render` verb is a usage
 * `2` from `main.ts`'s guard and never enters here at all:
 *   1  usage (no `<note>`, missing/unloadable `--config`, a value flag with no value)  → 2, no JSON
 *   2  note unreadable            → 1  nk-note-unreadable      (Story 2.1's row, re-used)
 *   3  no `nk-type:` opt-in       → 1  nk-no-opt-in            (       "                )
 *   4  no locatable fence         → 1  nk-no-fence             (       "                )
 *   5  unknown note type          → 1  nk-unknown-type         (       "                )
 *   6  the spec does not validate → 1  RenderSpecError VERBATIM(       "                )
 *   7  the note changed on disk   → 1  nk-note-changed         — nothing written
 *   8  the write threw            → 1  nk-write-failed         — `fsx` removed its temp
 *   9  the read-back differs      → 1  nk-write-unverified     — the ONE row that cannot promise the
 *                                                                pre-state, and says so
 *  10  success                    → 0  written: true | false
 *
 * ⚠ ROW 9'S HONESTY IS DELIBERATE. "On every failure the note is byte-identical" would be FALSE here:
 * once the rename has landed the pre-state is gone by definition. Row 9 reports a state it cannot
 * guarantee rather than pretending it can.
 */
export async function runNotekitApply(
  argv: string[],
  deps: NotekitApplyDeps = {},
): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const json = hasFlag(argv, "json");

  // ⚠ THE READER IS ASYMMETRIC ON PURPOSE, and the asymmetry is the point. The PLAN's read models an
  // unreadable note as an OUTCOME (2.1's row 2, a blanket catch → `null`). The two reads below are
  // internal consistency checks — "did the file change under me", "did my bytes land" — where a real
  // fs fault must SURFACE rather than be classified as "changed" or "unverified". `readIfExists` softens
  // ENOENT only and re-throws everything else, which is exactly that posture.
  const readBack = deps.readNote ?? readIfExists;

  try {
    // ── 1. the plan, computed ONCE by the read surface and shared with the preview ────────────────
    const outcome = await renderPlan(argv, deps, err);
    if (outcome.kind === "usage") return 2; // row 1 — the line is already on stderr
    if (outcome.kind === "error") {
      emit({ ok: false, error: outcome.error }, json, log, err);
      return 1; // rows 2–6
    }
    const plan = outcome.plan;

    // ── 2. the preview, BEFORE anything is written (NK-4 rule 3) ──────────────────────────────────
    // ⚠ Under `--json` the preview cannot PRECEDE the write in print order, and pretending otherwise
    // would make this AC unsatisfiable: NK-7 rule 2 makes the envelope the only thing on stdout, and it
    // is one object emitted once, at the end. So `--json` satisfies rule 3 by PROVENANCE — `value.diff`
    // is computed from the plan's pre-write bytes, the same bytes the write is composed from, and it is
    // the byte-identical twin of a preview-only run's `diff`. Without `--json` the ordering claim is
    // literal, and this is the line that makes it so.
    if (!json) emit({ ok: true, value: { html: plan.html, diff: plan.diff, spec: plan.spec } }, false, log, err);

    // ── 3. compose the next note — the ONLY place note text is built ──────────────────────────────
    const next = spliceFence(plan.noteText, plan.fence, composeBody(plan.fields));

    // ── 4. re-read: did the note change under us? ─────────────────────────────────────────────────
    // `null` (the note was deleted) and "different bytes" are the SAME outcome and the same code — a
    // note that vanished has changed. `readIfExists` cannot tell "deleted" from "never existed", but it
    // existed at step 1, so "changed" is the honest verdict.
    const current = readBack(plan.notePath);
    if (current === null || current !== plan.noteText) {
      return failWrite("nk-note-changed", plan.notePath, "", json, log, err);
    }

    // ── 5. idempotence: a byte no-op writes NOTHING AT ALL ────────────────────────────────────────
    // ⚠ A RAW STRING COMPARE, and `core.contentHash` is FORBIDDEN for it: that is a dedup hash — it
    // collapses whitespace, lowercases, and truncates to 400 characters before hashing, so a
    // whitespace-only change, a case-only change, or any change past character 400 hashes identically
    // and this gate could not go red.
    // ⚠ Compared against `current`, not a third read: step 4 already established that the file equals
    // `plan.noteText`, so re-reading would cost a syscall and open a second TOCTOU window for nothing.
    if (current === next) return succeed(plan, false, json, log, err);

    // ── 6. the write — the ONE permitted call site in the slice ───────────────────────────────────
    try {
      // ⚠ WRITTEN AS AN IF/ELSE, NOT AS `deps.writeNote ?? atomicWrite`. The sole-writer gate counts
      // CALL forms; an aliased `const w = deps.writeNote ?? atomicWrite; w(…)` is one of the residual
      // escapes that gate declares, and taking it here would leave the gate counting zero real sites in
      // the only file allowed to have one.
      if (deps.writeNote) deps.writeNote(plan.notePath, next);
      else atomicWrite(plan.notePath, next);
    } catch (e) {
      // `errorText`, NEVER `(e as Error).message ?? String(e)`: the property read precedes the `??`, so
      // a `writeNote` that threw `null` raised a TypeError out of THIS catch — the envelope was lost and
      // the caller read the TypeError's text where `nk-write-failed` should have been. See `errorText`.
      return failWrite("nk-write-failed", plan.notePath, errorText(e), json, log, err);
    }

    // ── 7. read back: never claim a write we did not confirm landed ───────────────────────────────
    if (readBack(plan.notePath) !== next) {
      return failWrite("nk-write-unverified", plan.notePath, "", json, log, err);
    }

    // ── 8. success ────────────────────────────────────────────────────────────────────────────────
    return succeed(plan, true, json, log, err);
  } catch (e) {
    // FAIL-LOUD `1`, INHERITED FROM 2.1 UNCHANGED — not a new outcome. `runNotekitRead` wraps its own
    // dispatch in exactly this catch for exactly this reason: an unmodelled throw (a caller `--config`
    // that raises from inside the generator, `readIfExists` re-throwing a permission fault) must become
    // an exit code, because `main.ts` would otherwise surface it as an unhandled rejection rather than a
    // code. This path deliberately does NOT re-classify anything the plan already modelled — those
    // returned through the envelope above.
    //
    // ⚠ AND IT FORMATS THROUGH `errorText`. This is the LAST catch on the path, so the old
    // `(e as Error).message ?? String(e)` failed exactly where it mattered most: a thrown `null` or
    // `undefined` reaching here — `readIfExists` re-throwing a non-ENOENT fault, a caller `--config`
    // raising a non-Error — made the property read itself throw, and the TypeError left
    // `runNotekitApply` entirely. The fail-loud `1` this block promises was never returned.
    err(`std notekit: ${errorText(e)}`);
    return 1;
  }
}

/** Row 10 — the success envelope, and the single human result line that follows the preview. */
function succeed(
  plan: { html: string; diff: string; spec: unknown; notePath: string },
  written: boolean,
  json: boolean,
  log: (line: string) => void,
  err: (line: string) => void,
): number {
  if (json) {
    // ONE result object, both forms — the same rule `capabilities` follows. `written` rides the
    // envelope; the human form prints it as its own line rather than re-rendering the payload.
    emit(
      { ok: true, value: { html: plan.html, diff: plan.diff, spec: plan.spec, written } },
      true,
      log,
      err,
    );
    return 0;
  }
  log(written ? `✓ wrote ${plan.notePath}` : "✓ already current, nothing written");
  return 0;
}

/** Rows 7–9 — every write failure through the ONE envelope, with the code the caller branches on. */
function failWrite(
  code: NotekitWriteErrorCode,
  notePath: string,
  detail: string,
  json: boolean,
  log: (line: string) => void,
  err: (line: string) => void,
): number {
  emit({ ok: false, error: { code, message: writeErrorMessage(code, notePath, detail) } }, json, log, err);
  return 1;
}
