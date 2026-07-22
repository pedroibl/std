// edge-deploy — the generic, edge-agnostic engine that bundles a std Obsidian DOM edge (`src/cn/`,
// `src/dashkit/`, …) into a vault as a single generated artifact, one-shot or resident (`--watch`).
//
//   std <edge> deploy --vault <dir>   ->   <vault>/Scripts/<artifact>
//
// PROMOTED, NOT COPIED (Story 8.3 D-1, the Rule-of-Three / D2/AD-3). Story 7.2 shaped `runWatch(dirs, deps)`
// deliberately "so the promotion is a file move, not a rewrite", and shipped code named Story 8.3's
// `dashkit deploy --watch` as the SECOND caller of this loop in two places (`cn-deploy.test.ts:910`,
// `:1022`). The second caller arrived, so the edge-agnostic machinery moved here: the whole resident
// lifecycle (`runWatch`), the ignore-list (`isBundleRelevant`), the debounce, the build (`buildBundle`),
// the guards (`resolveTarget` + the TOCTOU re-check), skip-if-identical, the `AggregateError` unwrap, and
// the 0/1/2 exit contract. Everything that differs between edges arrives in an `EdgeSpec` — the banner,
// the artifact filename, the entrypoint, the watched dirs, and an optional preflight.
//
// ⚠ THE CLOBBER GUARD KEYS ON A PER-EDGE BANNER PREFIX, NEVER A SHARED LITERAL. A cn-bannered artifact must
// NOT satisfy dashkit's clobber check and vice versa — else the guard is widened, and per the Epic-7 retro
// "a guard you narrow is a guard you wrote": widening is the same act. `spec.bannerPrefix` is the per-edge
// key; the promotion introduces no shared prefix.
//
// BUN EDGE, deliberately NOT inside an edge slice. A slice (`src/cn/`, `src/dashkit/`) is a DOM-only graph;
// putting fs/build code in it would drag node/fs into the graph the bundler walks. This file never
// `import`s from an edge slice either — the entrypoint arrives BY PATH in the spec, so no import edge forms
// (that would put DOM types in the Bun typecheck graph and could make a cycle Gate 5 flags).
//
// NO REPO-SIDE BUILD OUTPUT (D5/NFR6). The in-process `Bun.build()` API returns the artifact in memory and
// we write the text ourselves. Never `--outdir`, never a `dist/` — the only file produced is the one inside
// the caller's vault.
//
// IDENTITY-FREE (D4/NFR3). No vault path, vault name, or vault literal appears here or anywhere in `src/**`.
// The path arrives only as `--vault`; the caller's actual path lives caller-side.

import { watch } from "node:fs";
import { basename, join } from "node:path";

import { flagValue, hasFlag } from "../core/args";
import { atomicWrite, exists, readIfExists } from "../fsx/index";

/**
 * Everything that differs between one Obsidian edge and another. The generic engine is parameterized by it,
 * so `cn-deploy.ts` and `dashkit-deploy.ts` become thin specs + wiring with NO copy of the loop.
 */
export interface EdgeSpec {
  /** "cn" | "dashkit" — used in the `✓ <name>` deploy log line. */
  readonly name: string;
  /** "cn.js" | "dashkit.js" — the artifact basename under `<vault>/Scripts/`, and the `↻` log label. */
  readonly artifact: string;
  /** The slice entrypoint (`src/<edge>/index.ts`), resolved from `import.meta.dir` BY THE CALLER — never absolute. */
  readonly entrypoint: string;
  /** The dirs the bundle MAY contain (AD-5 rule 2), resolved from `import.meta.dir` by the caller — never absolute. */
  readonly watchDirs: readonly string[];
  /** The exact prefix the clobber guard keys on — MUST be per-edge (see the file header). */
  readonly bannerPrefix: string;
  /** Line 1 of every artifact. Emitted via Bun.build's `banner`, so it is inside the build's determinism. */
  readonly banner: string;
  /** The `<edge> deploy` usage line, printed on a bad/absent subcommand (exit 2). */
  readonly usage: string;
  /** The build formats this edge exposes via `--format`. Omit (dashkit) → esm-only, `--format` is not parsed. */
  readonly formats?: readonly ("esm" | "cjs")[];
  /** Optional pre-build vault check (cn's plugin envelope, 7.3). Returns info/warn lines; throws to abort. */
  readonly preflight?: (vault: string) => string[];
}

