# Template — cross-vendor adversarial brief (`agy` / `grok`, read-only)

The **second** pass, run only on load-bearing stories after the checklist pass's fixes land — and the batch
gate used by AUDIT. Fill and write to `dispatch-dir/adv-{e}-{s}-prompt.md` (AUDIT: `audit-{e}-{s}-prompt.md`
with the `AUDIT-COMPLETE` sentinel).

Dispatch to a **different model** than the one that drafted and fixed the story. These vendors cannot load
`.claude/skills/`, so this brief is fully self-contained by design — its value is drawing different cards,
not re-running BMAD's checklist. Every path must be **absolute or project-relative**; `~` does not expand.

```sh
loom dispatch antigravity dispatch-dir/adv-1-5-prompt.md /abs/path/to/project   # project dir REQUIRED
```

---

```markdown
# ADVERSARIAL PASS — independent re-derivation of Story <E.S>

You are running **headless** — no human at this terminal. Never pause, never ask, never wait for input. Run
to completion. Do not spawn subagents — work inline.

## Your job

This story was authored and then validated by a different model, which reported it clean. **Treat that as a
claim, not evidence.** A first validation pass is one sample: it can be fresh and adversarial and still miss
a critical. Re-derive the story from the real sources and try to break it.

Nothing in the story's own prose is evidence. Live code and library source are.

## Sources

| What | Path |
|---|---|
| Story under review | `<abs or project-relative path>` |
| Epic + ACs it expands | `<path>` |
| Architecture spine / ADs | `<path>` |
| Live code it modifies | `<paths>` |
| Library/std source it consumes | `<paths>` |
| The first pass's verdict (re-verify its proudest catches) | `<path to val-…-output.md>` |

**Re-verify what the first pass was proudest of.** If a validator is wrong about its own wins, it cannot be
trusted on its silences.

## Audit the FIXES, not just the story — this is your highest-yield job

The first pass **edited this story**, seeing only this story. A fix that is locally reasonable can be
globally wrong, and nothing downstream will catch it. For every fix listed in the first pass's report, ask:

- Does it contradict a **sibling story's explicit contract** in this epic?
- Does it violate a **stated NFR / INV / AD** the story cites?
- Does it defeat the **reason a predecessor story exists** — most dangerously by making an opt-in path
  default-on, which invalidates any baseline or byte-identity measurement taken before it?
- Does it widen scope past the story's own boundary table?

Precedent: a fix pass made an opt-in `--brain` flag **optional with the table as default source** —
reasonable in isolation, and it would have put the brain path always-on, broken dry-run byte-identity,
contradicted the sibling story's explicit contract, and invalidated the measurement baseline a predecessor
story exists to produce. A single-pass loop ships that. This check is why you exist.

## Verify specifically

- **Every API shape** the story's code assumes — import subpath, exported symbol, signature, return type —
  against library source.
- **Independently count every population** the story asserts (exit sites, callers, importers, formats,
  routes) with your own `grep -c` over the whole tree. Report the command and the number. Guessed counts are
  the recurring failure.
- **Self-consistency:** run the story's own stated gates (its greps, `jq` checks, ACs) against the story's
  own prescribed code. Does following it verbatim pass its own AC?
- **Gate reachability, both directions:** can each mechanical gate return clean on success (or do
  out-of-scope residuals make it permanently non-empty)? **And can it ever go red?** A `git diff
  <base>..HEAD` "unchanged" gate run pre-commit ignores the working tree and is empty by construction —
  green forever, worthless as pass/fail. Name what input would fail each gate.
- **Partition arithmetic:** where the story splits a population into buckets, add them up. Re-deriving the
  population is not the same check — a 10+1+3 summary over a 13-row table passed two population re-counts.
- **Completeness:** every exit/error path covered where an AC says "every"; helpers reachable from every
  caller; `const` ordering TDZ-safe; unsound casts still guarded at runtime.
- **Line anchors** match live code; relative import paths resolve.
- **The headline invariant:** <state it>.
- **Scope discipline** — nothing belonging to a later story leaked into the tasks.

## Read-only boundary — hard

You may run read-only commands, `grep`, `git diff`, `--dry-run`, `bunx tsc --noEmit`. You may **NOT** edit
any tracked file, touch the story, write `sprint-status.yaml` or `validation-log.md`, or run any git write.
**Your only write is your output file.** You report; the orchestrator applies.

## Output schema — exactly these headings

Write to `dispatch-dir/adv-<e>-<s>-output.md`:

1. `## Verdict` — `VERIFIED-CORRECT` | `ENHANCEMENT` | `CRITICAL` | `BLOCKED`.
2. `## Checks run` — table: check → command → result. If you didn't read it or run it, you can't score it.
3. `## Findings` — table: severity → `file:line` → what's wrong → **the exact edit** (old text → new text,
   verbatim and byte-accurate, so it can be applied without re-deriving).
4. `## First-pass claims re-checked` — table: claim → held / did not hold → evidence.
5. `## VERIFIED-CORRECT` — what you checked and found genuinely sound, so nothing sound gets churned.
6. `## Cross-story risk` — shared files this story mutates that others also touch, and the dev order implied.

**Under 150 lines.** Tables over prose. Do not restate the story's content.

Write this file on **every** terminal outcome — `BLOCKED` is a verdict, not a reason to skip the write. A
prompt that writes only on success hangs the orchestrator's watchdog to its timeout.

When the file is fully written, append this EXACT line as the very last line, nothing after it:

ADVERSARIAL-COMPLETE

Print it only in the file, never in the terminal.
```
