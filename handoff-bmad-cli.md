# Handoff — `std bmad` (bmad-manager)

> **Status: published and running against the real estate.** `@pedroibl/std@0.1.2` (tag `v0.1.2`).
> Last run 2026-08-03 · code home `std-public@3c58e6c` · planning home `std@fe85a98`.
>
> **Provenance note — this file was written before the tool was installable.** At the time it claimed
> "9/9 verify clean" the estate was real but the *package* was not: `0.1.1` shipped the CLI bin with
> zero `src/bmad` files and zero `bmad-estate` payload, and every run cited below went through the
> `bun link` dev override, not an artifact. `0.1.2` fixes that and is proven by a registry install.
> Read §4's estate numbers as a snapshot of that day, not a live status — `std bmad verify` is the
> live status, and it currently swings on the `__pycache__` oracle gap described in §7.
>
> This is an operator + maintainer handoff. It leads with the things that will bite you, because all
> three of the defects found on shipping day were invisible to 313 tests and four review instruments,
> and were found by *running* the tool against real repos.

---

## 1. What it is

A built-in `std` command family that orchestrates BMAD across a 9-repo estate: it shells BMAD's own
installer, and owns the estate operations the installer doesn't — batching, scoped commits, dual-surface
verification, dry-run-by-default, never-push-without-asking.

| | |
|---|---|
| **Code** | `std-public/src/bmad/*.ts`, wired in `src/cli/main.ts` |
| **Payload** | `std-public/bmad-estate/` — `marketplace.json` + verbatim `skills/` |
| **Manifest** | `~/.config/std/estate.toml` — caller-local, **not in the repo** |
| **Planning** | `~/Dev/personal/std/_bmad-output/` — PRD, spine, epics, board |
| **Spine** | `…/planning-artifacts/architecture/architecture-bmad-manager-2026-07-24/ARCHITECTURE-SPINE.md` |

**Two-repo guardrail:** code lands in `std-public`, planning in `std`. `std` is *also* a consumer target
in the estate. Never write code into `std`.

---

## 2. Running it

```bash
bun add -g @pedroibl/std             # or: bun add std@npm:@pedroibl/std  (0.1.2+)

std bmad verify                      # read-only, safe, mutates nothing
std bmad install --repos <name>      # DRY RUN — this is the default
std bmad install --repos <name> --apply
std bmad install --apply --push      # estate-wide
```

On this machine `std` resolves to a `bun link` pointing at the working copy — the documented dev
override, so what you run here is the checkout, not the artifact. That is fine for development and
misleading for verification: prove releases by installing from the registry into a throwaway dir and
running *that* binary. Measured 2026-08-03, the two agree exactly, including on failures.

Exit codes: `0` ok/skip · `1` fail-loud · `2` usage. Dry-run is the default on every mutating command;
`--apply` gates mutation and `--push` is separate and never implied.

### 🔴 The `--skills` token is the full directory name

```bash
std bmad install --skills bmad-agent-dev-the-loop     # ✅
std bmad install --skills dev-the-loop                # ❌ fails AFTER the installer has run
```

Spine BM-12 documents the short form and **it is wrong**. The short token passes the module guard, the
installer runs, and only then does verify fail with `module skill missing`. Fail-fast blocks the commit,
so nothing is lost — but the working copy is already mutated. Open board item.

The Default estate is `{epic-the-loop, jhon-the-loop}`. **`dev-the-loop` is opt-in**, and 5 of 9 repos
carry it — omit the flag and the installer's clean pass removes it from all five.

---

## 3. The manifest

`~/.config/std/estate.toml`, one `[[repos]]` block per repo. It did not exist until 2026-08-03: it is
caller-local identity, D4/NFR3 forbids it in `src`, so **no story could create it** — it fell in the gap
between "the code is done" and "the operator has a file". If you are standing this up on a new machine,
this is the first thing to write.

| Field | Required | Notes |
|---|:-:|---|
| `path` | ✅ | **Absolute.** See the gotcha below. |
| `claudeTracked` | ✅ | `git check-ignore -q .claude` — never guessed |
| `hasUpstream` | ✅ | `git rev-parse --abbrev-ref '@{u}'` — never guessed |
| `tools` | | defaults to `claude-code,antigravity-cli` |
| `branch`, `role`, `notes` | | `role: source-only` excludes from the default set *and* the commit loop |

`claudeTracked` and `hasUpstream` are **required and never defaulted on purpose** — guessing either can
stage a gitignored tree or push to the wrong remote.