/** Thrown for every fail-loud condition (AC4). The CLI prints `.message` and exits 1. */
export class EdgeDeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeDeployError";
  }
}

/** Where the bundle lands inside a vault. Pure — no fs touched. */
export function artifactPath(spec: EdgeSpec, vault: string): string {
  return join(vault, "Scripts", spec.artifact);
}

/**
 * Validate that `vault` is a usable Obsidian vault and that the target is safe to overwrite, then return
 * the artifact path. Effectful only in that it STATS — it writes nothing, so the guards unit-test against
 * a temp dir without a build.
 *
 * Fails loud (AC4) when: `vault` is missing/empty; `<vault>` does not exist; `<vault>/.obsidian` does not
 * exist (not an Obsidian vault); or the target file exists WITHOUT this edge's banner prefix (hand-authored,
 * or another edge's artifact — refuse to clobber and tell the user to move it aside).
 */
export function resolveTarget(spec: EdgeSpec, vault: string | undefined): string {
  if (vault === undefined || vault === "") {
    throw new EdgeDeployError("--vault <dir> is required (the Obsidian vault to deploy into)");
  }
  if (!exists(vault)) {
    throw new EdgeDeployError(`vault does not exist: ${vault}`);
  }
  if (!exists(join(vault, ".obsidian"))) {
    throw new EdgeDeployError(`not an Obsidian vault (no .obsidian/): ${vault}`);
  }
  const target = artifactPath(spec, vault);
  const current = readIfExists(target);
  if (current !== null && !current.startsWith(spec.bannerPrefix)) {
    throw new EdgeDeployError(
      `refusing to clobber a hand-authored file: ${target}\n` +
        `  it does not start with the generated banner, so it was not produced by \`std ${spec.name} deploy\`.\n` +
        `  move it aside (e.g. to Scripts/_retired/) and re-run.`,
    );
  }
  return target;
}

/**
 * Render one `BuildMessage` as `file:line:col message`. `String(msg)` yields only `BuildMessage: <text>`
 * — no file, no line — which is not enough to fix a syntax error from a watch log scrolling past.
 */
function formatBuildMessage(msg: unknown): string {
  const m = msg as { message?: string; position?: { file?: string; line?: number; column?: number } };
  const p = m?.position;
  const where = p?.file ? `${p.file}:${p.line ?? 0}:${p.column ?? 0}: ` : "";
  return `${where}${m?.message ?? String(msg)}`;
}

/**
 * Bundle the edge's entrypoint into a single ESM string with the banner as line 1.
 *
 * `target: "browser"` because the artifact runs inside Obsidian (Electron renderer). Host plugin APIs are
 * structural types only, so nothing external is reachable — a test asserts the SOURCE contains no external
 * import (AC3; grepping the OUTPUT is a tautology a bundler defeats). Exactly one output is expected; more
 * than one means the slice grew a code-split boundary and the one-artifact contract broke — fail loud
 * rather than write a partial bundle.
 *
 * No `outdir`, no `minify`, no `sourcemap`, no `splitting` (AC2). `format` is a parameter so cn can keep its
 * pre-authorized `cjs` fallback (7.1 AC8); dashkit is esm-only and never passes anything else.
 */
