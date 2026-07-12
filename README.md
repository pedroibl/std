# std

Pedro's personal **standard** — one shared Bun + TypeScript vocabulary, so reports, notes, and
CLIs stop re-inventing the same patterns in every repo.

> Not greenfield. This consolidates patterns already proven across `loom/scripts`
> (`report-builder.ts`, `glab.ts`) and the Obsidian helpers (zDrafts `cn.ts`, note-report
> `dashkit.ts`) into one home.

## The runtime split (the load-bearing decision)

The same vocabulary, rendered several ways. The runtime boundary **is** the module boundary.

| Slice | Runtime | Produces | Consumed by |
|-------|---------|----------|-------------|
| `core` | none (pure) | vocabulary: `cite`, severity, stat, counts, `parseSprint`/`summarize`, **`bar`**; plus the extraction kits — `parse`, `text`, `markdown`, `date`, `similarity`, `args`/`dispatch` | everything |
| `report` | Bun | markdown **string** (`p()`, `--json`, atomic safe-write) | loom, sesh-harvest, scripts, functions |
| `cli` | Bun | manifest-driven gate dispatcher (`std` on PATH) | zsh-planning, loom |
| `glab` | Bun | `glab api` wrapper + git-remote-first repo resolution | per-repo Makefiles |
| `proc`·`git`·`http`·`fsx` | Bun | plumbing edges: `spawnCapture` · `git(repo,args)` · `fetchWithTimeout`/`httpJson` · `walkFiles`/`atomicWrite`/`loadJson` | PAI/Tools rewrites |
| `cn` | Obsidian (**zDrafts** vault) | **DOM** (JS Engine + CSS tokens, `cn-`) | zDrafts creative notes |
| `dashkit` | Obsidian (**note-report** vault) | **DOM** (dashboards, `dk-`) | note-report progress dashboards |

`core` holds *what a citation / severity / stat / sprint-summary / progress-bar is*. `report`, `cn`, and `dashkit`
are renderers of that same vocabulary — one becomes a string, the other two become live DOM. `cn` and
`dashkit` are **two vault-pinned Obsidian edges** — sibling slices that never cross, because each is
tied to a different vault's plugin contract.

## Design rules

