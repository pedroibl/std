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

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * The git subcommands that MUTATE something — a repo's index, its history, or a remote (Story 2.4).
 *
 * This list is the instrument behind every "no git write happened here" assertion in the suite, and it
 * is deliberately a DENY-list of writers rather than an allow-list of readers: a reader this file has
 * not heard of is harmless, while a writer it has not heard of must never be waved through by default.
 */
export const GIT_WRITE_SUBCOMMANDS: readonly string[] = [
  "add",
  "commit",
  "push",
  "rm",
  "mv",
  "reset",
  "checkout",
  "switch",
  "restore",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "stash",
  "clean",
  "fetch",
  "pull",
  "tag",
  "branch",
  "apply",
  "am",
  "update-ref",
  "config",
  "init",
  "clone",
  "gc",
  "worktree",
  "remote",
  "submodule",
  "notes",
  "replace",
];

/**
 * A `deps.git` fake that permits READS and explodes by name on any WRITE.
 *
 * THE DISTINCTION IS THE WHOLE POINT (Story 2.4/AC7). Before 2.4 the dry-run and installer suites made
 * `deps.git` throw outright, which read as "the pipeline touches no git". That is the wrong invariant:
 * the live posture read (`rev-parse`/`rev-list`) is side-effect-free and MUST run in dry-run, or a
 * preview reports a stale branch for the repo it is about to change. What must never happen in a dry
 * run — or in 2.3's installer filter — is a git WRITE, and that is what this fake pins.
 *
 * `read` supplies the stdout for permitted reads; the default `""` matches `src/git`'s own fail-soft
 * return for a path that is not a repo, which is exactly what those suites' temp dirs are.
 */
export function readOnlyGit(
  label: string,
  read: (repo: string, args: string[]) => string = () => "",
): (repo: string, args: string[]) => string {
  return (repo, args) => {
    const sub = args[0] ?? "";
    if (GIT_WRITE_SUBCOMMANDS.includes(sub)) {
      throw new Error(`git WRITE in ${label}: \`git ${args.join(" ")}\` — reads only here`);
    }
    return read(repo, args);
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

/**
 * Bring a repo to the state a SUCCESSFUL `bmad install` leaves it in: both Surfaces rendered from
 * `moduleRoot`, byte-identical to each other and to the module source (Story 2.6).
 *
 * EVERY SUITE THAT DRIVES THE APPLY PIPELINE NEEDS THIS, and the reason is the whole point of Story 2.6.
 * Since 2.6 the pipeline VERIFIES the post-install state, so an installer fake that exits 0 while writing
 * nothing describes a run that cannot happen on a real machine — and the verify filter fails it, exactly
 * as it should. Before 2.6 that fake was harmless because verify was a no-op stub; it is not harmless now.
 *
 * Deliberately a plain `cpSync`, not a call through any `BmadDeps.fs` seam: this stands in for the
 * EXTERNAL installer's writes, and routing them through the seam would make a suite's write-spy report
 * `bmad-manager` as having copied into the repo — the exact self-copy claim `install.test.ts` asserts is
 * false (FR-8: the installer does all of it).
 */
export function renderInstalledSurfaces(
  repoRoot: string,
  moduleRoot: string,
  skills: readonly string[] = listSkillDirs(moduleRoot),
): void {
  for (const surface of [join(".claude", "skills"), join(".agents", "skills")]) {
    for (const skill of skills) {
      const src = join(moduleRoot, "skills", skill);
      if (!existsSync(src)) continue;
      cpSync(src, join(repoRoot, surface, skill), { recursive: true });
    }
  }
}

/**
 * The skill directory names a module (or a materialized staging source) holds. Fail-soft `[]`.
 *
 * Defaulting {@link renderInstalledSurfaces} to this is what lets a harness point the fake installer at
 * the run's `--custom-source` staging dir and get exactly the skills that run SELECTED — the same set a
 * real `bmad install` would render, rather than everything the estate happens to ship.
 */
export function listSkillDirs(moduleRoot: string): string[] {
  try {
    return readdirSync(join(moduleRoot, "skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
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
