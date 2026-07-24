# Template — create-story dispatch brief (`claude` window)

Fill and write to `dispatch-dir/story-{e}-{s}-prompt.md`. Replace every `<…>`. Name paths; never paste their
contents — the window opens them itself, which is the entire point.

---

```markdown
# STORY DISPATCH — `bmad-create-story` for Story <E.S>: <title>

You are running **headless** — no human at this terminal. Never pause, never ask a setup question, never
wait for input. Answer every menu with its default except where this brief names an answer, and run to
completion.

**Subagents: YES.** `bmad-create-story` asks once whether it may use research subagents for parallel
artifact analysis — the answer is **yes, for the whole run**. Use them freely; depth costs nothing here.

## Your job

**Load Skill: `bmad-create-story`.** Then: **Create Story <E.S>.**

Run its `<workflow>` end to end for **Story <E.S> only**, writing the story file to
`_bmad-output/implementation-artifacts/`.

Quality bar beyond the skill's own: read `~/.loom/catalog/primer/create-validate-stories-prompt.md` first —
its "Creating each story" section and its recurring-defect list are your authoring contract. A story is the
dev agent's only context; match the depth of this epic's already-validated stories.

## Two overrides to the skill's own workflow — both mandatory

1. **Do NOT set `Status: ready-for-dev`** (workflow Step 5). This story has not been validated yet. Set
   `Status: drafted`.
2. **Do NOT update `sprint-status.yaml`** (workflow Step 6) — not the story's status, not `last_updated`.
   Leave the story at `backlog` on the board. The orchestrator owns the board and flips it only after
   validation clears and its fixes land; a create-time flip asserts "dev-ready" over an unvalidated story.

Everything else in Step 6 still runs — in particular **validate the new story against `./checklist.md` and
apply the required fixes before finalizing**. Marking the epic `in-progress` (Step 1) is fine.

## Load these first — they are the whole input

| What | Path |
|---|---|
| Epic + this story's ACs | `<path>` — <section> |
| Architecture spine / ADs it binds | `<path>` — <AD ids> |
| SPEC / PRD sections | `<path>` — <sections> |
| Live code it modifies | `<paths>` |
| Library/std source it consumes | `<paths>` |
| Prior stories it depends on | `<paths>` |
| Standing rules | `_bmad-output/project-context.md` |

## Scope boundary

**In scope:** <what this story owns>
**Explicitly NOT this story** (put in the scope-boundary table, not the tasks): <deferred items + which
story/epic owns them>

## Load-bearing risks — get these exactly right

<numbered, concrete, each naming a file/line or a count. This is where the conductor's value lives.>

## Non-negotiable authoring rules

- Front-matter pins `baseline_commit` = current HEAD. Every line anchor is post-baseline, so add a
  **dev-sequencing note**: what lands first, and that anchors must be re-confirmed by `grep` at dev time,
  never by line number.
- **Derive every stated count** ("N exit sites / callers / formats") from `grep -c` on the source. Never
  trust a set named in docs or CLAUDE.md — grep the whole tree and count.
- **Resolve every API shape against library source** before writing a code block: import subpath, exported
  symbol, signature, return type (`string | null` vs `undefined` matters).
- **Run this story's own gates against its own prescribed code.** If it defines a grep, a `jq` check, or an
  AC assertion, following the story verbatim must pass it. A gate that can't reach green — because of
  out-of-scope residuals — must be scoped (imports-only, path-scoped) with known residuals enumerated.
- **Every gate must be able to FAIL — state what would turn it red.** A gate that is green by construction
  is not a gate. The proven trap: `git diff <base>..HEAD -- <paths>` used as an "unchanged" gate is
  **vacuous when run pre-commit** — it compares committed history and ignores the working tree entirely, so
  it returns empty whatever the dev did, while its paired grep passes independently and hides the hole.
  Anchor an unchanged-gate on the **working tree** (`git diff -- <paths>` / `git status --porcelain --
  <paths>`), or say explicitly that it runs post-commit. For every gate in the story, write the one-line
  answer to "what input makes this red?"
- **A `<base>..HEAD` range in a story that follows a sibling touching the same file must resolve its base at
  dev time** — a shell variable (`$POST_<predecessor>_SHA`), never a literal SHA pinned while authoring.
  The epic's original baseline is stale the moment the predecessor lands, and the gate silently sweeps the
  predecessor's changes into this story's scope.
- **When a story partitions a population into buckets, the buckets must sum to the population — show the
  arithmetic.** Deriving the population by `grep -c` is not enough: a drift summary claiming 10+1+3 over a
  13-row table survived two validation passes because both re-derived the population and neither added up
  the partition. State the sum inline.
- Cover **every** exit/error path when an AC says "on every failure, do Y". Helpers reachable from all
  callers (module scope). `const` ordering TDZ-safe. Unsound casts keep their runtime guard, with the
  reason stated as runtime, not compiler.
- One canonical form per code block — no two near-identical snippets of the same const.

## Boundaries

- Write the **story file only**. Do **NOT** edit `sprint-status.yaml`, `validation-log.md`, product code,
  the epic, or any planning artifact.
- No git writes of any kind — no `add`, `commit`, `checkout`, `stash`.

## Report back

Write your report to `dispatch-dir/story-<e>-<s>-output.md`: the story path, the ACs covered, the counts you
derived (with the grep that produced each), what the skill's own `checklist.md` pass changed, any source
contradiction or ambiguity you found (say so plainly rather than resolving it silently), and anything you
deliberately fenced as out of scope.

**Keep it under 150 lines. Tables over prose. Do not restate the story's content** — the orchestrator reads
this file and nothing else.

Write this file on **every** terminal outcome, including failure: if you cannot author the story, write what
blocked you under a `BLOCKED` heading and still finish with the sentinel.

When the file is fully written, append this EXACT line as the very last line, nothing after it:

STORY-DRAFT-COMPLETE

Print it only in the file, never in the terminal.
```