export async function buildBundle(
  spec: EdgeSpec,
  format: "esm" | "cjs" = "esm",
  entry: string = spec.entrypoint,
): Promise<string> {
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format,
      banner: spec.banner,
    });
  } catch (e) {
    // Bun.build THROWS an AggregateError on a failed build rather than returning `success: false`, and
    // its `.message` is the useless `Bundle failed`. Without this, the resident loop reported a syntax
    // error as `✗ … AggregateError: Bundle failed` with no file, no line, and no diagnostic — the loop
    // survived (AC8) but told you nothing, which is half of what it asks for. Unwrap `.errors`.
    const detail =
      e instanceof AggregateError ? e.errors.map(formatBuildMessage).join("\n") : String(e);
    throw new EdgeDeployError(`bundle failed:\n${detail}`);
  }
  if (!result.success) {
    // ⚠ UNREACHABLE ON BUN 1.3.14 — measured: Bun THROWS (handled above) instead of returning
    // success:false, so no test can turn this line red and reverting it stays green. Kept, and kept
    // using the same renderer as the throw path, because the day a Bun upgrade honours its documented
    // contract this is the branch that runs — and `String(msg)` would silently regress the diagnostic
    // back to a bare `BuildMessage: …` with no file and no line, un-fixing AC3 on a dependency bump.
    throw new EdgeDeployError(`bundle failed:\n${result.logs.map(formatBuildMessage).join("\n")}`);
  }
  if (result.outputs.length !== 1) {
    throw new EdgeDeployError(
      `expected exactly 1 bundle output, got ${result.outputs.length} — the one-artifact contract broke`,
    );
  }
  return await result.outputs[0]!.text();
}

/** Outcome of one build+write cycle. `written: false` means the bytes were already on disk (AC4). */
export type DeployResult =
  | { ok: true; bytes: number; written: boolean }
  | { ok: false; error: string };

/**
 * One full deploy cycle: build in memory, re-check the clobber guard, skip if identical, write
 * atomically, read back. Never throws — every failure comes back as `{ok:false}` so a resident watch
 * loop can report it and survive (AC8). The one-shot path unwraps it into the 0/1 exit code.
 *
 * SKIP-IF-IDENTICAL (AC4): the vault may be on iCloud or watched by Obsidian. Rewriting byte-identical
 * content costs a sync round-trip and makes Obsidian re-read a file that did not change, so an unchanged
 * build does not touch the target at all — its mtime must not move.
 */
export async function deployOnce(
  spec: EdgeSpec,
  vault: string,
  format: "esm" | "cjs",
  entry: string = spec.entrypoint,
): Promise<DeployResult> {
  try {
    const code = await buildBundle(spec, format, entry);
    // RE-CHECK after the await. `resolveTarget` ran before the build, and a real bundle takes long
    // enough that a hand-authored file can appear in that window — writing unconditionally here would
    // defeat the clobber guard entirely, which is the one safety property this command exists to hold.
    const target = resolveTarget(spec, vault);
    if (readIfExists(target) === code) {
      return { ok: true, bytes: code.length, written: false };
    }
    atomicWrite(target, code);
    // Read-back verification, the Makefile discipline: never claim a write we did not confirm landed.
    if (readIfExists(target) !== code) {
      return {
        ok: false,
        error: `read-back mismatch at ${target} — the artifact on disk is not what was built`,
      };
    }
    return { ok: true, bytes: code.length, written: true };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof EdgeDeployError
          ? e.message
          : `deploy failed at ${artifactPath(spec, vault)}: ${e}`,
    };
  }
}

/** Trailing debounce window. One editor save fires several FSEvents; they collapse into one rebuild. */
export const WATCH_DEBOUNCE_MS = 150;

/**
 * Extensions that can never be a bundle input. Everything else is a possible source save.
 *
 * ⚠ `.json`, `.css`, `.txt`, `.yaml` and `.toml` are DELIBERATELY ABSENT — Bun ships default loaders for
 * all of them, so `import tokens from "./tokens.json"` is a real bundle input. Ignoring those extensions
 * would reinstate exactly the silent under-trigger this ignore-list exists to kill. Noisy *specific files*
 * are excluded by basename below instead.
 */
