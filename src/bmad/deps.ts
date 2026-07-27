// The `bmad-manager` effect seam + the shared ledger records (Story 2.2, AC5/AC6 — BM-5/BM-7/BM-14/BM-15).
//
// TWO THINGS LIVE HERE, and nothing else:
//   1. The AD-2 convergence RECORDS — `PlanProjection`, `RepoResult`, `LegCtx`, `InstallLeg`. Each is
//      defined exactly ONCE; every command imports these and none forks its own. They are the only
//      shapes that cross a module boundary inside the slice.
//   2. The `BmadDeps` SEAM (BM-7) — every effect the family can perform, behind an injected object, plus
//      the `defaultBmadDeps()` factory that wires the real `src/proc`/`src/git`/`src/fsx`/`src/report`.
//      No unit anywhere in `src/bmad/` may reach for raw `spawnSync`/`git`/`fs`/`console`; it goes here.
//
// THE INTENT/OUTCOME SPLIT IS LOAD-BEARING (BM-14 — the Epic-5 `--brain` defect class). `PlanProjection`
// is the INTENT: what a run WOULD do. It is populated identically in dry-run and under `--apply`, and it
// is the ONLY thing SM-3's "same plan" equality compares. `RepoResult.stagedPaths`/`committed`/`pushed`
// are literal OUTCOMES: what a run actually DID (`[]`/`false`/`false` in dry-run, always). A future dev
// who folds an outcome into `planned` — or asserts sameness over an outcome field — reintroduces exactly
// the silent dry-run/apply divergence FR-5 exists to forbid. Keep the two halves apart.
//
// D4/NFR3 identity-free (the live `check:no-consumer-ids` gate scans this file): `bmadBin`, `backupRoot`,
// `manifestPath`, and `estateModulePath` are all RESOLVED from the injected `env` or from this package's
// own location — never baked. A `~/.local/bin/bmad` or a machine-owner path here would be a D4 violation.
//
// D1 core purity: a Bun edge, so `node:os`/`node:path` and `process` are legal here and forbidden in core.

import { cpSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWrite, ensureDir, exists, readIfExists } from "../fsx/index";
import { git } from "../git/index";
import { spawnCapture, type SpawnOptions, type SpawnResult } from "../proc/index";
import { emitJson, jsonOutput, lines, log, type Lines } from "../report/index";
import { type BmadRepo, resolveManifestPath } from "./manifest";
import type { BmadOpts } from "./opts";

/** Per-repo terminal state. `skipped-gitignored` is a NON-failing skip (FR-13/BM-17), decided in 2.4. */
export type RepoStatus = "ok" | "skipped-gitignored" | "failed";

/**
 * The family's fail-loud error for a WHOLE-RUN precondition fault (Story 2.3, FR-6/BM-3/BM-13) — an
 * incomplete estate module, an unusable `marketplace.json`, an illegal skill name. Modeled on 2.1's
 * `ManifestError` and `src/cli/edge-verify.ts`'s `EdgeVerifyError`: a message-carrying `Error` subclass
 * that sets `this.name`, which `cli.ts` maps to exit 1 in ONE place.
 *
 * Deliberately DISTINCT from `ManifestError`. That one means "the caller's estate.toml is wrong"; this
 * one means "the module this package ships, or the flags naming into it, are wrong". Collapsing them
 * would make a shipped-payload defect read to the operator as a config typo.
 *
 * It is NOT the type for a per-repo fault: a failing backup or a non-zero installer exit becomes that
 * repo's `status:'failed'` row and the batch continues (FR-15/BM-16). A `BmadError` aborts everything,
 * which is only ever correct BEFORE the first repo is touched.
 */
export class BmadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BmadError";
  }
}

/**
 * What a run INTENDS to do to one repo (BM-14). Computed ONCE per repo by `pipeline.buildPlan`, before
 * the apply gate, and threaded unchanged into both the dry-run render and the `--apply` execution.
 *
 * Every field is an intent, never a result — read `wouldStage` as "the set staging would touch", not
 * "the set staging touched". The outcome half lives on {@link RepoResult}.
 */
export interface PlanProjection {
  /** The `bmad …` argv the leg authored (BM-15). The pipeline never inlines this; the leg owns it. */
  installArgv: string[];
  /** `<backupRoot>/<repo-name>/<clock()>` (BM-8). The backup itself is written in 2.3. */
  backupPath: string;
  /** The scoped staging set. STORY 2.4 computes it for real; seeded `[]` here so the shape is provable. */
  wouldStage: string[];
  /** Whether a commit would be made. STORY 2.4; seeded `false` here. */
  wouldCommit: boolean;
  /** `= opts.push`. An INTENT, independent of `apply` — a dry run still reports that it would push. */
  wouldPush: boolean;
}

