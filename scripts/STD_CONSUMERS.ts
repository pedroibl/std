// STD_CONSUMERS — the AD-3 promotion registry: who consumes std, recorded once, by the gate.
//
// This is the **adoption record AND the AD-4 migration blast-radius list** (double duty). A consumer
// earns an entry only by being a REAL caller that links std via `bun link` (the AD-3 gate) — never
// speculatively. With zsh-planning (Epic 4) + loom (Story 5.1) as real bun-link callers, std/cli is
// **[PROMOTED]** as of 2026-06-29 via that gate. Promotion is **not** an `@pedroibl/std` publish and
// **not** an API-stability bless — it's internal infra with no public contract (AD-3).
//
// Lives in `scripts/` (tooling), NEVER `src/` — it names consumer identifiers, and the no-consumer-ids
// gate scans `src/**` only (so this file can never self-flag; D4/NFR3 hold). It is deliberately NOT
// wired into `check-no-consumer-ids.ts`: that gate's denylist is a SUPERSET (it also carries `zshstd`,
// the hand-mirror that links nothing), so deriving the denylist from here would silently drop `zshstd`.
// Keep the two independent. [Pedro's call, 2026-06-29]
//
// Serialization (AD-3): entries are sorted by `name`, one per record. A same-name collision across two
// branches surfaces as a git merge conflict, never a silent merge — the human checkpoint. The test
// beside this file asserts sorted + unique, making that invariant mechanical.
//
// Forward context: loom is slated to be dismembered into 2–3 more-focused tools, with std as their
// shared substrate — so this list is built to scale to N entries cleanly (flat, append-only, no
// per-consumer special-casing). It stays a plain record: NO migration machinery (AD-4.4 deferred, CM1).

/** One std consumer. `surface` = which std slice(s) it consumes; `adopted` = how it links std. */
export interface Consumer {
  /** Repo/tool basename — the unique key. */
  name: string;
  /** Where it lives (path + git remote where applicable). */
  repo: string;
  /** How it links std. Today always "bun link" (NFR7; never `file:../`). */
  adopted: "bun link";
  /** The std slice(s) it consumes. */
  surface: string;
  /** Optional honest annotation when the live state needs context. */
  note?: string;
}

/** The closed adoption record. Sorted by `name`; one entry per consumer (AD-3 serialization). */
export const STD_CONSUMERS: readonly Consumer[] = [
  {
    name: "loom",
    repo: "~/Dev/loom (gitlab: pedroibl/loom)",
    adopted: "bun link",
    surface: "cli",
    note: "2nd caller, Story 5.1 — the AD-3 gate that promoted std/cli. Makefile shims gates/brief → std-cli.",
  },
  {
    name: "sesh-harvest",
    repo: "~/.claude/Bin/sesh-harvest",
    adopted: "bun link",
    surface: "core; future proc/fsx",
    note: "Deliberate std consumer (linked by design) that also depends on loom at runtime (shells `loom` to export a Claude Code session, then slices it). Live source currently shells loom with no live `from \"std/…\"` import. Natural future surface: proc (subprocess) + fsx (backup-dir harvest) once AD-9 plumbing lands.",
  },
  {
    name: "zsh-planning",
    repo: "~/Dev/zsh-planning (gitlab: pedroibl/zsh-planning)",
    adopted: "bun link",
    surface: "cli",
    note: "1st caller, Epic 4 — Makefile shims gates/brief → std-cli.",
  },
];

/** Consumer basenames (the blast-radius keys). Convenience for tooling that needs just the names. */
export function consumerNames(): string[] {
  return STD_CONSUMERS.map((c) => c.name);
}