const IGNORED_EXTENSIONS = [
  ".md",
  ".log",
  ".map",
  ".snap",
  ".swp",
  ".swx",
  ".tsbuildinfo",
  ".orig", // merge leftovers
  ".rej",
];

/** Specific noisy files that are never inputs. Excluded by NAME so their extensions stay watchable. */
const IGNORED_NAMES = ["package.json", "tsconfig.json", ".DS_Store"];

/**
 * Whether an event on `filename` could have changed the bundle.
 *
 * ⚠ THIS IS AN IGNORE-LIST, NOT A `.ts` SUFFIX TEST, AND THAT IS LOAD-BEARING. Measured on this machine
 * (Story 7.2 contact check): editors that save via write-temp-then-rename report the TEMP name, never the
 * real one. Claude Code's own edit reported `index.ts.tmp.46812.0e28eeb8a7b3`; `perl -i` reported the
 * extensionless `XX7Eoqmy`. A `filename.endsWith(".ts")` filter drops both — a watcher that prints its
 * banner and then silently never rebuilds, which is precisely the failure this loop exists to prevent.
 * Only an in-place write (shell `>>`, a truncate+write) reports `index.ts`.
 *
 * So: reject what provably cannot matter (test files, docs, lockfiles, editor swap files), and let
 * anything else through. Over-triggering is cheap — the debounce collapses the burst and skip-if-identical
 * means an irrelevant event costs one in-memory rebuild and NO write to the vault. Under-triggering is the
 * expensive failure, because it is silent.
 *
 * A temp suffix is stripped before the checks, so `foo.test.ts.tmp.123.abc` is still recognised as a test
 * file and stays ignored.
 */
export function isBundleRelevant(filename: string): boolean {
  const base = basename(filename)
    .replace(/\.tmp[.\w-]*$/, "") // write-temp-then-rename: `index.ts.tmp.46812.0e28eeb8a7b3`
    .replace(/~$/, ""); // editor backup: `index.ts~`
  // An empty stripped name means a dotfile temp we cannot identify (`.tmp8sK2ax`, `.tmp`). Everywhere
  // else this function's rule is "under-triggering is the expensive failure because it is silent", so
  // an information-free name must resolve to TRIGGER, not drop. A truly empty event filename never
  // reaches here — onEvent's `filename === null` guard and the `""` case both come through as no name,
  // and rebuilding on one costs an in-memory build with no vault write.
  if (base === "") return filename !== "";
  if (/\.(test|spec)\.tsx?$/.test(base)) return false; // a test edit cannot change the bundle
  if (IGNORED_NAMES.includes(base)) return false;
  return !IGNORED_EXTENSIONS.some((ext) => base.endsWith(ext));
}

/** A closed-over watcher handle. The only thing the loop needs from a watcher is the ability to stop it. */
export interface WatchHandle {
  close(): void;
}

/** Close a watcher without letting one bad handle strand the rest — shutdown must always complete. */
function closeQuietly(w: WatchHandle): void {
  try {
    w.close();
  } catch {
    /* already closed / fd gone — nothing to recover, and throwing here would leak the siblings */
  }
}

/** The side-effecting collaborators of the watch loop, injected so tests can drive it with fakes. */
export interface WatchDeps {
  watch: (dir: string, cb: (filename: string | null) => void) => WatchHandle;
  deploy: () => Promise<DeployResult>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  log: (line: string) => void;
  /** Where build failures go. Defaults to `log`; the CLI passes a stderr sink (AC8). */
  logError?: (line: string) => void;
  /** The artifact basename named in the `↻` success line (`cn.js` / `dashkit.js`). Defaults to `bundle`. */
  artifact?: string;
}

