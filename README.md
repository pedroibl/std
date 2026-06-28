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
| `core` | none (pure) | vocabulary: `cite`, severity, stat, counts, `parseSprint`/`summarize`/bar | everything |
| `report` | Bun | markdown **string** | loom, sesh-harvest, scripts, functions |
| `cn` | Obsidian (**zDrafts** vault) | **DOM** (JS Engine + CSS tokens, `cn-`) | zDrafts creative notes |
| `dashkit` | Obsidian (**note-report** vault) | **DOM** (dashboards, `dk-`) | note-report progress dashboards |
| `glab` | Bun | `glab api` wrapper | per-repo Makefiles |

`core` holds *what a citation / severity / stat / sprint-summary is*. `report`, `cn`, and `dashkit`
are renderers of that same vocabulary — one becomes a string, the other two become live DOM. `cn` and
`dashkit` are **two vault-pinned Obsidian edges** — sibling slices that never cross, because each is
tied to a different vault's plugin contract.

## Design rules

- **No `dist/`** for the Bun slices — Bun imports `.ts` directly. (A `dist` build only ever
  appears if `cn`'s Obsidian types get published for external use.)
- **Tests first.** Every primitive ships with a `*.test.ts` beside it. Run `bun test`.
- **A module only exists when a 2nd caller needs it.** Until then it's a function in a file.
- **Pure core, side-effects at the edge** — `core` never touches the filesystem, DOM, or network.

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

## Status

- **Slice 0** ✅ scaffold + `core/cite` (the trust primitive) + passing `bun test`.
- Slice 1 — `glab` (move loom's `glab.ts` logic here, leave a 3-line per-repo wrapper).
- Slice 2 — `report` primitives (`cite` is the first; add `p`, `statusLine`).
- Slice 3 — `cn` (zDrafts vault: CSS-snippet tokens + glue over JS Engine / CodeScript).
- Slice 4 — `dashkit` (note-report vault: dashboards; promotes `core`'s sprint/summary vocabulary,
  then extracted from the vault into `src/dashkit/`). Sibling of `cn`, never crossing.

Plugin baseline: each Obsidian edge pins **its own** vault's plugin set — `dashkit`'s is
`note-report/CLAUDE.md` §Plugins (the version SoT, formerly `PLUGINS.md`); `cn`'s lives with the
zDrafts vault.
