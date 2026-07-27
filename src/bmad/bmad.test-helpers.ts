// Fixture support for the `src/bmad/` dual-surface proof suite (Story 1.2, BM-9). This is the FIRST
// file under `src/bmad/` — the slice's shipped surface (the `install`/`verify`/`deploy` command family)
// is all Epic A; here only a test + this helper land. Mirrors `src/cli/edge-deploy.test-helpers.ts`'s
// role: a not-shipped fixture module that happens to need a home. NEVER exported from any `index.ts`,
// and there is no `src/bmad/index.ts` this story (no speculative surface — Rule-of-Three).
//
// IDENTITY-FREE (D4/NFR3, the identity trap the live 1-5 gate enforces): this file is `*.test-helpers.ts`,
// NOT `*.test.ts`, so the no-consumer-ids / dep-root / single-source gates DO scan it. It therefore bakes
// in NO consumer path: the `bmad` binary resolves from `$BMAD_BIN`/PATH (BM-3), the estate module resolves
// relative to the package root via `import.meta.dir`/`$BMAD_ESTATE_DIR` (BM-13), and scratch repos live
// under `os.tmpdir()`. No `/Users/...` literal appears here.
//
// std reuse (build less): `spawnCapture` from `src/proc` is the one subprocess primitive — never-reject,
// never-hang, `{stdout,stderr,code}`, missing binary → 127. `git init` shells through it (BM-9).

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnCapture } from "../proc/index";

/** A disposable `git init`-ed scratch repo in a temp dir. `cleanup()` `rm -rf`s it (call it in `finally`). */
export interface ScratchRepo {
  /** Absolute path to the fresh temp repo. */
  readonly dir: string;
  /** Recursively removes `dir`. Idempotent; safe if the dir is already gone. */
  cleanup(): Promise<void>;
}

/**
 * Make a fresh temp dir under `os.tmpdir()` and `git init` it via `spawnCapture` (BM-9's disposable
 * `git init` — no committed fixture tree). Returns the dir and a `cleanup()`. On a `git init` failure the
 * partial dir is removed and the error is thrown loud (with `git`'s stderr) rather than leaking a temp dir.
 */
export async function makeScratchRepo(): Promise<ScratchRepo> {
  const dir = await mkdtemp(join(tmpdir(), "bmad-scratch-"));
  const init = await spawnCapture("git", ["init", dir]);
  if (init.code !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`git init failed (code ${init.code}) in ${dir}: ${init.stderr.trim()}`);
  }
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** How a synthetic estate module should be built. Every field is optional; the defaults are a valid module. */
export interface EstateSpec {
  /** Skill dirs created WITH a file — the shape the FR-6 guard must accept. */
  skills?: string[];
  /**
   * Skill dirs created EMPTY. A present-but-empty skill is a half-family wearing a directory: it sails
   * past an exists-only guard and installs nothing. Fixtures must be able to produce it, or the case
   * cannot be tested at all — which is how that hole survives review.
   */
  emptySkills?: string[];
  /** Replaces the `.claude-plugin/marketplace.json` body. A `null` writes NO marketplace file. */
  marketplace?: unknown;
}

/**
 * Build a throwaway `bmad-estate`-shaped module under `os.tmpdir()` and return its path — the value a
 * test injects as `deps.estateModulePath` (BM-13). Never the real shipped `bmad-estate/`: a unit test
 * that reads the package's own payload would pass or fail on whatever that payload happens to contain.
 *
 * The caller owns cleanup ({@link removeTempTree}).
 */
export function makeEstateModule(spec: EstateSpec = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "bmad-estate-"));
  const skills = spec.skills ?? ["bmad-agent-jhon-the-loop", "bmad-agent-epic-the-loop"];

  for (const skill of skills) {
    const skillDir = join(dir, "skills", skill);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `# ${skill}\n`, "utf-8");
  }
  for (const skill of spec.emptySkills ?? []) {
    mkdirSync(join(dir, "skills", skill), { recursive: true });
  }

  const marketplace =
    spec.marketplace === undefined
      ? {
          name: "estate-fixture",
          plugins: [{ name: "estate-fixture", source: "./", skills: skills.map((s) => `./skills/${s}`) }],
        }
      : spec.marketplace;
  if (marketplace !== null) {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    const body = typeof marketplace === "string" ? marketplace : JSON.stringify(marketplace, null, 2);
    writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), body, "utf-8");
  }
  return dir;
}

/** `rm -rf` a temp tree. Idempotent and never throws — safe in an `afterAll` that may run twice. */
export function removeTempTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Resolve the `bmad-estate/` payload dir (the module this proof installs), NEVER as a baked absolute
 * (BM-13, D4). `$BMAD_ESTATE_DIR` wins when set; otherwise it is the package root's `bmad-estate/`,
 * reached relative to this file (`src/bmad/` → up two → repo root → `bmad-estate`).
 */
export function resolveEstateModule(): string {
  const override = process.env.BMAD_ESTATE_DIR;
  if (override && override.length > 0) return override;
  return join(import.meta.dir, "..", "..", "bmad-estate");
}

/**
 * Resolve the `bmad` binary: `$BMAD_BIN` → first `bmad` on `$PATH` → `null`. The `null` is the AC7 SKIP
 * signal — on CI (GitHub Actions, no `bmad` on PATH) the proof suite reports skipped, never 127-red.
 * Never a baked path (BM-3, the identity trap).
 */
export function resolveBmadBin(): string | null {
  const override = process.env.BMAD_BIN;
  if (override && override.length > 0) return override;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, "bmad");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