/**
 * The resident rebuild loop. Watches `dirs`, and on every relevant (non-test) save runs `deploy` —
 * debounced, serialized, and skipping the write when the bytes are unchanged (that last part lives in
 * `deploy`).
 *
 * RESIDENT BY CONSTRUCTION (AC8): `done` stays PENDING until `stop()` is called. Registering watchers and
 * returning would let `main.ts`'s `process.exit(code)` kill the loop before the first save — a process that
 * prints its banner and then does nothing.
 *
 * SHUTDOWN IS A VALUE, NOT A SIGNAL: `stop()` closes every watcher, clears any pending timer, and resolves
 * `done` with 0. `process.on("SIGINT", …)` is registered by the CALLER — a signal handler (or a
 * `process.exit`) in here could not be unit-tested without killing the test runner.
 *
 * NO `eventType` FILTER: on macOS+Bun a plain content write reports `rename`, not `change`. Filtering on
 * `"change"` yields a watcher that never fires — a feature that starts clean and does nothing. The adapter
 * therefore discards the event type entirely and the filter keys on the filename alone.
 */
export function runWatch(dirs: string[], deps: WatchDeps): { done: Promise<number>; stop: () => void } {
  const logError = deps.logError ?? deps.log;
  const artifact = deps.artifact ?? "bundle";
  let resolveDone: (code: number) => void;
  const done = new Promise<number>((r) => {
    resolveDone = r;
  });

  let timer: unknown = null;
  let inFlight = false;
  let queued = false; // an event arrived mid-deploy — coalesce it into ONE follow-up run
  let stopped = false;
  let trigger = "";

  const run = (): void => {
    inFlight = true;
    // Snapshot the trigger NOW. It is a shared closure variable, so reading it at completion would
    // attribute a coalesced run to whichever save happened to land last.
    const t = trigger;
    void deps
      .deploy()
      .then((res) => {
        if (!res.ok) {
          // AC8: report loudly, leave the last good artifact live, KEEP WATCHING. A resident watcher
          // that dies on the first typo is worse than useless.
          logError(`✗ ${res.error}`);
        } else if (res.written) {
          deps.log(`↻ ${t} → ${artifact} (${res.bytes} B)`);
        } else {
          deps.log(`· unchanged (${t})`);
        }
      })
      .catch((e) => {
        // The chain must never reject: an injected sink that throws (WatchDeps exists precisely so
        // callers supply their own) would otherwise escape as an unhandled rejection and TERMINATE the
        // resident loop — measured: the process died before the next tick, exit 1, outside the 0/1/2
        // contract. Report and stay alive, same discipline as a failed build.
        try {
          logError(`✗ watch loop error: ${e}`);
        } catch {
          /* even the error sink is broken — there is nowhere left to report, but do not die */
        }
      })
      .finally(() => {
        inFlight = false;
        if (stopped) {
          // stop() was called mid-deploy and DEFERRED the resolve to here, so `main.ts` does not
          // process.exit(0) — reporting a clean shutdown — while the save that is still building
          // never reaches the vault.
          if (queued) {
            // …but a save that was COALESCED behind this deploy is now dropped. Draining it would run
            // a build after the user pressed ctrl-c; dropping it silently is the "worse than no loop"
            // failure — you save, you quit, and Obsidian shows stale output with nothing said. So say it.
            queued = false;
            logError(`⚠ shutdown: a pending rebuild (${trigger}) was dropped — re-run deploy`);
          }
          finish();
          return;
        }
        if (queued) {
          queued = false;
          run();
        }
      });
  };

  const fire = (): void => {
    timer = null;
    if (stopped) return;
    if (inFlight) {
      queued = true; // never two builds + atomicWrites racing on the same vault path
      return;
    }
    run();
  };

  const onEvent = (dir: string, filename: string | null): void => {
    if (stopped) return;
    if (filename === null) return; // the node API's filename is nullable — do not crash the loop
    if (!isBundleRelevant(filename)) return;
    // A rename-save reports an opaque temp name, so name the watched dir instead of printing noise.
    trigger = filename.endsWith(".ts") ? basename(filename) : `src/${basename(dir)}`;
    if (timer !== null) deps.clearTimer(timer);
    timer = deps.setTimer(fire, WATCH_DEBOUNCE_MS);
  };

  // Registration can FAIL — an exhausted inotify limit (ENOSPC), a permission denial, a dir removed
  // between watchDirs() and here. Left unguarded, the throw escapes an async caller as a rejected
  // promise, main.ts's `.then(process.exit)` never runs, and the exit code lands outside the 0/1/2
  // contract — with the watchers already opened leaked behind it.
  const watchers: WatchHandle[] = [];
  try {
    for (const dir of dirs) watchers.push(deps.watch(dir, (f) => onEvent(dir, f)));
  } catch (e) {
    for (const w of watchers) closeQuietly(w);
    throw new EdgeDeployError(`cannot watch ${dirs.join(", ")}: ${e}`);
  }

  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    resolveDone(0);
  };

  const stop = (): void => {
    if (stopped) {
      // A SECOND ctrl-c gives up on the in-flight deploy. `main.ts` replaces the default SIGINT
      // terminate behaviour with this handler, so if the first stop is waiting on a deploy that never
      // settles (a wedged build, a stalled iCloud write) the process would be unkillable except by
      // `kill -9`. Escalation is the user's escape hatch.
      finish();
      return;
    }
    stopped = true;
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
    for (const w of watchers) closeQuietly(w); // an unclosed FSWatcher keeps the Bun process alive
    // A deploy in flight resolves `done` from its own `.finally` — see run(). Resolving here would
    // report a clean exit while the last save is still being written.
    if (!inFlight) finish();
  };

  return { done, stop };
}