/**
 * The per-repo ledger row — the sole record that crosses every boundary in the family (BM-5). One
 * definition; `install`/`update`/`deploy`/`verify` all report in this shape, and `batch` aggregates it.
 */
export interface RepoResult {
  /** The `--repos` match key (2.1's `repoName`), not the path — the path is machine-owner identity. */
  repo: string;
  status: RepoStatus;
  /** Provisional in 2.2 (read off the Manifest entry); the LIVE git read is 2.4. */
  branch: string;
  /** Commits ahead of upstream, or `"no-upstream"`. Provisional in 2.2; live read is 2.4. */
  ahead: number | "no-upstream";
  /** Set once a backup has actually been WRITTEN (2.3). Distinct from `planned.backupPath` (intent). */
  backupPath?: string;
  /** The INTENT (BM-14). The only field SM-3's dry-run/apply equality compares. */
  planned: PlanProjection;
  /** OUTCOME — what staging actually touched. Always `[]` in dry-run; filled by 2.4. */
  stagedPaths: string[];
  /** OUTCOME — always `false` in dry-run; set by 2.4. */
  committed: boolean;
  /** OUTCOME — always `false` in dry-run; set by 2.4. */
  pushed: boolean;
  /** Fail-loud message or the `skipped-gitignored` explanation (2.4/BM-11/BM-17). */
  reason?: string;
}

/**
 * Everything a leg needs to author its argv (BM-15). Constructed by `pipeline.buildPlan` from its own
 * parameters and handed to `leg.buildArgv` — the leg reads the repo, the flags, and the resolved binary
 * paths, and returns a string array. It performs no effect itself.
 */
export interface LegCtx {
  repo: BmadRepo;
  opts: BmadOpts;
  /**
   * The RESOLVED-VALUE members only — never the effect surface. `buildPlan` calls `buildArgv`
   * unconditionally, BEFORE the `--apply` gate, so a leg that reached `exec`/`git`/`fs.atomicWrite`
   * through this field would run IO during a dry run — the exact leak AC4 exists to prevent, and one
   * no test would catch because the leg would look like it was only authoring argv. Narrowing the type
   * makes that a compile error instead of a review question. If a later leg genuinely needs another
   * member, widen {@link LegDeps} deliberately and say why — do not reach for the full seam.
   */
  deps: LegDeps;
}

/** The effect-free slice of {@link BmadDeps} a leg may read while authoring argv. */
export type LegDeps = Pick<BmadDeps, "bmadBin" | "manifestPath" | "estateModulePath" | "backupRoot">;

/**
 * The per-command "what does this run DO to a repo" strategy (BM-15). `install.ts`/`update.ts`/
 * `deploy.ts` each build their own and pass it DOWN into the pipeline; the pipeline never authors a
 * `bmad` argv, so an install-rule change can never leak into the update rule.
 */
export interface InstallLeg {
  kind: "install" | "update";
  buildArgv(ctx: LegCtx): string[];
}

/**
 * The single injected effect seam (BM-7). Production wiring is {@link defaultBmadDeps}; tests pass a
 * fake — including one whose mutating members THROW, which is how AC4's zero-IO guard is expressed.
 */
