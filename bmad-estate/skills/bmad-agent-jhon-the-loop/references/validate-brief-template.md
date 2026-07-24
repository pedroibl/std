# Template — validate-story dispatch brief (`claude` window, applies its own fixes)

Fill and write to `dispatch-dir/val-{e}-{s}-prompt.md`. This window runs `bmad-create-story`'s own
`checklist.md` in fresh context — it is the BMAD quality gate, and it **edits the story**. Must be `claude`:
agy and grok cannot load `.claude/skills/`.

---

```markdown
# VALIDATION DISPATCH — `bmad-create-story` checklist over Story <E.S>

You are running **headless** — no human at this terminal. Never pause, never ask, never wait for input. Run
to completion. **Subagents: YES** — use parallel research subagents freely for artifact analysis.

## Your job

**Load Skill: `bmad-create-story`.** Then: **Validate Story <E.S>.**

Concretely: execute that skill's **`checklist.md`** in its **"When Running in Fresh Context"** mode against
the already-created story file at `<story path>`. You are the independent quality validator the checklist
describes — re-derive the story from the real sources with a critical eye and **find what the original run
missed**.

Do **not** run the skill's `<workflow>` (Step 1 would create a story). The checklist is the whole job.

## Pre-answered checkpoints — do not ask, just do

- **Checklist Step 6 ("Which improvements would you like me to apply?") → `all`**, with judgement: apply
  **every CRITICAL** and **every ENHANCEMENT that materially helps a dev agent**. Skip cosmetic-only
  optimizations and say in your report that you skipped them.
- **Checklist Step 7 applies the changes to the story file.** Do that — you are the fixer, not just the
  finder. The orchestrator does not re-apply anything you report.

## Sources — verify against these, never against the story's own prose

| What | Path |
|---|---|
| Story under review | `<path>` |
| Epic + ACs it expands | `<path>` |
| Architecture spine / ADs | `<path>` |
| Live code it modifies | `<paths>` |
| Library/std source it consumes | `<paths>` |
| Prior stories it consumes a contract from | `<paths>` |

## Verify these specifically — beyond the checklist's own categories

- **Every API shape** the story's code assumes — import subpath, exported symbol, signature, return type —
  against library source. A code block on a wrong API shape is the most expensive defect there is.
- **Independently count every population** the story asserts (exit sites, callers, importers, formats,
  routes) with your own `grep -c` over the whole tree. Guessed counts are the recurring failure. Report the
  command and the number.
- **Self-consistency:** run the story's **own** stated gates (its greps, `jq` checks, ACs) against the
  story's **own** prescribed code. Does following it verbatim pass its own AC?
- **Gate reachability:** can each mechanical gate actually return clean on success, or do pre-existing
  out-of-scope residuals make it permanently non-empty (and therefore useless as pass/fail)?
- **Completeness of coverage:** every exit/error path handled where an AC says "every"; helpers reachable
  from every caller; `const` ordering TDZ-safe; unsound casts still guarded at runtime.
- **Line anchors** match live code; relative import paths resolve (count the `../`).
- **The headline invariant** of the story: <state it — e.g. an override flag must not cross a policy gate>.
- **Scope discipline** — nothing belonging to a later story leaked into the tasks; deferrals are fenced.

## Boundaries

- **Edit the story file only.** Do **NOT** touch `sprint-status.yaml` or `validation-log.md` — the
  orchestrator owns the board and flips it after this pass. Do **NOT** edit product code, the epic, or any
  planning artifact. No git writes of any kind.

## Report back — this is the ONLY record that validation happened

The checklist tells you to make fixes read naturally and not reference the review process — so the story
file will carry **no trace** of this pass. Your output file is therefore the whole audit trail.

Write to `dispatch-dir/val-<e>-<s>-output.md`:

1. `## Verdict` — one of `PASS` | `PASS-WITH-FIXES` | `NEEDS-WORK` | `BLOCKED`.
2. `## Checks run` — table: check → command → result. Nothing scored from memory or plausibility; if you
   didn't read it or run it, you can't score it.
3. `## Findings and fixes applied` — table: severity (`CRITICAL` / `ENHANCEMENT` / `OPTIMIZATION`) →
   `file:line` → what was wrong → **what you changed**. One row per fix.
4. `## Deliberately not applied` — anything you judged cosmetic or out of scope, and why.
5. `## VERIFIED-CORRECT` — what you checked and found genuinely sound. This matters as much as the findings:
   it tells the orchestrator what **not** to churn.
6. `## Cross-story risk` — any shared file this story mutates that another story also touches, and the dev
   order that implies.

**Keep the whole file under 150 lines.** Tables over prose. Do not restate the story's content.

Write this file on **every** terminal outcome. `BLOCKED` — missing files, wrong cwd, unreadable sources — is
a verdict, not a reason to skip the write. A prompt that only writes on success hangs the orchestrator's
watchdog to its timeout.

When the file is fully written, append this EXACT line as the very last line, nothing after it:

VALIDATION-COMPLETE

Print it only in the file, never in the terminal.
```
