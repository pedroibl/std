# bmad-estate — seeding provenance

The three skill trees under `skills/` were copied **verbatim** from their golden
sources. Each copy was verified byte-identical to its source with `diff -rq`
(exit 0) at seed time — this is the one-time seed verification, not a committed
regression test (an absolute golden path in `src` would violate the identity-free
rule D4/NFR3 and break on reclone/CI). The committed `bmad-estate.seed.test.ts`
asserts only in-repo intrinsics.

| Skill | Golden source | Files | Verification |
| --- | --- | --- | --- |
| `bmad-agent-jhon-the-loop` | `~/bmad-head-quarter/.claude/skills/bmad-agent-jhon-the-loop` | 6 | `diff -rq` exit 0. HQ copy verified byte-identical to `packs/bmb-lab/.claude/skills/bmad-agent-jhon-the-loop` (exit 0). |
| `bmad-agent-epic-the-loop` | `~/bmad-head-quarter/.claude/skills/bmad-agent-epic-the-loop` | 3 | `diff -rq` exit 0. HQ copy verified byte-identical to the bmb-lab copy (exit 0). |
| `bmad-agent-dev-the-loop` | `~/Dev/gen-image/.claude/skills/bmad-agent-dev-the-loop` | 2 | `diff -rq` exit 0. The only complete copy of this skill. |

## Default-estate boundary

`.claude-plugin/marketplace.json` lists **exactly two** skills in `plugins[0].skills`
(`epic-the-loop`, `jhon-the-loop`). The `bmad-agent-dev-the-loop/` directory exists
on disk but is deliberately **not** listed. A plain install therefore renders
dev-the-loop absent by default; the `--skills dev-the-loop` opt-in materializes a
filtered custom-source at install time (BM-12, an Epic A concern). Do not "fix" the
two-item list — it is load-bearing.

## Authoring flow

Edit skills **in `bmad-estate/` → install out.** After seeding, `gen-image` is a
plain consumer of `dev-the-loop`: a future in-repo edit there is clobbered on the
next install unless it is first promoted back into `bmad-estate`. `bmad-estate` is
the single source of truth for the loop skills.
