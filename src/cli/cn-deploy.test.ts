// cn-deploy tests (Story 7.1 AC10) — every fail-loud guard as its own case, plus a real end-to-end
// build into a temp dir shaped like a vault.
//
// The end-to-end case runs the ACTUAL Bun.build over src/cn/index.ts. That is deliberate: the artifact's
// shape (one output, banner on line 1, four exports, zero external imports) is the contract Story 7.1
// ships, and a mocked build would assert nothing about it. It stays fast because the slice is one file.
//
// A green run here is NOT evidence that CodeScript Toolkit can load the artifact — that assumption is
// tested live, in the vault (AC8). Fixtures test your assertions; contact tests your assumptions.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BANNER,
  BANNER_PREFIX,
  CnDeployError,
  type DeployResult,
  type WatchHandle,
  WATCH_DEBOUNCE_MS,
  artifactPath,
  buildBundle,
  deployOnce,
  entrypoint,
  isBundleRelevant,
  makeWatchAdapter,
  resolveTarget,
  runCnDeploy,
  runWatch,
  watchDirs,
} from "./cn-deploy";

let tmp: string;
/** A temp dir shaped like an Obsidian vault (has .obsidian/). */
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "std-cn-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Blank out `//` and block comments so a source scan sees code only, not prose about code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");
}

/** Collect the CLI's stdout instead of printing it. */
function sink() {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
}

describe("pure helpers", () => {
  test("artifactPath lands at <vault>/Scripts/cn.js", () => {
    expect(artifactPath("/some/vault")).toBe(join("/some/vault", "Scripts", "cn.js"));
  });

  test("entrypoint resolves src/cn/index.ts relative to this file, not an absolute literal", () => {
    const ep = entrypoint();
    expect(ep.endsWith(join("src", "cn", "index.ts"))).toBe(true);
    expect(readFileSync(ep, "utf-8")).toContain("export function statGrid");
  });

  test("the banner starts with the prefix the clobber guard keys on", () => {
    expect(BANNER.startsWith(BANNER_PREFIX)).toBe(true);
    expect(BANNER).toContain("do not edit");
  });
});

describe("resolveTarget — the fail-loud guards (AC6)", () => {
  test("missing --vault throws", () => {
    expect(() => resolveTarget(undefined)).toThrow(CnDeployError);
    expect(() => resolveTarget(undefined)).toThrow(/--vault <dir> is required/);
  });

  test("empty --vault throws", () => {
    expect(() => resolveTarget("")).toThrow(/--vault <dir> is required/);
  });

  test("a vault dir that does not exist throws", () => {
    expect(() => resolveTarget(join(tmp, "nope"))).toThrow(/vault does not exist/);
  });

  test("a dir without .obsidian/ throws (not an Obsidian vault)", () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    expect(() => resolveTarget(plain)).toThrow(/not an Obsidian vault/);
  });

  test("an existing target WITHOUT the banner throws — refuse to clobber hand-authored work", () => {
    const target = artifactPath(vault);
    mkdirSync(join(vault, "Scripts"), { recursive: true });
    writeFileSync(target, "// hand-written by a human\nexport const x = 1;\n");
    expect(() => resolveTarget(vault)).toThrow(/refusing to clobber a hand-authored file/);
  });

  test("an existing target WITH the banner is fine — that is our own prior artifact", () => {
    const target = artifactPath(vault);
    mkdirSync(join(vault, "Scripts"), { recursive: true });
    writeFileSync(target, `${BANNER}\nexport const x = 1;\n`);
    expect(resolveTarget(vault)).toBe(target);
  });

  test("a clean vault with no target yet resolves to the artifact path", () => {
    expect(resolveTarget(vault)).toBe(artifactPath(vault));
  });
});

