# `_CreateStdTool` improvement notes — the harvester dogfood (Story 11.1 → input to 11.3)

> Captured by the 11.1 dev-story (Amelia, 2026-06-30). These are the deltas between the **Task-0 generated
> output** (`proof/harvester.generated.ts`, verbatim) and the **hand-corrected tool** (`proof/harvester.ts`).
> Story 11.3 applies them to the `_CreateStdTool` skill SoT (`~/Dev/std-customisations/`). This file is the
> manual prototype of the Epic-15 harvest→repo loop. Do NOT edit the generated capture — it is the evidence.

## How to read these

Each note is tagged with the concrete skill change it implies: **[Gotcha]** (SKILL.md/Gotchas),
**[Brain]** (`References/StdSubstrate.md` correction), **[Workflow]** (`Workflows/CreateStdTool.md` step), or
**[ADR]** (`docs/DECISIONS.md`). `brain-check.ts` is **green** (6/0/0) — the brain's 19 cited signatures all
match live std-public, so these are *additions/sharpenings*, not drift fixes.

## 1. The three wrong std imports — the headline finding (the generator guessed sub-paths)

The generated scaffold emitted three imports that do not resolve against live std-public (`b56b212`):

| Generated (WRONG) | Correct | Why |
|---|---|---|
| `import { charOverlap } from "std/core/similarity"` | `from "std/core"` | There is **no `std/core/similarity` export key**. `similarity.ts` is internal; everything rides the `./core` barrel. |
| `import { args as parseArgs } from "std/core"` + `parseArgs({options})` | `import { flagValue, hasFlag } from "std/core"`, parse per-flag | `core/args` is **per-flag** (`positional`/`flagValue`/`hasFlag`/`dispatch`). There is **no `args` export** and no `node:util parseArgs({schema})→{values}` shape. |
| `import { writeIfAbsent } from "std/fsx"` | `from "std/report"` | `writeIfAbsent` is an **FR9 report** export. `fsx` exports `walkFiles`/`ensureDir`/`readIfExists`/`atomicWrite`/`loadJson`/`saveJson`. |

- **[Brain]** Add an explicit **import-surface table** to `StdSubstrate.md`: every primitive → its *exact*
  export key (`std/core` | `std/fsx` | `std/report` | `std/proc` | `std/git` | `std/http`). The generator
  guessed plausible-but-wrong sub-paths (`std/core/similarity`) and a wrong slice (`writeIfAbsent` from fsx).
  A flat name→key map kills all three at once. The barrel rule ("everything in `core/*` re-exports through
  `std/core`, never `std/core/<file>`") should be stated once, loudly.

## 2. CONVERGE vs selectable-parity — the generator reproduced both originals via mode flags

For a clone-pair merge, the scaffold produced a **selectable-parity** design — a `Modes` record
(`globalRecent` / `dedupLearnings` / `flatOutput`) that reproduces *each* original through flags. The 11.1
deliverable is the opposite: **CONVERGE** to the superset (project-aware) and fold the minority behavior
(cross-session dedup) in as the unconditional default. All three mode flags were dropped.

- **[Workflow]** When the task is "collapse a ~90% clone-pair", add a branch prompt: **CONVERGE (one shape,
  the superset; fold the minority behavior in as default)** vs **PRESERVE (selectable parity)** — default to
  CONVERGE, and do **not** emit mode/switch flags unless the user explicitly asks for selectable parity.
  Selectable-parity is the more code, more surface, lower-value default.

## 3. Async-cast file read — a real correctness bug in the scaffold

The scaffold read sessions with `Bun.file(ref.path).text() as unknown as string` — a `Promise<string>` cast
to `string`. That is a silent bug (the harvest/mine loops would operate on a Promise, not text).

- **[Brain]** State the sync-edge read idiom: use `node:fs readFileSync(path,"utf-8")` (or `fsx.readIfExists`)
  for a synchronous edge; **never cast `Bun.file().text()` (a Promise) to a string**. The whole tool here is
  sync (the originals are), so a sync read is the right default.

## 4. `import.meta.main` guard — testability

The scaffold called `main()` unconditionally at module top level, so *importing* the module (as the self-test
does) fires the CLI. The corrected tool guards with `if (import.meta.main) process.exit(main(Bun.argv.slice(2)))`.

- **[Workflow]/[Gotcha]** The generated tool template should always end with the `import.meta.main` guard and a
  `main(argv): number` that takes argv as a parameter — so the self-test can drive `main`/the exported run
  functions without spawning a process.

## 5. What the generator got RIGHT (keep these)

- It **flagged the substrate gaps inline** (`⟨11.2⟩` / `⟨EDGE⟩` markers) instead of silently hand-rolling
  around them. That behavior is correct and should be a *documented workflow output*: emit a gap marker where
  a std primitive doesn't fit, never a silent local re-roll with no note.
- It correctly **kept the PAI edge in the tool** (catalogs, write-layout, `projectLabel`, confidence formula,
  injected roots) and named the map/reduce seam. The D4 boundary instinct was right.

## 6. ADR-0011 Option-B gate — the door fact 11.1 surfaced

- **[ADR]** The **citizen door is empirically proven**: `smoke-gate.ts --door citizen` is **all-pass**
  (`door-install` ok · `smoke-help` ran clean, 1010 b · `two-repo` std → std-public via the global link ·
  `no-std-cli` clean). Citizen resolution works at the std home — the one fact ADR-0011 left open. This
  **un-defers ADR-0011 Option B**; `harvester` ships **citizen-default** (AD-9.1), binary-compile remains the
  documented fallback (it does not scale to the Epic-12 ~80-tool sweep). Update the ADR-0011 Option-B gate
  from "deferred until Story 11.1 closes" → "proven; citizen-default adopted".

---

### Substrate-gap findings (the 11.2 input — already banked in `sprint-status.yaml`; confirmed, not duplicated)

All five were hit exactly as predicted and handled **locally in the tool** (11.1 changed no std code):

1. **`parseNdjson` drops the raw line index** the mine path stamps as `sourceLine` → manual 1-based counter
   over `raw.split("\n")` in `mineMemories`. *11.2: line-preserving `parseNdjson` variant or `sourceLine`
   semantics change.*
2. **`fsx.saveJson` appends a trailing `\n`** → Δ2 (1-byte queue diff vs the originals). *11.2: accept as
   canonical, or a no-newline option.*
3. **`text.truncate` is char-boundary-aware ≠ raw `.slice`** → kept raw `.slice(0,500)`/`.slice(0,300)` for
   content/context. *11.2: leave as-is (truncate is for display, not data).*
4. **`core/args` is per-flag, not `parseArgs({schema})`** → CLI parsed per-flag with `flagValue`/`hasFlag`.
   *11.2: add a record-parse mode only when a 2nd consumer needs it (D2).*
5. **`fsx` has no `stat`/`mtime` helper** → discovery reads `statSync(p).mtimeMs` at the edge. *11.2: candidate
   `fsx.stat`/`statMtime` gap — the most likely real promotion of the five.*