### 🔴 Use absolute paths, not `~/`

`BmadRepo.path`'s doc says *"May be `~/…`; expansion is a consumer concern"* — and **no consumer expands
it**. `homedir()` appears only in XDG resolution (`deps.ts:301`, `manifest.ts:99`). A `~/` manifest loads
fine, then reports `missing Surface` and `branch: (unknown) (no upstream)` on every repo — it blames the
repos for a path fault. Open board item; either the doc or the seam has to change.

**Re-probe after any repo move.** Three of the PRD's nine survey paths were already stale when the
manifest was first written.

---

## 4. Current estate

All nine verify clean. Postures worth knowing:

- **opentofu-terraform** — `.claude`/`.agents` gitignored, working-copy-only *forever*. Reports
  `skipped-gitignored`; that is success, not a failure.
- **fiver** — feature branch, and **no git remote at all**.
- **bmad-head-quarter**, **claude-code-customs** — also **no remote at all**.
- **claude-code-customs** — carries ~87 unrelated dirty files by design. Scoped-add is what makes it safe;
  it has survived every run untouched.
- **packs/bmb-lab** — nested inside HQ (`rev-parse --show-toplevel` resolves up), hence `role: source-only`.

---

## 5. Gotchas that cost real time

These are the transferable part. Each was found by running, not reading.

### 5.1 `--modules` is a destructive set assertion (BM-18 / BM-18.1)

`bmad install --modules <set>` treats `<set>` as **the modules that should exist**. Anything present on
disk and absent from the set is **deleted**, `rc=0`, silently.

Every argv carrying `--modules` must name **every built-in that has to survive**, probed from the target
repo at build time. The shipped probe enumerates `_bmad/`'s children and keeps those carrying a
`config.yaml` **module marker** — a positive marker, never a name denylist. A denylist rots the moment
BMAD adds a directory, and it rots *in the deleting direction*.

Both legs carried this bug, and the second one survived the first fix because BM-18's text says the frozen
shape is *"safe for a fresh install"* — read as covering `install` **the command** rather than `install`
**the fresh case**. It also nearly escaped a second probe: testing without `--custom-source` leaves the
victim module alone and reads as a clean bill of health. **Reproduce with the real argv shape or not at all.**

### 5.2 The installer deletes surfaces for tools you didn't ask for (BM-23)

`--tools claude-code,antigravity-cli` **removes** surfaces belonging to tools absent from the list. On the
first real apply it deleted the entire `.agent/skills` tree — the Antigravity **IDE** surface, an explicit
non-user per PRD §2.2 — 1594 tracked files, and the run reported `ok`.

**The safety contract is what hid it.** `.agent/` is not a BMAD-managed path, so scoped-add correctly
refused to stage the deletions — a clean-looking commit beside a wrecked worktree. Staging them would be
worse. BM-23 now detects any mutation outside the managed set and fails the repo loud before staging.

On the estate-wide run it stopped **5,257 tracked deletions** across three repos.

If a repo tracks a surface this tool disowns, untrack it:

```bash
git rm -r --cached .agent && echo '.agent/' >> .gitignore
```

Commit **only those paths** — the repos will be holding uncommitted BMAD work that a `git commit -a`
would swallow.

### 5.3 Vacuous gates are the recurring defect form — eleven instances across four epics

A property stated in prose that nothing enforces, or an assertion whose failing input no fixture supplies.
BM-18's own guard passed for three epics because **every fixture held only `core` and/or `bmm`** — the
literal and a correct probe agreed on every supplied input. The knob to pass something else already existed;
nobody used it.

**Every absence assertion carries a positive control on the same code path.** And when you add a gate, run
the red-turning input — BM-23 shipped with 310/310 green while neutered.

### 5.4 A green bot check can mean "I never reviewed this"

CodeRabbit's check reads `SUCCESS` when the review never started ("Review limit reached"), and when its
latest review is against an **older commit than HEAD**. Both happened on the safety-critical PRs.
**Read the bot's comment, and compare `review.commit_id` to HEAD — never the check rollup.**

### 5.5 The push verification can report a false failure

`src/git`'s 5s timeout fires on a real network push, `git()` returns empty fail-soft, **the push completes
anyway**, and the post-push tracking-ref read reports `push failed (upstream not advanced)`.

Direction is safe — it never claims success on a failed push — but it fails a healthy run. If you see it:
`git push` manually; "Everything up-to-date" means it already landed. Open board item.