/** The node-style `watch(dir, opts, (ev, filename) => …)` signature this adapter narrows. */
type NodeWatch = (
  dir: string,
  opts: { recursive: boolean },
  listener: (ev: string, filename: string | Buffer | null) => void,
) => WatchHandle;

/**
 * Real `node:fs` adapter, with the watch function injectable so a test can prove the `rename` case.
 * The event type is DELIBERATELY discarded: macOS FSEvents reports `rename` for a plain content write,
 * so a handler gated on `eventType === "change"` silently never fires.
 */
export function makeWatchAdapter(
  watchFn: NodeWatch = watch as unknown as NodeWatch,
): (dir: string, cb: (filename: string | null) => void) => WatchHandle {
  return (dir, cb) =>
    // `String(filename)` rather than a `typeof === "string"` test: on any platform/encoding where the
    // API yields a Buffer, coercing to null would turn EVERY event into a dropped one — a watcher that
    // fires constantly and never rebuilds, the same silent class as the temp-name bug.
    watchFn(dir, { recursive: true }, (_ev, filename) =>
      cb(filename == null ? null : String(filename)),
    );
}

/** Injected sink so the command runner is testable without capturing stdout. */
export interface EdgeDeployDeps {
  log?: (line: string) => void;
  /** Called once with the loop's `stop()` when `--watch` goes resident — the callsite owns SIGINT (AC8). */
  onWatchStart?: (stop: () => void) => void;
  /**
   * Overrides the real `node:fs` watcher so the `--watch` WIRING is assertable. Without this seam the
   * only way to reach the resident branch in a test is to open real recursive watchers — the
   * platform-divergent surface CI forbids. A fake here proves the dirs, the format and the banner are
   * threaded correctly without touching inotify/FSEvents.
   */
  watch?: (dir: string, cb: (filename: string | null) => void) => WatchHandle;
}

/**
 * `std <edge> deploy --vault <dir> [--watch]` — validate, build in memory, write atomically, read back.
 * With `--watch`, the same deploy then stays resident and re-runs on every save under the edge's watchDirs.
 * Returns a process exit code: 0 ok, 1 fail-loud, 2 usage. The generic engine every edge's `run<Edge>Deploy`
 * delegates to — the only thing that changes between edges is the `spec`.
 */
