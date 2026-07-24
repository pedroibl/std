# The architecture-escalation sub-loop

When a story turns out to be blocked on an **architecture** question rather than a code problem, the loop
does not stop and wait for a human. It runs a three-window sub-loop — **research → decide → propagate** —
and resumes. All three windows are dispatched; the conductor authors the briefs and reads the sentinels.

This behavior is **enforced, not optional**: an architecture blocker that gets "worked around" inside a dev
window produces a story that compiles and a spine that lies. The next story inherits the lie.

---

## Trigger — what counts as an architecture blocker

The discriminator is **blast radius**, not difficulty.

**Story-level — do NOT escalate.** Handle in the dev/review window or a story fix: a wrong line anchor, a
missing detail, a bug, a failing test, a gate that needs scoping, an API shape the story got wrong. These
bind only this story.

**Architecture-level — escalate.** The story needs a decision that **binds units beyond itself** and no AD
covers it, or the applicable AD contradicts the story or live code:

- a contract shape or envelope that a second consumer will also parse
- a module boundary, or which side owns routing
- an invariant (INV/NFR) the story cannot satisfy as written
- two ratified ADs that turn out to conflict once code exists
- a "temporary" exception a dev window is about to invent to get unblocked ← the loudest signal

A dev or review window that reports `BLOCKED` with a reason in the second list opens this sub-loop.

## Step 1 — the conductor authors the research plan

This is the conductor's value-add and the reason the sub-loop beats "ask Winston cold". State, in
`dispatch-dir/arch-research-{e}-{s}-prompt.md`:

- **The question, in one sentence**, phrased so a wrong answer is falsifiable.
- **The candidate shapes** (A / B / C) as the loop currently understands them, each with its known cost.
- **What evidence would settle it** — the benchmark, the API behavior, the precedent, the failure mode.
- **The sources by path**: the contested ADs, the story, the live code, the library source, the PRD section.
- **The blast radius**: which other stories or units the answer binds.

Headless framing, subagents allowed, sentinel discipline — same contract as every other brief.

```sh
loom dispatch claude dispatch-dir/arch-research-1-5-prompt.md /abs/path/to/project
```

The window runs `bmad-technical-research`, which writes its report to
`_bmad-output/planning-artifacts/research/technical-{slug}-research-{date}.md` — a durable artifact, not a
chat answer. Its dispatch report goes to `dispatch-dir/arch-research-{e}-{s}-output.md` ending
`RESEARCH-COMPLETE`, and **must name the report's exact path**, because that path is the next window's
input.

`bmad-domain-research` is the alternate when the question is about a vendor/market rather than a technology.
(There is no `bmad-deep-recon` skill — do not reference one.)

## Step 2 — dispatch the architect, verbatim problem + research

`dispatch-dir/arch-decision-{e}-{s}-prompt.md` carries **three things and no summary**:

1. **The blocker verbatim** — the dev/review window's own words, quoted, not paraphrased. A conductor's
   summary of an architecture problem is where the real constraint gets lost.
2. **The research report path** from Step 1, plus the instruction to read it in full before deciding.
3. **The sources**: the ARCHITECTURE-SPINE, the contested ADs by ID, the story, the live code.

The window runs `bmad-agent-architect` (Winston) and must produce a **decision, not options**: an amended or
new AD written into the spine, with the rejected candidates and why. Report to
`dispatch-dir/arch-decision-{e}-{s}-output.md` ending `ARCH-DECISION-COMPLETE`, naming the AD IDs it wrote
or changed and every story it believes is affected.

```sh
loom dispatch claude dispatch-dir/arch-decision-1-5-prompt.md /abs/path/to/project
```

## Step 3 — the human gate (narrow, and it matters)

Proceed autonomously when the decision **adds** an AD or **sharpens** one without contradicting a ratified
contract. That is the common case and the whole point of the sub-loop.

**Stop and surface** when the decision:

- **breaks a ratified AD** other stories already built against, or
- **changes the scope of the epic**, or
- **invalidates an already-`done` story's contract or a measurement baseline**.

Those are product decisions, not architecture ones — they belong to the principal and to
`bmad-correct-course`. Present the decision, the research, and the blast radius; do not apply it.

## Step 4 — propagate, then resume

The spine changed, so every affected story is now stale. Dispatch a fresh `claude` window
(`arch-propagate-{e}-{s}-prompt.md` → `PROPAGATE-COMPLETE`) to update each affected story to cite the new
AD and carry it as an AC. Story edits need live grounding — that is window work, not conductor work.

Then re-dispatch the blocked story's dev window **from the updated story**, and continue the loop.

## Running the loop while the escalation runs — the point of doing it this way

The sub-loop is dispatched, so the epic loop does not have to idle. Continue to the next story **only if it
neither depends on the blocked story nor touches the contested contract or file**. Otherwise the loop holds:
opening a story on an unresolved spine is the "broken base" failure this agent exists to prevent.

Announce which branch you took — "continuing with 5.4 while 5.3's envelope question is out for research" —
so the parallelism is visible rather than assumed.

## File contract

| Phase | Vendor | Output file | Sentinel |
|---|---|---|---|
| research | `claude` (`bmad-technical-research`) | `dispatch-dir/arch-research-{e}-{s}-output.md` | `RESEARCH-COMPLETE` |
| decision | `claude` (`bmad-agent-architect`) | `dispatch-dir/arch-decision-{e}-{s}-output.md` | `ARCH-DECISION-COMPLETE` |
| propagate | `claude` | `dispatch-dir/arch-propagate-{e}-{s}-output.md` | `PROPAGATE-COMPLETE` |

Dash-separated keys, never a dot. Confirm each output path is absent before dispatching. Same background
poll watchdog as the dev/review windows.

## Gotchas

- **A summary of the blocker loses the blocker.** Quote the dev window verbatim. The specific sentence where
  an implementer says "I'd have to special-case this" is the actual finding.
- **Research must land as a file, not a verdict in a report.** The architect window reads the report; if
  Step 1's window only summarizes its findings into the sentinel file, the architect decides on a summary.
  Require the report path and require it to exist.
- **An architect window that returns options has failed.** Ask for a decision plus the rejected candidates.
  Options bounce the choice back into the conductor's context, which is where it least belongs.
- **The spine is committed like any other deliverable** — the propagate step's story edits and the spine
  change belong in the same bookkeeping commit as the story they unblock, not a stray commit.
- **Escalating a story-level bug wastes three windows.** Re-read the discriminator: if it binds only this
  story, it is not architecture.
