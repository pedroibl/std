# bmad-estate — seeding provenance

The three skill trees under `skills/` were copied **verbatim** from their **seed
sources (historical)**. Each copy was verified byte-identical to its source with
`diff -rq` (exit 0) at seed time — this is the one-time seed verification, not a
committed regression test (an absolute seed-source path in `src` would violate the
identity-free rule D4/NFR3 and break on reclone/CI). The committed
`bmad-estate.seed.test.ts` asserts only in-repo intrinsics.

**The table below records ORIGIN, not standing authority.** It says where each tree
*came from* at seed time — a true, closed, historical statement. It confers no
ongoing right to edit those trees; per **BM-24** they are rendered consumers that
`std bmad install|update --apply` overwrites. The authoring surface is this
directory. (The term "golden" is retired: it named a lineage and was misread as an
authority, and that misreading destroyed a real rule — `std bfa542a`.)

| Skill | Seed source (historical) | Files | Verification |
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

`std bmad verify` is the **gate** on that flow: its Faithfulness check compares this
module's `skills/<s>` (the reference) against every manifest repo's rendered
`.claude/skills/<s>` (the checked thing), so an edit made anywhere but here shows up
as drift and is named by repo. The full flow is **edit `bmad-estate/` →
`std bmad install|update --apply` → `std bmad verify`**. This applies to *every*
rendered tree without exception — including the planning repo's own
`std/.claude/skills/…` (manifest entry #7), which is an ordinary consumer with no
special standing and is where the 2026-07-27 rule loss happened. Ratified as
**BM-24** in `ARCHITECTURE-SPINE.md`.
