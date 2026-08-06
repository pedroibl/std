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
import { createFence, spliceFence } from "../notekit/index";
import {
  composeBody,
  emit,
  errorText,
  renderPlan,
  seedValue,
  type NotekitReadDeps,
} from "./notekit-read";

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
  /**
   * The `--body -` channel's stdin read (Story 2.7). Defaults to `readStdinText`, and THE DEFAULT IS
   * EXERCISED BY THE SUITE through a real piped subprocess — a fully-injected reader would leave the
   * timeout and listener-detach discipline below guarding dead code.
   *
   * ⚠ A NEW MEMBER, NOT A RENAME OF `readStdin`. `NotekitReadDeps.readStdin` returns PARSED JSON for
   * `validate --spec -`; this one returns raw TEXT and distinguishes `""` from `null`. Two contracts,
   * two members — reusing one name is how a JSON reader ends up on the text path.
   */
  readBody?: () => Promise<string | null>;
}

/**
 * The hang-guard, in milliseconds. ⚠ A HANG-GUARD, NOT A THROUGHPUT BUDGET, and the difference is the
 * failure mode: the race is against the stream's `end`, so a producer that has not finished within it
 * resolves `null` and the run exits `2` — a refusal of a body that was on its way. Acceptable here,
 * because a fence body is a handful of `key: value` lines from a local heredoc and the alternative (no
 * timeout) is a CLI that hangs forever when `--body -` is typed at a terminal with nothing piped. A
 * caller needing more passes `deps.readBody`; a `--body-timeout` flag would be a surface widening for a
 * hypothetical.
 *
 * ⚠ HARDCODED WITH ITS CITATION rather than deep-imported. It matches `DEFAULT_STDIN_TIMEOUT_MS`
 * (`src/stdio/read.ts:25`, *"generous … so a slow harness under load does not race to a false `null`"*),
 * but `src/stdio/index.ts:4` exports only `readStdinJson` — reaching that const means importing a
 * module's private surface across a slice boundary for one integer.
 */
const STDIN_TIMEOUT_MS = 1000;

/**
 * Read the process's own stdin fully as TEXT (Story 2.7, NK-8 rule 1). Resolves the accumulated string —
 * `""` for a readable-but-empty stream, which is a legitimate (if invalid) fence body — or `null` ONLY on
 * timeout or a stream error, which is the unreadable case.
 *
 * 🔴 DELIBERATELY NOT `stdio.readStdinJson`, AND THIS IS A SOURCE FACT RATHER THAN A PREFERENCE. That
 * reader `JSON.parse`s (`src/stdio/read.ts:62`) and collapses **empty** (`:59-60`), **malformed** (`:64`)
 * and **timeout** (`:85`) into ONE `null`. A fence body is text (`title: T`, not JSON), and this caller
 * must tell `""` from "nothing": a readable-but-empty body is a real body that reaches the codec and
 * fails loud at `validate` with `nk-missing-field`, while an unreadable stdin is a usage error. One
 * `null` cannot carry both.
 *
 * ⚠ IT LIVES HERE, NOT IN `src/stdio/`, ON FOUR FACTS (story ⚠️-3): that slice declares itself
 * JSON-scoped and exports exactly one symbol (`src/stdio/index.ts:1-4`); it carries an explicit
 * anti-speculation posture (AD-9.4 Rule 1.3, `read.ts:19-22`); `"./stdio"` is a PUBLISHED subpath, so an
 * addition there is a public-API change to `@pedroibl/std` made for one internal caller; and D2's Rule
 * of Three is unmet with one caller.
 * **THE PROMOTION TRIGGER IS NAMED AND DATED: Epic 3 Story 3.5** (`notekit new <path> --type <t>
 * --body -`, NK-9) is the SECOND caller of a text stdin read. When 3.5 lands, move this to `src/stdio/`
 * and refactor `readJsonFromStream` to compose it, so the race discipline has one home. Do not write a
 * third copy.
 */
export function readStdinText(timeoutMs = STDIN_TIMEOUT_MS): Promise<string | null> {
  return readTextFromStream(process.stdin, timeoutMs);
}