export async function runEdgeDeploy(
  spec: EdgeSpec,
  argv: string[],
  deps: EdgeDeployDeps = {},
): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const [sub, ...rest] = argv;

  if (sub !== "deploy") {
    console.error(spec.usage);
    return 2;
  }

  // USAGE validation first, before any I/O — so `--vault <bad> --format umd` reports the usage error
  // (exit 2) rather than the vault error (exit 1). `hasFlag` before `flagValue` because a trailing
  // `--format` with no value yields `undefined`, which `?? "esm"` would silently accept as a default:
  // the user asked for something and got something else, at exit 0. Edges without a `formats` list
  // (dashkit) are esm-only and do not parse `--format` at all — no invented cjs optionality (D-3).
  let format: "esm" | "cjs" = "esm";
  if (spec.formats) {
    const requested = hasFlag(rest, "format") ? flagValue(rest, "format") : "esm";
    if (requested !== "esm" && requested !== "cjs") {
      console.error(`✗ --format must be esm or cjs (got '${requested ?? "<no value>"}')`);
      return 2;
    }
    if (!spec.formats.includes(requested)) {
      console.error(`✗ --format ${requested} is not supported by ${spec.name}`);
      return 2;
    }
    format = requested;
  }

  const vault = flagValue(rest, "vault");
  let target: string;
  try {
    target = resolveTarget(spec, vault);
  } catch (e) {
    // A missing --vault is a USAGE error; everything else is a real failure. A non-EdgeDeployError here
    // is a genuine fs fault (permission, not-a-directory) — report it in the house `✗ ` format and
    // return 1 rather than escaping as an unhandled rejection, which would dump a stack trace at the
    // user, skip `main.ts`'s `process.exit(code)`, and satisfy the 0/1/2 contract only by luck.
    if (e instanceof EdgeDeployError) {
      console.error(`✗ ${e.message}`);
      return vault === undefined || vault === "" ? 2 : 1;
    }
    console.error(`✗ cannot inspect the deploy target in ${vault}: ${e}`);
    return 1;
  }

  // Optional PREFLIGHT (cn's plugin envelope, 7.3 AC4). Runs after resolveTarget's guards and before the
  // build — so an `error` envelope aborts having written nothing, and (with --watch) the watcher never
  // registers. Exactly once per invocation, never per rebuild. Edges without a preflight (dashkit) skip it.
  if (spec.preflight) {
    try {
      for (const line of spec.preflight(vault as string)) log(line);
    } catch (e) {
      console.error(`✗ ${e instanceof EdgeDeployError ? e.message : e}`);
      return 1;
    }
  }

  // ALL of the fail-loud guards have now run. Only then does the watcher start (AC8) — failing fast
  // beats failing later inside a resident loop.
  const first = await deployOnce(spec, vault as string, format);
  if (!first.ok) {
    console.error(`✗ ${first.error}`);
    return 1;
  }
  log(`✓ ${spec.name} (${format}) → ${target}  ${first.bytes} bytes`);

  if (!hasFlag(rest, "watch")) return 0;

  const dirs = [...spec.watchDirs];
  let done: Promise<number>;
  let stop: () => void;
  try {
    ({ done, stop } = runWatch(dirs, {
      watch: deps.watch ?? makeWatchAdapter(),
      deploy: () => deployOnce(spec, vault as string, format),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      log,
      logError: (l) => console.error(l),
      artifact: spec.artifact,
    }));
  } catch (e) {
    // Registration failed (see runWatch). Report it in the house format and keep the 0/1/2 contract —
    // never let it escape as an unhandled rejection past main.ts's process.exit.
    console.error(`✗ ${e instanceof EdgeDeployError ? e.message : e}`);
    return 1;
  }
  deps.onWatchStart?.(stop);
  log(
    `watching ${dirs.map((d) => `src/${basename(d)}`).join(", ")} → ${target}  (ctrl-c to stop)`,
  );
  return await done;
}