- **No `dist/`** for the Bun slices — Bun imports `.ts` directly. (A `dist` build only ever
  appears if `cn`'s Obsidian types get published for external use.)
- **Tests first.** Every primitive ships with a `*.test.ts` beside it. Run `bun test`.
- **A module only exists when a 2nd caller needs it.** Until then it's a function in a file.
- **Pure core, side-effects at the edge** — `core` never touches the filesystem, DOM, or network.
- **Caller-local identity is Pedro's, not the PAI template's (D4).** The `proof/` PAI-tool rewrites carry
  personal config as caller-local identity (never in `src/`). Those defaults are set to **Pedro's actual
  data**, not the upstream PAI template placeholders: timezone is **`Australia/Melbourne`** (Pedro is in
  Melbourne, AU — not `America/Los_Angeles`); the primary DA defaults to **`tome`** (the real
  `~/.claude/PAI/USER/DA/tome` — not `kai`); units are metric (°C, km, m). Fixed 2026-07-12 in
  `proof/da-growth.ts` (`TZ`, `parsePrimaryDA` fallback) and `proof/arthur.ts` (time-window `defaultTz`).
  The **live** `~/.claude/PAI/TOOLS/*` copies may still carry the template defaults — correct them during
  the AD-9.2 cutover.

## Usage

```ts
import { cite } from "std/core";

cite("scripts/glab.ts"); // → "`scripts/glab.ts`"
```

## Consumers

`std` is the **doctrinal root** of Pedro's personal standard; consumers adopt it via `bun link` (dev)
or `workspace:*` (CI), and import nothing back (clean dependency root).

- **zsh-planning** — the **first conforming consumer across the runtime wall** (zsh ↔ Bun/TS share no
  executable code; the severity vocabulary is hand-mirrored by design). It shipped its v2 ZDOTDIR
  cut-over (2026-06-28). Its post-cut-over shape — shell layout, the 10-stage `make gates` aggregate,
  repo-nav deploy target — is **owned by the companion `zsh-planning/STD-DOCTRINE.md`**; std
  *references* it, never copies it. `std-cli` (Phase 1) retires its Makefile by dispatching to its
  native scripts.
- **sesh-harvest** — `bun link`-ed today (distribution proven); first in-code consumer once `core`/`cli` export.
- **note-report vault** — live consumer of std's `sprint-status.yaml` via `dashkit` (the slice above).
- **PAI Inference** (`~/.claude/PAI/TOOLS/Inference.ts`) — a future **`http`-slice** consumer. It
  migrated off the subprocess pattern (it was one of `proc`'s three Rule-of-Five witnesses, "an LLM
  inference call") to a direct HTTP call — Anthropic Messages API primary + OpenRouter fallback —
  which open-codes exactly `http`'s `fetchWithTimeout` envelope. The E11–E14 PAI/Tools extraction
  rewrites it to import `std/http`; until then it is a **pattern** consumer, not a `bun link` one, so
  it is intentionally **not** in `scripts/STD_CONSUMERS.ts` (that registry's test enforces `bun link`).

## Status

Enforcement harness + `core` + the Bun edges are **live and green** (759 tests on `main`, 4 CI gates + typecheck).
Canonical repo: **github.com/pedroibl/std**; merge on green GitHub Actions gates.

- **Phase 1 ✅** — Epic 1 CI gates (core-purity · dep-root+no-cycle · single-source · no-consumer-ids),
  Epic 2 `core` vocabulary, Epic 3 `glab`, Epic 4 `std-cli` (manifest-driven dispatcher on PATH).
- **Phase 2 ✅** — Epic 5 second-caller rollout (the AD-3 promotion: zsh-planning + loom on `std-cli`).
- **Phase 3 ✅** — Epic 6 `report` (FR7/8/9), **Epic 9 core extraction kit** (`parse`/`text`/`markdown`/
  `date`/`similarity`), **Epic 10 Bun-edge plumbing** (`core/args`·`proc`·`git`·`http`·`fsx`, AD-9).
- **Phase 4 ✅** — Epic 11 mutual proof gate (collapsed the harvester clone-pair onto the substrate while
  grounding the `_CreateStdTool` generator). Survived contact.
- **Phase 5 (Epic 12, tool sweep) — in progress.** 12.1 backup-harvester pair ✅ · **12.2 ✅** —
  `core.bar` promoted from 4 re-rolled progress bars + three self-contained CLIs rewritten onto the
  substrate into `proof/`; the live `~/.claude/PAI/TOOLS/algorithm.ts` swap is deferred to the **AD-9.2**
  vendored-submodule batch cutover (byte-certified in advance by `proof/algorithm-bar-parity.test.ts`).
  **12.3 ✅** — `DocCheck`/`ReferenceCheck` collapsed onto ONE injected-config engine in `proof/` +
  `core.sectionRoots`/`sectionRootAt` + `fsx.exists` + `walkFiles` `opts.prune` promoted (PR #35). **12.4 ✅**
  (PR #37) — `core.getMetaField` promoted + the 12 telos/wisdom/DA/migrate tools rewritten onto the
  substrate in `proof/`; the `core.bar` FR21 promotion is now complete (last 2 of
  4 sites byte-certified by `proof/telos-bar-parity.test.ts`).
- **Last (Phases 8/9)** — the two Obsidian edges `cn` (zDrafts) and `dashkit` (note-report), siblings that
  never cross.

Plugin baseline: each Obsidian edge pins **its own** vault's plugin set — `dashkit`'s is
`note-report/CLAUDE.md` §Plugins (the version SoT, formerly `PLUGINS.md`); `cn`'s lives with the
zDrafts vault.