describe("buildBundle — the artifact contract (AC3, AC4, AC6)", () => {
  test("produces one bundle whose FIRST line is the banner", async () => {
    const code = await buildBundle();
    expect(code.split("\n")[0]).toBe(BANNER);
  });

  test("carries all four runtime exports", async () => {
    const code = await buildBundle();
    for (const name of ["getDataview", "statCard", "statGrid", "ensureStyles"]) {
      expect(code).toContain(`function ${name}(`);
    }
  });

  // AC4 is asserted on the SOURCE, not the bundle output. Grepping the output for `import`/`require`
  // is a tautology: inlining those away is exactly what a bundler does, so the assertion holds no
  // matter what src/cn/ imports. Adding `import { parse } from "yaml"` to the slice would take the
  // artifact from ~1.6 KB to ~190 KB with yaml's internals inlined, and an output-grep would still
  // pass — as would a cross-slice `import ... from "../core/cite"` (an AD-8/D1 violation).
  test("src/cn/ imports NOTHING — asserted on the source, so a bundler cannot hide it (AC4)", () => {
    const dir = join(import.meta.dir, "..", "cn");
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(0); // a zero-file scan would pass vacuously

    for (const f of sources) {
      // Comments are masked first — the file's own doc-comment shows the vault's
      // `await require("/Scripts/cn.js")` call, which is documentation, not a dependency.
      // (Same discipline as scripts/check-no-consumer-ids.ts: mask comments, keep strings.)
      const src = stripComments(readFileSync(join(dir, f), "utf-8"));
      expect(src).not.toMatch(/^\s*import\s[\s\S]*?\sfrom\s/m); // value or type import
      expect(src).not.toMatch(/^\s*import\s+["']/m); // bare side-effect import
      expect(src).not.toMatch(/\brequire\s*\(/);
      expect(src).not.toMatch(/\bimport\s*\(/); // dynamic import
    }
  });

  // The backstop for anything the source scan's regexes miss: an external dep cannot be inlined
  // without the artifact growing. The slice is one small file; the ceiling is ~5x its current size.
  test("the artifact stays small — nothing external got inlined (AC4)", async () => {
    expect((await buildBundle()).length).toBeLessThan(8_000);
  });

  test("the built artifact names no host plugin module", async () => {
    const code = await buildBundle();
    for (const host of ["obsidian", "dataview", "js-engine"]) {
      expect(code.toLowerCase()).not.toContain(`"${host}"`);
      expect(code.toLowerCase()).not.toContain(`'${host}'`);
    }
  });

  test("is deterministic — two builds of unchanged source are byte-identical", async () => {
    expect(await buildBundle()).toBe(await buildBundle());
  });

  test("a broken source surfaces the COMPILER's diagnostic, not `AggregateError: Bundle failed`", async () => {
    // Bun.build throws rather than returning success:false, and the thrown message alone is useless.
    // Observed live in the 7.2 contact check: a syntax error in src/cn reached the watch log as
    // `✗ … AggregateError: Bundle failed` — no file, no line. AC4 says report LOUDLY, not merely survive.
    const bad = join(tmp, "bad.ts");
    writeFileSync(bad, "export const x = ;\n");
    let msg = "";
    try {
      await buildBundle("esm", bad);
    } catch (e) {
      msg = e instanceof CnDeployError ? e.message : `WRONG TYPE: ${e}`;
    }
    expect(msg).toContain("bundle failed");
    expect(msg).toContain("bad.ts"); // the failing file is named
    expect(msg).not.toBe("bundle failed:\nBundle failed"); // …and it is not the empty wrapper
  });

  test("the cjs fallback also builds and keeps the banner first (AC8 pre-authorized path)", async () => {
    const code = await buildBundle("cjs");
    expect(code.split("\n")[0]).toBe(BANNER);
    expect(code).toContain("statGrid");
  });
});

describe("runCnDeploy — end to end", () => {
  test("deploys into a temp vault: exit 0, artifact on disk, banner first, four exports", async () => {
    const out = sink();
    const code = await runCnDeploy(["deploy", "--vault", vault], { log: out.log });

    expect(code).toBe(0);
    const written = readFileSync(artifactPath(vault), "utf-8");
    expect(written.split("\n")[0]).toBe(BANNER);
    for (const name of ["getDataview", "statCard", "statGrid", "ensureStyles"]) {
      expect(written).toContain(name);
    }
    expect(out.lines.join("\n")).toContain("Scripts/cn.js");
  });

  test("creates Scripts/ when the vault does not have one yet", async () => {
    expect(await runCnDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    expect(readFileSync(artifactPath(vault), "utf-8").length).toBeGreaterThan(0);
  });

  test("running twice with no source change is byte-identical (AC6 idempotence)", async () => {
    await runCnDeploy(["deploy", "--vault", vault], { log: () => {} });
    const first = readFileSync(artifactPath(vault), "utf-8");
    await runCnDeploy(["deploy", "--vault", vault], { log: () => {} });
    const second = readFileSync(artifactPath(vault), "utf-8");
    expect(second).toBe(first);
  });

  test("supports --vault=<dir> (the equals form core/args handles)", async () => {
    expect(await runCnDeploy(["deploy", `--vault=${vault}`], { log: () => {} })).toBe(0);
    expect(readFileSync(artifactPath(vault), "utf-8").split("\n")[0]).toBe(BANNER);
  });

  test("--format cjs deploys the fallback artifact", async () => {
    const out = sink();
    expect(await runCnDeploy(["deploy", "--vault", vault, "--format", "cjs"], { log: out.log })).toBe(0);
    expect(out.lines.join("\n")).toContain("(cjs)");
    expect(readFileSync(artifactPath(vault), "utf-8").split("\n")[0]).toBe(BANNER);
  });

  test("exit 2 on a missing --vault, and nothing is written", async () => {
    expect(await runCnDeploy(["deploy"], { log: () => {} })).toBe(2);
    expect(existsSync(artifactPath(vault))).toBe(false); // the title's second clause, actually asserted
  });

  test("exit 2 on a valueless --format — the user's intent is not silently defaulted to esm", async () => {
    expect(await runCnDeploy(["deploy", "--vault", vault, "--format"], { log: () => {} })).toBe(2);
    expect(existsSync(artifactPath(vault))).toBe(false);
  });

  test("a usage error beats an I/O error — --format is validated before the vault is touched", async () => {
    // Both are wrong; the usage code (2) must win, so the user is told what they can actually fix.
    expect(await runCnDeploy(["deploy", "--vault", join(tmp, "nope"), "--format", "umd"], { log: () => {} })).toBe(2);
  });

  test("TOCTOU: a hand-authored file appearing DURING the build is not clobbered", async () => {
    // resolveTarget runs before the build; the build is the one await in the function. Without a
    // re-check after it, the write is unconditional and destroys work saved in that window.
    const target = artifactPath(vault);
    const original = "// hand-written mid-build\nexport const x = 1;\n";

    const racer = runCnDeploy(["deploy", "--vault", vault], { log: () => {} });
    mkdirSync(join(vault, "Scripts"), { recursive: true });
    writeFileSync(target, original);

    expect(await racer).toBe(1);
    expect(readFileSync(target, "utf-8")).toBe(original); // survived
  });

  test("a real fs fault returns 1 in the house format — it does not escape as an unhandled rejection", async () => {
    // A directory where the artifact should be: readIfExists throws EISDIR, a plain Error, not a
    // CnDeployError. Rethrowing it would skip main.ts's process.exit and dump a stack trace.
    mkdirSync(artifactPath(vault), { recursive: true });
    expect(await runCnDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(1);
  });

  test("exit 2 on an unknown/absent subcommand", async () => {
    expect(await runCnDeploy([], { log: () => {} })).toBe(2);
    expect(await runCnDeploy(["watch"], { log: () => {} })).toBe(2);
  });

  test("exit 2 on an invalid --format", async () => {
    expect(await runCnDeploy(["deploy", "--vault", vault, "--format", "umd"], { log: () => {} })).toBe(2);
  });

  test("exit 1 when the vault does not exist — a real failure, not a usage error", async () => {
    expect(await runCnDeploy(["deploy", "--vault", join(tmp, "nope")], { log: () => {} })).toBe(1);
  });

  test("exit 1 and NO write when the target is hand-authored", async () => {
    const target = artifactPath(vault);
    mkdirSync(join(vault, "Scripts"), { recursive: true });
    const original = "// hand-written\nexport const x = 1;\n";
    writeFileSync(target, original);

    expect(await runCnDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(1);
    expect(readFileSync(target, "utf-8")).toBe(original); // untouched
  });
});

// ---------------------------------------------------------------------------------------------
// Story 7.2 — the watch loop (AC6). Fake watcher + fake clock, so ZERO real timers and ZERO real
// `fs.watch` run here. Recursive watch is a platform-divergent surface (macOS FSEvents vs Linux
// inotify) and this suite runs on Linux in CI; a real-watcher assertion is exactly the class of test
// that passed locally for four days on a red main (memory: ci-run-is-the-gate-not-local). The real
// loop's proof is the contact check (AC7), not this file.
// ---------------------------------------------------------------------------------------------

/** A controllable timer table. `tick()` fires everything currently scheduled. */
function fakeClock() {
  let nextId = 1;
  let lastMs = -1;
  const timers = new Map<number, () => void>();
  return {
    setTimer(fn: () => void, ms: number): unknown {
      lastMs = ms;
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearTimer(t: unknown): void {
      timers.delete(t as number);
    },
    tick(): void {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    },
    pending: () => timers.size,
    lastMs: () => lastMs,
  };
}

/** A watcher table that records the dirs it was asked to watch and which ones were closed. */
function fakeWatchers() {
  const cbs: ((f: string | null) => void)[] = [];
  const dirs: string[] = [];
  const closed: string[] = [];
  return {
    dirs,
    closed,
    count: () => cbs.length,
    watch(dir: string, cb: (f: string | null) => void): WatchHandle {
      dirs.push(dir);
      cbs.push(cb);
      return { close: () => closed.push(dir) };
    },
    /** Fire one event on one watcher (index 0 by default) — not a broadcast. */
    emit(filename: string | null, i = 0): void {
      cbs[i]!(filename);
    },
  };
}

/** Let every already-resolved promise callback run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const OK: DeployResult = { ok: true, bytes: 100, written: true };

describe("runWatch — debounce, serialization, survival, shutdown (AC3, AC4, AC5, AC6)", () => {
  test("three events inside the debounce window collapse into exactly ONE deploy", async () => {
    const clock = fakeClock();
    const w = fakeWatchers();
    let calls = 0;
    const { stop } = runWatch(["a", "b"], {
      watch: w.watch,
      deploy: async () => (calls++, OK),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: () => {},
    });

    w.emit("index.ts");
    w.emit("index.ts");
    w.emit("index.ts");
    expect(clock.pending()).toBe(1); // each event replaced the previous timer — trailing debounce
    expect(clock.lastMs()).toBe(WATCH_DEBOUNCE_MS);
    expect(WATCH_DEBOUNCE_MS).toBe(150); // AC3's stated default. `lastMs === CONST` is the constant
    // compared against itself: measured, 150 → 1 and 150 → 400 both stayed green without this line.
    expect(calls).toBe(0); // nothing before the window closes

    clock.tick();
    await flush();
    expect(calls).toBe(1);
    stop();
  });

  test("events straddling the window produce two deploys", async () => {
    const clock = fakeClock();
    const w = fakeWatchers();
    let calls = 0;
    const { stop } = runWatch(["a"], {
      watch: w.watch,
      deploy: async () => (calls++, OK),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: () => {},
    });

    w.emit("index.ts");
    clock.tick();
    await flush();
    w.emit("index.ts");
    clock.tick();
    await flush();
    expect(calls).toBe(2);
    stop();
  });

  test("events arriving mid-deploy coalesce into exactly ONE follow-up, never concurrent", async () => {
    const clock = fakeClock();
    const w = fakeWatchers();
    let calls = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    let release!: () => void;
    const { stop } = runWatch(["a"], {
      watch: w.watch,
      deploy: () => {
        calls++;
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        const finish = (): DeployResult => (concurrent--, OK);
        // The FIRST deploy hangs until released — the window in which the racing events arrive.
        return calls === 1
          ? new Promise<DeployResult>((r) => {
              release = () => r(finish());
            })
          : Promise.resolve(finish());
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: () => {},
    });

    w.emit("index.ts");
    clock.tick();
    await flush();
    expect(calls).toBe(1); // in flight, unresolved

    w.emit("index.ts");
    clock.tick();
    w.emit("other.ts");
    clock.tick();
    await flush();
    expect(calls).toBe(1); // both queued behind the in-flight run, not started

    release();
    await flush();
    expect(calls).toBe(2); // ONE follow-up, not two
    expect(maxConcurrent).toBe(1); // two Bun.build + atomicWrite pairs never raced on the vault
    stop();
  });

  test("a null filename is ignored — the loop does not crash and does not deploy", async () => {
    const clock = fakeClock();
    const w = fakeWatchers();
    let calls = 0;
    const { stop } = runWatch(["a"], {
      watch: w.watch,
      deploy: async () => (calls++, OK),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: () => {},
    });

    expect(() => w.emit(null)).not.toThrow();
    expect(clock.pending()).toBe(0);
    clock.tick();
    await flush();
    expect(calls).toBe(0);
    stop();
  });

  test("test files and non-.ts files are filtered — a test edit cannot change the bundle", async () => {
    const clock = fakeClock();
    const w = fakeWatchers();
    let calls = 0;
    const { stop } = runWatch(["a"], {
      watch: w.watch,
      deploy: async () => (calls++, OK),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: () => {},
    });

    for (const f of [
      "index.test.ts",
      "notes.md",
      "sub/cn.test.ts",
      ".DS_Store",
      "index.test.ts.tmp.46812.0e28eeb8a7b3", // a TEST file saved by rename — still a test file
      "",
    ]) {
      w.emit(f);
    }
    expect(clock.pending()).toBe(0);
    clock.tick();
    await flush();
    expect(calls).toBe(0);

    w.emit("sub/deep.ts"); // …but a nested .ts file DOES trigger (the filter is not a blanket no)
    clock.tick();
    await flush();
    expect(calls).toBe(1);
    stop();
  });

  test("a rename-save's TEMP filename still triggers — the contact-check regression", async () => {
    // Measured, not assumed (Story 7.2 AC7): editors that write-temp-then-rename report the temp name.
    // Claude Code's own edit of src/cn/index.ts reported `index.ts.tmp.46812.0e28eeb8a7b3`; `perl -i`
    // reported the extensionless `XX7Eoqmy`. A `.endsWith(".ts")` filter drops BOTH, and the loop then
    // prints its banner and silently never rebuilds. This test is that failure, frozen.
    const clock = fakeClock();
    const w = fakeWatchers();
    let calls = 0;
    const { stop } = runWatch(["a"], {
      watch: w.watch,
      deploy: async () => (calls++, OK),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: () => {},
    });

    for (const temp of ["index.ts.tmp.46812.0e28eeb8a7b3", "XX7Eoqmy", "index.ts~"]) {
      w.emit(temp);
      clock.tick();
      await flush();
    }
    expect(calls).toBe(3);
    stop();
  });

  test("isBundleRelevant: the ignore-list, case by case", () => {
    for (const yes of [
      "index.ts",
      "sub/deep.ts",
      "index.ts.tmp.46812.0e28eeb8a7b3",
      "XX7Eoqmy",
      "index.ts~",
      "4913", // vim's numeric write probe — cheap to rebuild on, expensive to miss a save
      // Real save patterns measured across editors: all must reach the loop.
      "___jb_tmp___", // JetBrains safe-write
      "index.ts.vsctmp", // VS Code
      ".goutputstream-a1b2c3", // gedit / GIO
      "#index.ts#", // emacs autosave
      ".#index.ts", // emacs lock
      ".tmp8sK2ax", // a dotfile temp: strips to "" — an information-free name must TRIGGER, not drop
      ".tmp",
      // Bun ships default loaders for these, so they ARE bundle inputs. FR20's CSS token system is
      // cn's next step: ignoring them by extension would reinstate the silent under-trigger.
      "tokens.json",
      "tokens.css",
      "template.txt",
      "conf.toml",
      "data.yaml",
    ]) {
      expect(isBundleRelevant(yes)).toBe(true);
    }
    for (const no of [
      "",
      "index.test.ts",
      "index.spec.ts",
      "sub/cn.test.ts",
      "index.test.ts.tmp.9.abc",
      "index.test.ts~",
      "notes.md~",
      "README.md",
      "package.json", // by NAME, so other .json files stay watchable
      "tsconfig.json",
      ".DS_Store", // Finder writes this into any browsed directory
      "tsconfig.tsbuildinfo",
      "index.ts.orig",
      "index.ts.rej",
      ".index.ts.swp",
    ]) {
      expect(isBundleRelevant(no)).toBe(false);
    }
  });

  test("a rename-save's log line names the watched dir, not the opaque temp file", async () => {
    const clock = fakeClock();
    const w = fakeWatchers();
    const lines: string[] = [];
    const { stop } = runWatch(["/repo/src/cn"], {
      watch: w.watch,
      deploy: async () => OK,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: (l) => lines.push(l),
    });

    w.emit("index.ts.tmp.46812.0e28eeb8a7b3");
    clock.tick();
    await flush();
    expect(lines[0]).toContain("↻ src/cn");
    expect(lines[0]).not.toContain("0e28eeb8a7b3");
    stop();
  });

  test("a failed deploy is reported to stderr and the loop SURVIVES — the next save still deploys", async () => {
    const clock = fakeClock();
    const w = fakeWatchers();
    const errors: string[] = [];
    let calls = 0;
    const { done, stop } = runWatch(["a"], {
      watch: w.watch,
      deploy: async () => {
        calls++;
        return calls === 1 ? { ok: false, error: "bundle failed: SyntaxError" } : OK;
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: () => {},
      logError: (l) => errors.push(l),
    });

    w.emit("index.ts");
    clock.tick();
    await flush();
    expect(errors.join("\n")).toContain("SyntaxError");

    // Still live: the watcher was not closed and `done` has not resolved.
    expect(w.closed).toEqual([]);
    w.emit("index.ts");
    clock.tick();
    await flush();
    expect(calls).toBe(2);

    stop();
    expect(await done).toBe(0);
  });

  test("an unchanged rebuild logs `· unchanged` and a written one logs `↻` (AC3/AC5 log lines)", async () => {
    const clock = fakeClock();
    const w = fakeWatchers();
    const lines: string[] = [];
    let calls = 0;
    const { stop } = runWatch(["a"], {
      watch: w.watch,
      deploy: async () => {
        calls++;
        return calls === 1
          ? { ok: true, bytes: 1621, written: false }
          : { ok: true, bytes: 1700, written: true };
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: (l) => lines.push(l),
    });

    w.emit("sub/index.ts");
    clock.tick();
    await flush();
    expect(lines[0]).toContain("· unchanged");
    expect(lines[0]).toContain("index.ts"); // named by basename, not the watcher-relative path

    w.emit("index.ts");
    clock.tick();
    await flush();
    expect(lines[1]).toContain("↻ index.ts");
    expect(lines[1]).toContain("1700");
    stop();
  });

  test("`done` stays PENDING until stop() — the bite-#6 regression", async () => {
    const clock = fakeClock();
    const w = fakeWatchers();
    const { done, stop } = runWatch(["a", "b"], {
      watch: w.watch,
      deploy: async () => OK,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: () => {},
    });

    // A runWatch that resolves as soon as the watchers are registered passes every other case in this
    // file while being completely broken: main.ts's process.exit(0) would kill the loop before the
    // first save. This is the only case that catches it.
    const sentinel = Symbol("still-running");
    expect(await Promise.race([done, Promise.resolve(sentinel)])).toBe(sentinel);

    w.emit("index.ts"); // a debounce timer is now pending
    expect(clock.pending()).toBe(1);

    stop();
    expect(await done).toBe(0);
    expect(clock.pending()).toBe(0); // the pending timer was cleared, not left to fire after shutdown
    expect(w.closed).toEqual(["a", "b"]); // EVERY watcher closed — an open FSWatcher keeps Bun alive
  });

  test("stop() is idempotent and a post-stop event deploys nothing", async () => {
    const clock = fakeClock();
    const w = fakeWatchers();
    let calls = 0;
    const { done, stop } = runWatch(["a"], {
      watch: w.watch,
      deploy: async () => (calls++, OK),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: () => {},
    });

    stop();
    stop();
    expect(w.closed).toEqual(["a"]); // closed once, not twice
    w.emit("index.ts");
    // Not just "no deploy" — no TIMER either. An unreferenced setTimeout scheduled after shutdown
    // keeps the Bun process alive past the exit the user asked for.
    expect(clock.pending()).toBe(0);
    clock.tick();
    await flush();
    expect(calls).toBe(0);
    expect(await done).toBe(0);
  });

  test("a second stop() gives up on a wedged deploy — ctrl-c twice always exits", async () => {
    // main.ts REPLACES the default SIGINT terminate behaviour with this handler. If the first stop
    // waits on a deploy that never settles (a wedged build, a stalled iCloud write), every later
    // ctrl-c hitting `if (stopped) return` leaves the user with only `kill -9`.
    const clock = fakeClock();
    const w = fakeWatchers();
    const { done, stop } = runWatch(["a"], {
      watch: w.watch,
      deploy: () => new Promise<DeployResult>(() => {}), // never settles
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: () => {},
    });

    w.emit("index.ts");
    clock.tick();
    await flush();

    stop(); // first ctrl-c — waits for the in-flight deploy
    const sentinel = Symbol("wedged");
    expect(await Promise.race([done, Promise.resolve(sentinel)])).toBe(sentinel);

    stop(); // second ctrl-c — escalate
    expect(await done).toBe(0);
  });

  test("a save coalesced behind a deploy is not silently lost at shutdown — it is REPORTED", async () => {
    // Save A builds; you save B (coalesced); you ctrl-c. B never reaches the vault. Dropping it is
    // defensible — draining would build after the user quit — but dropping it SILENTLY at exit 0 is
    // the "you save, you quit, Obsidian shows stale output, nothing told you" failure.
    const clock = fakeClock();
    const w = fakeWatchers();
    const errors: string[] = [];
    let calls = 0;
    let release!: () => void;
    const { done, stop } = runWatch(["a"], {
      watch: w.watch,
      deploy: () => {
        calls++;
        return new Promise<DeployResult>((r) => {
          release = () => r(OK);
        });
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: () => {},
      logError: (l) => errors.push(l),
    });

    w.emit("alpha.ts");
    clock.tick();
    await flush(); // deploy #1 in flight
    w.emit("beta.ts");
    clock.tick();
    await flush(); // beta coalesced into `queued`
    expect(calls).toBe(1);

    stop();
    release();
    expect(await done).toBe(0);
    expect(calls).toBe(1); // beta was NOT built — that is the (defensible) behaviour…
    expect(errors.join("\n")).toContain("dropped"); // …but the user is told
    expect(errors.join("\n")).toContain("beta.ts");
  });

  test("a throwing log sink does not kill the resident loop", async () => {
    // `void deploy().then(...)` with no .catch: an injected sink that throws escapes as an unhandled
    // rejection and terminates the process. WatchDeps exists so callers inject their own sinks, and
    // Story 8.x's dashkit --watch is the named second caller.
    const clock = fakeClock();
    const w = fakeWatchers();
    const errors: string[] = [];
    let calls = 0;
    const { done, stop } = runWatch(["a"], {
      watch: w.watch,
      deploy: async () => (calls++, OK),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: () => {
        throw new Error("sink exploded");
      },
      logError: (l) => errors.push(l),
    });

    w.emit("index.ts");
    clock.tick();
    await flush();
    expect(errors.join("\n")).toContain("watch loop error");

    w.emit("index.ts"); // still alive
    clock.tick();
    await flush();
    expect(calls).toBe(2);
    stop();
    expect(await done).toBe(0);
  });

  test("one watcher whose close() throws does not strand its siblings", async () => {
    // An already-closed / fd-gone FSWatcher throwing out of the shutdown loop would leave the rest
    // open, and an open watcher keeps the Bun process alive after the loop was told to stop.
    const clock = fakeClock();
    const closed: string[] = [];
    const { done, stop } = runWatch(["a", "b"], {
      watch: (dir) => ({
        close: () => {
          if (dir === "a") throw new Error("EBADF");
          closed.push(dir);
        },
      }),
      deploy: async () => OK,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: () => {},
    });

    expect(() => stop()).not.toThrow();
    expect(closed).toEqual(["b"]); // the sibling still closed
    expect(await done).toBe(0);
  });
});

describe("runWatch — registration failure and shutdown-mid-deploy (review findings)", () => {
  test("a watcher that fails to register closes its siblings and throws a CnDeployError", () => {
    // ENOSPC (inotify limit), a permission denial, or a dir removed between watchDirs() and here.
    // Unguarded, the throw escapes an async caller as a rejected promise: main.ts's .then(process.exit)
    // never runs, the exit code lands outside 0/1/2, and the already-opened watcher leaks.
    const closed: string[] = [];
    const clock = fakeClock();
    expect(() =>
      runWatch(["a", "b"], {
        watch: (dir) => {
          if (dir === "b") throw new Error("ENOSPC: inotify watch limit reached");
          return { close: () => closed.push(dir) };
        },
        deploy: async () => OK,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        log: () => {},
      }),
    ).toThrow(CnDeployError);
    expect(closed).toEqual(["a"]); // the first watcher was NOT leaked
  });

  test("stop() during an in-flight deploy waits for it — `done` does not resolve early", async () => {
    const clock = fakeClock();
    const w = fakeWatchers();
    let release!: () => void;
    let landed = false;
    const { done, stop } = runWatch(["a"], {
      watch: w.watch,
      deploy: () =>
        new Promise<DeployResult>((r) => {
          release = () => {
            landed = true;
            r(OK);
          };
        }),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: () => {},
    });

    w.emit("index.ts");
    clock.tick();
    await flush();

    stop(); // ctrl-c while the build is running
    expect(w.closed).toEqual(["a"]); // watchers close immediately — no new work is accepted
    const sentinel = Symbol("still-writing");
    // Resolving here would make main.ts process.exit(0) — reporting a clean shutdown — while the save
    // that is still building never reaches the vault.
    expect(await Promise.race([done, Promise.resolve(sentinel)])).toBe(sentinel);
    expect(landed).toBe(false);

    release();
    expect(await done).toBe(0);
    expect(landed).toBe(true);
  });

  test("logError defaults to log — a caller that omits it still sees build failures", async () => {
    // Story 8.x's `dashkit deploy --watch` is the planned second caller. If it omits logError and this
    // fell back to a no-op, every build diagnostic would vanish with nothing going red.
    const clock = fakeClock();
    const w = fakeWatchers();
    const lines: string[] = [];
    const { stop } = runWatch(["a"], {
      watch: w.watch,
      deploy: async () => ({ ok: false, error: "bundle failed: Unexpected ;" }),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: (l) => lines.push(l),
    });

    w.emit("index.ts");
    clock.tick();
    await flush();
    expect(lines.join("\n")).toContain("Unexpected ;");
    stop();
  });

  test("a coalesced run logs the trigger that STARTED it, not whatever landed last", async () => {
    const clock = fakeClock();
    const w = fakeWatchers();
    const lines: string[] = [];
    let release!: () => void;
    let calls = 0;
    const { stop } = runWatch(["a"], {
      watch: w.watch,
      deploy: () => {
        calls++;
        return calls === 1
          ? new Promise<DeployResult>((r) => {
              release = () => r(OK);
            })
          : Promise.resolve(OK);
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: (l) => lines.push(l),
    });

    w.emit("alpha.ts");
    clock.tick();
    await flush(); // deploy #1 in flight, triggered by alpha.ts
    w.emit("beta.ts");
    clock.tick();
    await flush();
    release();
    await flush();

    expect(lines[0]).toContain("alpha.ts"); // NOT beta.ts — `trigger` is shared mutable state
    expect(lines[1]).toContain("beta.ts");
    stop();
  });
});

describe("the node:fs adapter — the filter keys on the FILENAME, never the event type (AC2)", () => {
  test("a `rename` event reaches the callback — filtering on 'change' would drop every macOS save", () => {
    // Verified empirically on this machine: two successive content writes to a watched file produced
    // ["rename:sub/a.ts","rename:sub/a.ts"]. A handler gated on eventType === "change" is a watcher
    // that never fires. This test fails the moment anyone adds that gate.
    let listener!: (ev: string, f: string | Buffer | null) => void;
    const seen: (string | null)[] = [];
    const adapter = makeWatchAdapter((_dir, opts, l) => {
      expect(opts.recursive).toBe(true); // nested files must reach the loop
      listener = l;
      return { close: () => {} };
    });

    adapter("/some/dir", (f) => seen.push(f));
    listener("rename", "sub/a.ts");
    listener("rename", "index.ts");
    listener("change", "b.ts");
    expect(seen).toEqual(["sub/a.ts", "index.ts", "b.ts"]);
  });

  test("null stays null, but a Buffer filename is DECODED — not dropped", () => {
    // Coercing a Buffer to null would turn every event into a dropped one on any platform/encoding
    // where fs.watch yields Buffers: a watcher that fires constantly and never rebuilds — the same
    // silent class as the temp-name bug.
    let listener!: (ev: string, f: string | Buffer | null) => void;
    const seen: (string | null)[] = [];
    const adapter = makeWatchAdapter((_d, _o, l) => ((listener = l), { close: () => {} }));

    adapter("/some/dir", (f) => seen.push(f));
    listener("rename", null);
    listener("rename", Buffer.from("index.ts"));
    expect(seen).toEqual([null, "index.ts"]);
  });
});

describe("watchDirs — the PERMITTED bundle set, resolved relatively (AC2, D4/NFR3)", () => {
  test("watches src/cn AND src/core, both relative to this file", () => {
    const dirs = watchDirs();
    expect(dirs.length).toBe(2);
    expect(dirs.some((d) => d.endsWith(join("src", "cn")))).toBe(true);
    // src/core is watched because it is in the bundle's PERMITTED set, not its current import graph:
    // the day cn imports a core helper the loop must already cover it. Until then a core edit rebuilds
    // to a byte-identical artifact and correctly logs `· unchanged`.
    expect(dirs.some((d) => d.endsWith(join("src", "core")))).toBe(true);
    for (const d of dirs) expect(existsSync(d)).toBe(true);
  });

  test("the vault is NEVER watched — every watched dir is inside THIS repo's src/", () => {
    // `!d.includes("Scripts")` would be satisfied by watching a vault ROOT, which is exactly the
    // self-triggering case (fsx.atomicWrite renames inside the target dir). Anchor on containment.
    const src = join(import.meta.dir, "..");
    for (const d of watchDirs()) {
      expect(d.startsWith(src + "/")).toBe(true);
      expect(d).not.toContain("Scripts");
    }
  });
});

describe("--watch WIRING — the resident branch, with a fake watcher (review finding)", () => {
  /** Drive `runCnDeploy` into the resident branch and shut it down immediately. */
  async function runResident(argv: string[]) {
    const dirs: string[] = [];
    const lines: string[] = [];
    const code = await runCnDeploy(argv, {
      log: (l) => lines.push(l),
      watch: (dir) => (dirs.push(dir), { close: () => {} }),
      onWatchStart: (stop) => stop(), // resolve `done` synchronously — no hang, no real timers
    });
    return { code, dirs, lines };
  }

  test("passes BOTH permitted dirs to the watcher and names them in the banner", async () => {
    // Nothing else reaches these lines: all the other --watch tests are negative (bad vault, missing
    // vault, clobber) and return before runWatch is constructed. `const dirs = []` shipped green.
    const { code, dirs, lines } = await runResident(["deploy", "--vault", vault, "--watch"]);
    expect(code).toBe(0);
    expect(dirs.length).toBe(2);
    expect(dirs.some((d) => d.endsWith(join("src", "cn")))).toBe(true);
    expect(dirs.some((d) => d.endsWith(join("src", "core")))).toBe(true);
    const banner = lines.join("\n");
    expect(banner).toContain("watching src/cn, src/core");
    expect(banner).toContain("ctrl-c to stop");
  });

  test("--format is threaded into the RESIDENT deploy, not just the first one", async () => {
    // Asserting the FIRST deploy's artifact does not catch this: `deployOnce(vault, "esm")` inside the
    // watch wiring means `--format cjs --watch` deploys cjs once and then rewrites the vault as esm on
    // the first save. So this test drives a real rebuild through the fake watcher and checks the bytes
    // the LOOP produced. (Real timers here, deliberately — the debounce is a timer, not a watcher; no
    // fs.watch is opened, so the platform-divergent surface AC6 forbids is still untouched.)
    let cb: ((f: string | null) => void) | undefined;
    let stop: (() => void) | undefined;
    const target = artifactPath(vault);
    const p = runCnDeploy(["deploy", "--vault", vault, "--format", "cjs", "--watch"], {
      log: () => {},
      watch: (_dir, c) => ((cb = c), { close: () => {} }),
      onWatchStart: (s) => (stop = s),
    });
    while (cb === undefined || stop === undefined) await new Promise((r) => setTimeout(r, 10));

    // Make the loop's write observable: park different bytes (banner-bearing, so the guard allows it).
    writeFileSync(target, `${BANNER}\n// stale\n`);
    cb("index.ts");
    await new Promise((r) => setTimeout(r, WATCH_DEBOUNCE_MS + 350));
    stop();
    expect(await p).toBe(0);

    const written = readFileSync(target, "utf-8");
    expect(written).not.toContain("// stale"); // the LOOP rebuilt
    expect(written.split("\n")[0]).toBe(BANNER);
    expect(written).not.toContain("\nexport {"); // …and it rebuilt as CJS, not esm
  });

  test("a watcher that cannot register returns 1, not an unhandled rejection", async () => {
    const code = await runCnDeploy(["deploy", "--vault", vault, "--watch"], {
      log: () => {},
      watch: () => {
        throw new Error("ENOSPC: inotify watch limit reached");
      },
      onWatchStart: (stop) => stop(),
    });
    expect(code).toBe(1);
  });
});

describe("--watch on the one-shot path (AC1, AC5, AC9)", () => {
  test("without --watch nothing goes resident — 7.1's path is unchanged", async () => {
    let started = false;
    const code = await runCnDeploy(["deploy", "--vault", vault], {
      log: () => {},
      onWatchStart: () => {
        started = true;
      },
    });
    expect(code).toBe(0);
    expect(started).toBe(false);
    expect(readFileSync(artifactPath(vault), "utf-8").split("\n")[0]).toBe(BANNER);
  });

  test("--watch without --vault returns the SAME code the one-shot path returns (2), no watcher", async () => {
    let started = false;
    expect(
      await runCnDeploy(["deploy", "--watch"], { log: () => {}, onWatchStart: () => (started = true) }),
    ).toBe(2);
    expect(started).toBe(false);
  });

  test("--watch on a vault that does not exist fails loud BEFORE any watcher starts (AC1)", async () => {
    let started = false;
    expect(
      await runCnDeploy(["deploy", "--vault", join(tmp, "nope"), "--watch"], {
        log: () => {},
        onWatchStart: () => (started = true),
      }),
    ).toBe(1);
    expect(started).toBe(false);
  });

  test("--watch over a hand-authored target refuses and starts no watcher (AC1)", async () => {
    const target = artifactPath(vault);
    mkdirSync(join(vault, "Scripts"), { recursive: true });
    writeFileSync(target, "// hand-written\n");
    let started = false;
    expect(
      await runCnDeploy(["deploy", "--vault", vault, "--watch"], {
        log: () => {},
        onWatchStart: () => (started = true),
      }),
    ).toBe(1);
    expect(started).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe("// hand-written\n");
  });
});

describe("skip-if-identical, on the real bytes (AC3)", () => {
  test("a second deploy over unchanged source does NOT touch the file — mtime unmoved", async () => {
    const target = artifactPath(vault);
    expect(await runCnDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    const first = statSync(target).mtimeMs;

    await new Promise((r) => setTimeout(r, 20)); // any rewrite in this window WOULD move mtime
    expect(await runCnDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    expect(statSync(target).mtimeMs).toBe(first);

    // …and the assertion is not vacuous: when the bytes DO differ, the write happens and mtime moves.
    // (Banner-bearing, so the clobber guard permits the overwrite — this is our own prior artifact.)
    writeFileSync(target, `${BANNER}\n// stale\n`);
    const stale = statSync(target).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    expect(await runCnDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    expect(statSync(target).mtimeMs).not.toBe(stale);
    expect(readFileSync(target, "utf-8")).not.toContain("// stale");
  });
});

describe("deployOnce — AC4 on the REAL bytes (review finding)", () => {
  test("a broken build leaves the last good artifact byte-for-byte intact, then recovers", async () => {
    // Every other path builds the real (always valid) src/cn/index.ts, so the build-failure half of
    // AC4 rested entirely on the contact check. The `entry` seam makes it a fixture.
    const target = artifactPath(vault);
    expect((await deployOnce(vault, "esm")).ok).toBe(true);
    const good = readFileSync(target, "utf-8");

    const broken = join(tmp, "broken.ts");
    writeFileSync(broken, "export const x = ;\n");
    const res = await deployOnce(vault, "esm", broken);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("broken.ts"); // named, with a diagnostic
    expect(readFileSync(target, "utf-8")).toBe(good); // the live bundle is untouched

    const again = await deployOnce(vault, "esm"); // fix the source → recovers
    expect(again).toEqual({ ok: true, bytes: good.length, written: false });
  });

  test("a write that cannot land returns ok:false and claims nothing", async () => {
    // ⚠ HONEST SCOPE: this exercises the atomicWrite FAILURE path, NOT the read-back comparison.
    // Deleting the `readIfExists(target) !== code` check leaves this test green — verified by reverting
    // it in isolation. That guard fires only if the filesystem accepts a write and then returns
    // different bytes, which no seam here can stage; it is kept as a tripwire, not as covered code.
    const target = artifactPath(vault);
    mkdirSync(join(vault, "Scripts"), { recursive: true });
    // A directory at the temp sibling path makes the rename fail, so the write never lands.
    mkdirSync(`${target}.tmp`, { recursive: true });
    const res = await deployOnce(vault, "esm");
    expect(res.ok).toBe(false);
    expect(existsSync(target)).toBe(false); // nothing was claimed to be written
  });

  test("a dynamic import does NOT split the bundle — why the >1-output guard is unreachable", async () => {
    // Honest note rather than a fake test: `buildBundle` never passes `splitting: true`, and Bun then
    // INLINES a dynamic import (measured: success, outputs.length === 1). So the `outputs.length !== 1`
    // guard in buildBundle cannot be triggered from a test today — it is a tripwire for the day someone
    // enables splitting. This case pins the premise; if Bun ever starts splitting by default it goes
    // red here first, which is the warning we actually want.
    const split = join(tmp, "split.ts");
    writeFileSync(join(tmp, "lazy.ts"), "export const lazy = 42;\n");
    writeFileSync(split, `export async function go() { return (await import("./lazy.ts")).lazy; }\n`);
    const code = await buildBundle("esm", split);
    expect(code).toContain("42"); // the lazy module was inlined into the single artifact
  });
});

describe("identity-free (D4/NFR3)", () => {
  test("the deploy source names no vault — the path arrives only as --vault", () => {
    const src = readFileSync(join(import.meta.dir, "cn-deploy.ts"), "utf-8");
    expect(src.toLowerCase()).not.toContain("zdrafts");
    expect(src).not.toContain("obsidian2");
    expect(src).not.toContain("Mobile Documents");
  });
});