/**
 * The stream-injected core of `readStdinText`, split out so it is testable against a mock `Readable`
 * without touching the real `process.stdin` — the same split `readJsonFromStream` makes for the JSON
 * twin, and for the same reason.
 *
 * 🔴 THE RACE DISCIPLINE IS `readJsonFromStream`'s (`src/stdio/read.ts:47-91`), CLONED: one `settled`
 * guard so the FIRST of `{end, timeout, error}` wins, `clearTimeout`, and — not decoration — DETACH all
 * three listeners and `pause()` the stream on resolution. That reader's own comment (`:69-73`) records
 * why: a flowing `process.stdin` left attached keeps the event loop ref'd, so a CLI that RETURNS a code
 * rather than `process.exit`ing hangs. `main.ts` returns codes and only the bin exits
 * (`if (import.meta.main)`), so this CLI is exactly that caller. Do not "simplify" to `Bun.stdin.text()`.
 *
 * 🔴 AND `onEnd` IS `finish(data)` — THE ACCUMULATED STRING, VERBATIM, EMPTY OR NOT. "Clone it minus the
 * parse" is TWO deletions, not one: the JSON twin's `onEnd` opens with `const text = data.trim(); if
 * (!text) return finish(null);` BEFORE the parse, so a clone that drops only `JSON.parse` keeps the
 * empty-collapse and an empty stdin resolves `null` — re-creating the exact "cannot tell `''` from
 * nothing" defect this reader exists to avoid, and making a readable-but-empty body untestable. `null`
 * comes from the timeout and the `error` listener and from NOWHERE ELSE.
 *
 * ⚠ AND IT DOES NOT TRIM THE PAYLOAD, for a second reason beyond the collapse: trimming eats a body's
 * leading indentation and its trailing newline, and `composeBody` owns the newline contract. Whitespace
 * normalization belongs to `parseFenceBody`'s eight declared rules, not to a reader. The reader hands
 * over bytes.
 */
