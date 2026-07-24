# The dispatch-first story unit (Jhon-the-Loop's engine)

The conductor's job is to keep the **board honest** and the **briefs excellent** — never to hold a story's
research context. Every heavy read (epic bodies, architecture spine, PRD, live code, std source, the full
story draft) happens inside a **disposable dispatched window**. The conductor reads three things only:
`sprint-status.yaml`, the dispatched windows' **output files**, and whatever `grep -n` a surgical fix needs.

Upstream quality bar for *what a good story contains* and *what a validator hunts*:
`~/.loom/catalog/primer/create-validate-stories-prompt.md`. **The dispatched windows read that primer — the
conductor does not.** Batch-gate variant: `~/.loom/catalog/primer/audit-authored-stories-prompt.md`.
Per-vendor delivery mechanics: `lprimer dispatch-vendors` (`~/.loom/catalog/primer/dispatch-vendors.md`).

## Both halves are BMAD skill runs, not hand-rolled reviews

Draft and validate are the **same skill, twice, in two fresh windows**:

- **Create** — `Load Skill: bmad-create-story` → *"Create Story 3.7"*. Its `<workflow>` runs.
- **Validate** — `Load Skill: bmad-create-story` → *"Validate Story 3.7"*, executed as the skill's
  **`checklist.md` run in fresh context** (that file's own "When Running in Fresh Context" mode). The
  checklist re-derives the story from the real sources, categorizes findings CRITICAL / ENHANCEMENT /
  OPTIMIZATION / LLM-OPTIMIZATION, and **applies the fixes to the story file itself**.

There is no `Validate` entry point in `bmad-create-story`'s `<workflow>` — saying "validate story 3.7" to a
bare skill invocation drops into Step 1 and **creates**. The brief must name `checklist.md` explicitly.

**Both windows must be `claude`.** `.claude/skills/` is readable only by Claude Code — agy and grok cannot
load a BMAD skill at all, and a brief that asks them to will silently degrade into a generic review with no
checklist behind it. Cross-vendor is still used, but at a different point: see "Model diversity" below.

Because the validator applies its own fixes, **the conductor edits nothing in the normal path**. That is the
single biggest context saving in the loop.

---

## Ideal state

An epic's backlog is exhausted, and for every story: a draft exists, an **independent model** validated it
against live code, every warranted fix landed, load-bearing stories carry a **second** independent verdict
from a **third** model, `sprint-status.yaml` says `ready-for-dev` only where that is literally true, and
`validation-log.md` records each verdict. The conductor's own context never held a line of product code.

## Scratch setup (once per run, before anything writes)

`dispatch-dir/` at repo root, gitignored **before** the first dispatch. In gen-image `/dispatch-dir/` is
already in `.gitignore` — verify, don't assume. Resolve the project dir to an **absolute** path once
(`pwd`); `~` never expands inside a quoted prompt or seed.

## File contract — deterministic, dash-separated, never a dot

| Phase | Vendor | Brief template | Output file | Sentinel (last line) |
|---|---|---|---|---|
| create | `claude` | `create-brief-template.md` | `dispatch-dir/story-{e}-{s}-output.md` | `STORY-DRAFT-COMPLETE` |
| validate (+fixes) | `claude` | `validate-brief-template.md` | `dispatch-dir/val-{e}-{s}-output.md` | `VALIDATION-COMPLETE` |
| adversarial 2nd pass | `agy` / `grok` | `adversarial-brief-template.md` | `dispatch-dir/adv-{e}-{s}-output.md` | `ADVERSARIAL-COMPLETE` |
| fix (only after a 2nd-pass CRITICAL) | `claude` | — (the adv output IS the brief) | `dispatch-dir/fix-{e}-{s}-output.md` | `FIX-COMPLETE` |
| batch audit | `claude` + `agy`/`grok` | `adversarial-brief-template.md` | `dispatch-dir/audit-{e}-{s}-output.md` | `AUDIT-COMPLETE` |

Prompt files sit beside their outputs: `dispatch-dir/{phase}-{e}-{s}-prompt.md`.

`story-1-5-output.md` — **never** `story-1.5-output.md`. A dot breaks the watchdog's exact-path poll.

## The per-story unit

1. **Author the brief.** Fill `references/create-brief-template.md` → the create prompt file. This is the
   conductor's real work: name the sources by path, the risks, the scope boundary, the gotchas. Name paths;
   don't paste their contents — the window opens them itself.
2. **Confirm the output path is absent** (`ls dispatch-dir/story-{e}-{s}-output.md` → miss), or a stale
   artifact fires the watchdog instantly with the wrong content.
3. **Dispatch the drafter — `claude`** (composer paste; stays interactive, which `bmad-create-story`
   requires — a positional prompt would run one-shot and exit):
   ```sh
   loom dispatch claude dispatch-dir/story-1-5-prompt.md /abs/path/to/project
   ```
   Equivalent stdin form: `echo "read file: /abs/.../story-1-5-prompt.md and follow it" | loom dispatch claude /abs/path`.
4. **Watchdog** — background poll on the exact file, zero tokens while waiting:
   ```sh
   OUT=dispatch-dir/story-1-5-output.md
   for i in $(seq 1 80); do
     [ -f "$OUT" ] && tail -n 3 "$OUT" | grep -q STORY-DRAFT-COMPLETE && echo FOUND && exit 0
     sleep 15
   done
   echo TIMEOUT; ls -l "$OUT" 2>/dev/null; tail -n 20 "$OUT" 2>/dev/null; exit 1
   ```
   `run_in_background: true`. Never foreground-`sleep`. The completion `<task-notification>` is exempt from
   the RepeatDetection hook — consecutive per-story watchdogs flow through automatically, so do **not** add a
   manual "the draft is ready" nudge (that repeated message is what used to trip the detector).
5. **Dispatch the validator — a second fresh `claude` window running `checklist.md`.** Fill
   `references/validate-brief-template.md`, then:
   ```sh
   loom dispatch claude dispatch-dir/val-1-5-prompt.md /abs/path/to/project
   ```
   Independence here comes from **fresh context**, which is exactly what the checklist assumes. This window
   **applies its own fixes** — the conductor reads the verdict, not the story.
6. **Second pass — cross-vendor, adversarial, only on load-bearing stories, only after the fixes land.**
   Fill `references/adversarial-brief-template.md` and dispatch to a **different model**:
   ```sh
   loom dispatch antigravity dispatch-dir/adv-1-5-prompt.md /abs/path/to/project
   ```
   The `<project-dir>` third arg is **required** for agy: loom `--add-dir`-binds it so agy's write hits real
   disk. Without it the report goes to agy's UI artifact store, the sentinel never lands, and the watchdog
   times out on a review that actually succeeded. `grok` is the live alternate.

   Load-bearing = changes runtime control flow or a shared contract, drew a CRITICAL on the checklist pass,
   or has downstream stories depending on it. **A story whose fix pass rewrote a flag, a default, or a
   contract is load-bearing regardless of its size.** Data-only and doc-carry stories clear on the
   checklist alone. This pass is **read-only** — it reports, it does not edit.

   **This pass exists because the fixer is blind to its siblings.** Live precedent (Epic 5, first run): a
   checklist pass made an opt-in `--brain` flag optional-with-default — locally reasonable, and it would
   have put the brain path always-on, broken dry-run byte-identity, contradicted the sibling story's
   explicit contract, and invalidated the measurement baseline an earlier story exists to produce. The
   cross-vendor pass caught it. **A single-pass loop ships that defect.** Do not trim this stage as
   redundant with the checklist — it audits the checklist's own edits, which nothing else does.
7. **Fix, only if the adversarial pass found a CRITICAL.** Dispatch a fresh `claude` window with
   `dispatch-dir/adv-{e}-{s}-output.md` as its brief. The conductor edits a story file only for a fix the
   report quotes verbatim as a single-line replacement; anything needing live-code grounding goes to the
   window, because grounding a rewritten code block means reading real source.
8. **Bookkeep (conductor only).** Flip `sprint-status.yaml` to `ready-for-dev` and append the verdict to
   `_bmad-output/implementation-artifacts/validation-log.md`. Then the next story.

## Ownership boundary — why the board never races

**Dispatched windows never write `sprint-status.yaml` or `validation-log.md`.** State that in every brief.
The conductor owns the board; the windows own drafts, fixes, and their own output file. That single rule
removes write contention, keeps board honesty in one place, and is what makes pipelining safe.

**Pipelining, depth 2 max.** While story N validates, story N+1's create window may run. Do not go deeper:
a third window in flight makes shared-file dev-order and fix ordering unreadable. Serialize on the first
sign of a shared-file collision between the two in flight.

## Model diversity — where it actually applies

Draft and checklist-validate are both `claude`, because both are BMAD skill runs and only Claude Code can
load `.claude/skills/`. Their independence is **fresh context**, which is what `checklist.md` is written
for. Do not trade the checklist away for vendor variety — a generic agy review is a weaker instrument than
BMAD's own quality gate.

Cross-vendor earns its keep at the **second pass**, where the job is drawing different cards rather than
running a checklist: `agy` (Gemini) default, `grok` the alternate. Same-window self-review is still theatre
— a story is never graded by the window that wrote or fixed it, whatever the vendor.

## Failure isolates

Stop and surface — do not open the next story on a broken base — when: a window dies or times out, a
validator returns `BLOCKED`, a fix window can't make a gate reach green, two in-flight stories collide on a
shared file, or a finding needs a product decision the sources don't resolve.

## Token discipline (the whole point of this fork)

- **Never** spawn in-harness `general-purpose` subagents to validate. Their full report lands in the
  conductor's context and burns the conductor's own pool. Dispatch a window instead — its cost is entirely
  outside this context; only its output file comes back.
- **Never** `Read` an epic body, PRD, architecture spine, live product source, std source, or a full story
  draft. Name the path in the brief and let the window open it.
- Every brief caps its window's report: **≤150 lines, tables over prose, no restating the story's content.**
- On a fix window, read only the validator output + the fix window's report — not the story it rewrote.
- **Let the windows use subagents.** `bmad-create-story` explicitly wants parallel research subagents and
  asks once for permission — pre-answer **yes** in the brief. Their cost is inside the disposable window, so
  depth there is free to the conductor. (This is the opposite of the review-primer's "no subagents" rule,
  which exists for a read-only reviewer that must stay cheap and serial.)

## Gotchas

- **Dispatch is async.** `loom dispatch` waits only for the vendor's composer sentinel, delivers the prompt,
  and returns the winId. It never captures output. File + sentinel + watchdog is the only return path.
- **Sentinel must fire on every terminal state, including `BLOCKED`.** A brief that writes only on success
  hangs the watchdog to timeout on a window that already gave up.
- **`~` does not expand inside a quoted prompt or seed** — every path in a brief must be absolute or
  project-relative from the bound project dir.
- **agy's composer submits on each newline**, which is why loom seeds it via `-i` and it reads the brief off
  disk. Keep both the prompt file and the output file under the bound project dir.
- **The dispatch state-file `winId` drifts** between dispatch and `--list`. The output file is the real
  signal; the winId is advisory liveness only.
- **`bmad-*` skills halt at human checkpoints by default.** Every brief's first line must be the headless
  framing, or the window sits waiting forever on a menu.
- **`checklist.md` Step 6 is an interactive prompt** — *"Which improvements would you like me to apply?
  all / critical / select / none"*. A headless window hangs there. **Pre-answer it in the brief**: apply all
  CRITICALs plus every warranted ENHANCEMENT, without asking.
- **`bmad-create-story` writes the board itself and lies while doing it.** Step 5 sets the story's
  `Status: ready-for-dev` and Step 6 flips `sprint-status.yaml` to `ready-for-dev` — *at draft time, before
  any validation*. Both briefs must override this explicitly: write the story file only, leave the board
  alone. The conductor flips it after the fixes land, which is the only moment the flag is true.
- **`checklist.md` Step 7 forbids the story from recording its own review** ("make changes look natural, do
  not reference the review process"). So the fixes leave **no trace in the story file** — the window's
  output file and `validation-log.md` are the only durable record that validation happened at all. Require
  the findings-and-fixes table in the report, or the pass becomes unauditable.
- **A bare "Validate Story 3.7" does not validate.** `bmad-create-story` has no validate entry point in its
  `<workflow>` — the request falls into Step 1 and creates. Name `checklist.md` and its fresh-context mode.
- **`ready-for-dev` at create time is a lie.** Flip only after validation clears *and* the fixes land; keep
  `last_updated` describing what actually happened, never ahead of reality.