---

## 6. When a repo fails

Nothing is committed on a failed repo — the pipeline is fail-fast within a repo, and verify runs before
the git filters. Backups are out-of-repo at `~/.local/state/std/bmad-manager/backups/<repo>/<ts>/`.

| Reason | What it means | Action |
|---|---|---|
| `mutated N path(s) OUTSIDE the BMAD-managed set` | BM-23 caught the installer straying | ` D`/` M` → `git checkout -- <path>` · `??` → delete it. Then untrack the surface (§5.2) |
| `module skill missing: …` | wrong `--skills` token | use the full dir name (§2) |
| `install leg failed (exit 1)` | the **installer** failed; message is verbatim | read it — an `ENOTEMPTY` under `~/.bmad/cache/external-modules/` means a corrupt cache; move that entry aside and retry |
| `Only in …/.agents/skills: <skill>` | surface divergence | orphans from removed modules; no install converges them (§7) |
| `gitignored, working copy updated` | **not a failure** | opentofu-terraform's designed posture |
| `push failed (upstream not advanced)` | possibly a false negative | verify manually (§5.5) |

---

## 7. Open items

Board: `std/_bmad-output/implementation-artifacts/sprint-status-bmad-manager-2026-07-24.yaml` — **zero
blockers**, 12 open, none preventing a run.

The ones that will actually reach you:

1. **The Parity oracle ignores `.gitignore`** — it reads the filesystem with `diff -rq`, so any runtime
   artifact inside a skill tree fails the repo permanently even though git never sees it. loom hits this
   with `__pycache__` from its `bmad-story-automator` skill. **Cleaning it is not fixing it:** measured
   2026-08-03, the dirs regenerated twelve minutes after removal with nobody driving the tool. If verify
   goes red on a `Only in …: __pycache__` line, that is this, not estate drift.
2. **`--skills` token doc defect** (spine BM-12) — costs a failed run each time.
3. **`~/` path expansion** — doc and seam disagree; one must change.
4. **Push false-negative** on slow pushes (§5.5).
5. **`git push -u` is unproven** — three repos have no remote at all, so the leg cannot be exercised here.
6. **`batch.ts` `would run:` render** has no assertion — an unenforced property on a real fix.
7. **The shipped payload is one re-seed behind.** Two known skill-content findings (dev-the-loop
   artifacts path, jhon-the-loop model-diversity wording) are fixed nowhere yet — they must be applied at
   the golden SoT and re-seeded, never patched in `bmad-estate/` directly. Until then `0.1.2` distributes
   that stale content to anyone who installs it.

**Releasing.** Tags are the map: `v0.1.2` → `3c58e6c`. `v0.1.0` is deliberately untagged — it was
published from a tree two minutes *before* the commit that matches it, so no commit is honest for it.
Publish through the `_CREDENTIALS` skill: `CredentialHandler npm status`, then `CredentialHandler npm
run -- publish --access public`. Never put a token in `~/.npmrc` and never hand npm a userconfig you
wrote — npm rewrites its userconfig with the resolved value and turns your reference into a plaintext
secret at rest.

**If a surface diverges again** (the gen-image shape): skills in one surface that the other lacks are
orphans from modules the repo no longer holds. Confirm none belongs to an installed module, confirm they
are committed (so removal is recoverable), then remove them and mirror any genuinely bespoke skill across.
No install converges this — the installer renders what the current modules provide; it does not delete
another tool's leftovers.

---

## 8. Doctrine worth reading before changing anything

- **`ARCHITECTURE-SPINE.md`** — BM-1…BM-23. BM-18/18.1 (`--modules`), BM-19 (`deploy` refuses `--repos`),
  BM-21 (mode-uniform payload), BM-22 (citation + correction discipline), BM-23 (out-of-scope guard).
- **`epic-2-rulings-2026-08-03.md`** — the eight ratifications and the follow-ups, with their evidence.
- **Epic 2 and Epic 3 retrospectives** — where the vacuous-gate pattern is traced across epics.

Three habits this project earned the hard way:

**Probe, don't cite.** Every document agreeing with itself is not evidence. The two worst defects were
found by running the real binary against a real repo.

**Ask what input makes this assertion fail.** If there is none, it is decoration — including in a document
that specifies the work.

**Walk the manual gate deliberately.** SM-3's first real `--apply` caught a defect that 313 tests, five
review instruments and three epics did not.