export interface BmadDeps {
  /** Subprocess — `src/proc`'s never-reject, never-hang `spawnCapture`. Not called at all in 2.2. */
  exec(cmd: string, args: string[], opts?: SpawnOptions): Promise<SpawnResult>;
  /** `git -C <repo> <args>` — `src/git`'s fail-soft wrapper. Not called in 2.2 (git behavior is 2.4). */
  git(repo: string, args: string[]): string;
  /**
   * The filesystem slice of the seam — `src/fsx`, plus the ONE primitive std does not ship.
   *
   * CONCRETIZED IN 2.3 (2.2 declared the read/write trio; the backup and the BM-12 staging materializer
   * are the first real writers). `exists` and `cpDir` are the two additions.
   *
   * `cpDir` IS THE FSX GAP, and it is deliberate: `src/fsx` exports no recursive-copy primitive, and
   * hand-rolling one out of `walkFiles` + `atomicWrite` would CORRUPT any non-text asset, because
   * `atomicWrite` takes a `content: string`. FR-7 asks for a byte-faithful, reversible snapshot, so the
   * platform's own `cpSync(src, dest, {recursive:true})` is the reuse (wired in {@link defaultBmadDeps};
   * `node:fs` is edge-legal here per D1). It is NOT promoted into `src/fsx`: this slice is its only
   * caller today (Rule-of-Three unmet). Promote it at the second caller, not before.
   *
   * Every member is on the SEAM rather than imported directly so a test can make a write THROW — which
   * is how both the AC4 zero-IO-in-dry-run guard and the AC3 no-self-copy guard are expressed.
   */
  fs: {
    readIfExists(path: string): string | null;
    exists(path: string): boolean;
    atomicWrite(path: string, content: string): void;
    ensureDir(dir: string): void;
    /** Recursive, byte-faithful directory copy. Creates `dest` and any missing parents. */
    cpDir(src: string, dest: string): void;
  };
  /**
   * The render seam. `lines`/`jsonOutput`/`emitJson`/`log` are `src/report`'s shipped primitives — the
   * family composes them and re-implements neither the line-builder nor the `--json` writer (NFR-4).
   *
   * `print` is the ONE stdout write for human markdown, and it exists so the human path is injectable
   * too: a bare `console.log` in a command scaffold would bypass `BmadDeps` entirely and break BM-7/AC6.
   * `emitJson` stays JSON-only (under `--json` it is the only thing on stdout); `log` stays stderr.
   */
  report: {
    lines(): Lines;
    jsonOutput(data: unknown): string;
    emitJson(data: unknown): void;
    log(msg: string): void;
    print(msg: string): void;
  };
  /** Injected time (BM-8). A fixed clock in tests is what makes two runs' `backupPath` comparable. */
  clock(): string;
  /** The `bmad` binary (BM-3) — `$BMAD_BIN`, else the bare name for `PATH` resolution. Never a path literal. */
  bmadBin: string;
  /** The estate Manifest path (BM-2) — 2.1's `resolveManifestPath`. */
  manifestPath: string;
  /** The `bmad-estate/` payload dir this package ships (BM-13) — resolved, never baked. */
  estateModulePath: string;
  /** Backup tree root (BM-8) — under `$XDG_STATE_HOME`, else the XDG default. */
  backupRoot: string;
}

/**
 * Wire the real edges into a {@link BmadDeps} (AC6). `env` is a parameter, not a `process.env` read
 * inside each resolver, so tests can pin every resolution branch without mutating the process
 * environment — the same discipline 2.1's `resolveManifestPath` uses.
 */
export function defaultBmadDeps(env: NodeJS.ProcessEnv = process.env): BmadDeps {
  return {
    exec: spawnCapture,
    git,
    fs: {
      readIfExists,
      exists,
      atomicWrite,
      ensureDir,
      // The one non-fsx member (see the `fs` doc): std ships no recursive copy, and `atomicWrite` is
      // string-only, so a hand-rolled walk would not be byte-faithful. `cpSync` is the platform's.
      cpDir: (src: string, dest: string) => cpSync(src, dest, { recursive: true }),
    },
    report: {
      lines,
      jsonOutput,
      emitJson,
      log,
      print: (msg: string) => {
        process.stdout.write(msg);
      },
    },
    clock: () => new Date().toISOString(),
    // BM-3: the bare name resolves through `$PATH` at spawn time. `$BMAD_BIN` overrides for a
    // non-PATH install. Baking `~/.local/bin/bmad` here would be the D4 identity trap Story 1.1 flagged.
    bmadBin: env.BMAD_BIN || "bmad",
    manifestPath: resolveManifestPath(env),
    estateModulePath: resolveEstateModulePath(env),
    backupRoot: resolveBackupRoot(env),
  };
}

/**
 * The backup tree root (BM-8): `$XDG_STATE_HOME/std/bmad-manager/backups`, falling back to the XDG
 * default `<home>/.local/state`. Auto-prune is explicitly deferred by BM-8 — this only names the root.
 */
function resolveBackupRoot(env: NodeJS.ProcessEnv): string {
  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "std", "bmad-manager", "backups");
}

/**
 * The `bmad-estate/` payload dir this package ships (BM-13): `$BMAD_ESTATE_DIR` wins, else the package
 * root's `bmad-estate/`, reached RELATIVE to this file (`src/bmad/` → up two → package root). Mirrors
 * `bmad.test-helpers.ts:resolveEstateModule` exactly — the same resolution rule, one per surface, because
 * that helper is test-only fixture support and this one is the shipped seam.
 */
function resolveEstateModulePath(env: NodeJS.ProcessEnv): string {
  return env.BMAD_ESTATE_DIR || join(import.meta.dir, "..", "..", "bmad-estate");
}