export function readTextFromStream(
  stream: NodeJS.ReadableStream,
  timeoutMs: number = STDIN_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    let data = "";

    const onData = (chunk: Buffer | string): void => {
      data += typeof chunk === "string" ? chunk : chunk.toString();
    };
    const onEnd = (): void => finish(data); // ← the WHOLE body of the clone's divergence
    const onError = (): void => finish(null);

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      if (typeof stream.pause === "function") stream.pause();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

/**
 * Is `--body` present in EITHER argv form? (Story 2.7, NK-8 rule 2's "stdin is read only when the flag
 * is present".)
 *
 * 🔴 `hasFlag` ALONE CANNOT ANSWER THIS, and using it alone is a silent no-op rather than a wrong
 * answer. `hasFlag` is `args.includes("--" + name)` (`src/core/args.ts`) — the BARE form only — so under
 * the estate's standard value-flag idiom (`hasFlag(a,n) ? flagValue(a,n) : default`) an `--body=-` reads
 * as ABSENT, no stdin is read, and the run degrades into a plain `render --apply`: a normalizing
 * round-trip that writes the note's own fence back and exits `0`. The caller asked for enrichment and
 * got a no-op at success.
 * ⚠ And `flagValue` alone cannot answer it either: a trailing `--body` returns `undefined`,
 * indistinguishable from absent. NEITHER READER IS SUFFICIENT ALONE; THE DISJUNCTION IS.
 *
 * ⚠ THE TRAP GENERALIZES, which is why it is worth a sentence here: `hasFlag` is a correct presence test
 * only for `arity: "bool"`. Every other value flag in the estate hides it because a missed `--k=v`
 * merely falls back to a DEFAULT. `--body` has no default, so the same bug becomes a silent no-op — the
 * next value flag with no default will hit this wall.
 *
 * 🔴 ONE DEFINITION, TWO CALL SITES. `main.ts`'s guards and `runNotekitApply` both need it; two copies of
 * a two-form disjunction is precisely how one of them later gets "simplified" back to `hasFlag`. It is a
 * shared PREDICATE rather than a threaded boolean because 2.2 pins `runNotekitApply(argv, deps)` —
 * a third parameter would change a sibling's signature and edit its tests, and smuggling it into `deps`
 * would conflate a parsed-argv fact with the injection seam that tests replace with throwing doubles.
 */
export function bodyFromStdinRequested(argv: string[]): boolean {
  return hasFlag(argv, "body") || argv.some((a) => a.startsWith("--body="));
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
 * ⚠ RE-EXPORTED, NOT REDEFINED. `composeBody` (the newline contract) and `deriveFenceFields` (the one
 * frontmatter→fence derivation, which returns its gap advisory from the SAME pass) both MOVED to `./notekit-read` at
 * Story 2.5, for the reason 2.2 gave when it put `composeBody` here: "it has exactly one caller". Each
 * now has two — the author-mode PREVIEW on the read surface and the WRITE on this one — and the
 * dependency runs ONE WAY, so the single owner has to be the lower module. That is 2.2's own
 * `errorText` ruling applied a second time.
 *
 * The re-export is what makes this a MOVE rather than a rewrite: every 2.2 import and every 2.2 test
 * resolves through this name unedited, and their staying green is the proof. Neither carries a write
 * token, so the sole-writer gate over this file is unaffected.
 */
export { composeBody, deriveFenceFields } from "./notekit-read";

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
    // ── 0. the `--body -` enrichment channel, read BEFORE the plan (Story 2.7, NK-8 rules 1-2) ────
    // ⚠ STDIN IS READ ONLY WHEN THE FLAG IS PRESENT. No `isTTY` probe, no speculative read at module
    // load, no "read it and ignore it if unused" — `notekit-write.test.ts` asserts the negative with a
    // `readBody` double that THROWS, which proves nothing was even attempted rather than merely that
    // nothing was written.
    // ⚠ THE PREDICATE IS THE SHARED TWO-FORM ONE, never a local bare-form read: that form is blind to
    // the equals spelling and would degrade this flag into a silent no-op at exit `0`. The single-read
    // gate in `main.test.ts` greps for the reader call WITHOUT masking comments, so naming the banned
    // form literally here would turn that gate red against correct code — hence the paraphrase.
    let body: string | undefined;
    if (bodyFromStdinRequested(argv)) {
      const read = await (deps.readBody ?? readStdinText)();
      if (read === null) {
        // A RUNTIME usage `2`, inherited rather than re-decided: an unreadable stdin is already 2.1's
        // verdict for `validate --spec -`. The line goes to stderr and NOTHING goes to stdout — not
        // even under `--json`, because the run never reached the pipeline that produces an envelope.
        // ⚠ `""` IS NOT THIS BRANCH. A readable-but-empty stream is a real body that proceeds to the
        // codec and fails loud at `validate`; only a timeout or a stream error resolves `null`.
        err("std notekit render: cannot read the fence body from stdin (timed out or the stream errored)");
        return 2;
      }
      body = read;
    }

    // ── 1. the plan, computed ONCE by the read surface and shared with the preview ────────────────
    // ⚠ `body` IS PASSED THROUGH AS-IS. Never `body || undefined`: that maps a readable-but-empty `""`
    // to "no override" and silently restores the note's own fence, turning a loud refusal into a
    // successful no-op. The `null` branch above already returned, so the type here is `string |
    // undefined` and tsc carries the distinction.
    const outcome = await renderPlan(argv, deps, err, body);
    if (outcome.kind === "usage") return 2; // row 1 — the line is already on stderr
    if (outcome.kind === "error") {
      emit({ ok: false, error: outcome.error }, json, log, err);
      return 1; // rows 2–6
    }

    // ── 1b. NORMALIZE THE TWO SHAPES INTO ONE WRITE INTENT (Story 2.5) ────────────────────────────
    // ⚠ THE TWO BRANCHES DIVERGE HERE AND NOWHERE ELSE. Author mode composes with `createFence` (the one
    // allowed structural add, NK-4 rule 2) and transform mode with `spliceFence` (a body replacement
    // between offsets that already exist) — different operations, deliberately not one generalized
    // function. Everything downstream is shared, and it HAS to be: the sole-writer gate requires exactly
    // ONE write call in the whole slice, so a second sequence for author mode would either duplicate the
    // permitted call site or bypass the discipline it enforces. One sequence is the gate's shape, not a
    // convenience.
    const plan =
      outcome.kind === "seed"
        ? {
            notePath: outcome.seed.notePath,
            noteText: outcome.seed.noteText,
            preview: seedValue(outcome.seed),
            done: (written: boolean) => seedValue(outcome.seed, written),
          }
        : {
            notePath: outcome.plan.notePath,
            noteText: outcome.plan.noteText,
            preview: { html: outcome.plan.html, diff: outcome.plan.diff, spec: outcome.plan.spec },
            done: (written: boolean) => ({
              html: outcome.plan.html,
              diff: outcome.plan.diff,
              spec: outcome.plan.spec,
              written,
            }),
          };

    // ── 2. the preview, BEFORE anything is written (NK-4 rule 3) ──────────────────────────────────
    // ⚠ Under `--json` the preview cannot PRECEDE the write in print order, and pretending otherwise
    // would make this AC unsatisfiable: NK-7 rule 2 makes the envelope the only thing on stdout, and it
    // is one object emitted once, at the end. So `--json` satisfies rule 3 by PROVENANCE — `value.diff`
    // is computed from the plan's pre-write bytes, the same bytes the write is composed from, and it is
    // the byte-identical twin of a preview-only run's `diff`. Without `--json` the ordering claim is
    // literal, and this is the line that makes it so.
    if (!json) emit({ ok: true, value: plan.preview }, false, log, err);

    // ── 3. compose the next note — the ONLY place note text is built ──────────────────────────────
    // ⚠ THE TWO OPERATIONS ARE DIFFERENT AND ARE DELIBERATELY NOT ONE GENERALIZED FUNCTION.
    // `spliceFence` replaces a body between two offsets that ALREADY EXIST; `createFence` inserts a
    // whole block where there is nothing to replace — the one allowed structural add (NK-4 rule 2). A
    // splice that can also create is exactly the widening that rule confines. Both are pure, both
    // compose through the SAME `composeBody`, and this is the only line where the branches differ.
    const next =
      outcome.kind === "seed"
        ? createFence(
            outcome.seed.noteText,
            outcome.seed.type,
            composeBody(outcome.seed.fields),
            outcome.seed.insertAt,
          )
        : spliceFence(outcome.plan.noteText, outcome.plan.fence, composeBody(outcome.plan.fields));

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
    // `noteText`, so re-reading would cost a syscall and open a second TOCTOU window for nothing.
    // ⚠ UNREACHABLE ON THE AUTHOR ARM, by construction rather than by omission: `createFence` always
    // inserts bytes, so `current === next` cannot hold there. Left shared rather than branched — a
    // conditional here would be a second path through the one sequence whose value is that it has one.
    if (current === next) return succeed(plan.done(false), plan.notePath, false, json, log, err);

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
    return succeed(plan.done(true), plan.notePath, true, json, log, err);
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


/**
 * Row 10 — the success envelope, and the single human result line that follows the preview.
 *
 * ⚠ IT TAKES THE VALUE ALREADY BUILT rather than rebuilding it from a plan (Story 2.5). Author mode's
 * payload carries a `gaps` key the transform payload does not, and re-deriving the shape here would
 * mean this function knowing which branch produced it — a second place the two payloads could drift.
 * The caller's `done(written)` is the ONE builder per branch.
 */
function succeed(
  value: Record<string, unknown>,
  notePath: string,
  written: boolean,
  json: boolean,
  log: (line: string) => void,
  err: (line: string) => void,
): number {
  if (json) {
    // ONE result object, both forms — the same rule `capabilities` follows. `written` rides the
    // envelope; the human form prints it as its own line rather than re-rendering the payload.
    emit({ ok: true, value }, true, log, err);
    return 0;
  }
  log(written ? `✓ wrote ${notePath}` : "✓ already current, nothing written");
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
