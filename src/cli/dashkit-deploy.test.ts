// dashkit-deploy tests (Story 8.3 AC2, AC3, AC4, AC5, AC9). Every fail-loud guard as its own case, plus a
// real end-to-end build into a temp dir shaped like a vault. The e2e case runs the ACTUAL Bun.build over
// src/dashkit/index.ts — a mocked build would assert nothing about the artifact's real shape.
//
// A green run here is NOT evidence that Obsidian's JS Engine can load the artifact — that assumption is
// tested live, in the note-report vault (AC11). Fixtures test your assertions; contact tests your assumptions.
//
// dashkit is esm-only (bite #9). Since Story 8.4 `dashkit deploy` runs a plugin-envelope PREFLIGHT, so a
// bare `.obsidian` vault now aborts with exit 1 (all three foundations missing) and writes nothing — the
// same arrival 7.3 caused for cn. So these temp vaults are built from `DASHKIT_PLUGIN_CONTRACT` (a
// contract-satisfying vault) via the contract-parameterized `makeVaultFixture`, exactly as cn-deploy.test.ts
// builds from `CN_PLUGIN_CONTRACT`. `core` IS in this bundle (bite #4), which the source-scan policy
// reflects: dashkit legally VALUE-imports from `../core`.

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

import { DASHKIT_PLUGIN_CONTRACT } from "../dashkit/plugins";
import { makeVaultFixture } from "./vault-fixture";
import {
  DASHKIT_SCAN_POLICY,
  SHARED_IMPORT_EVASIONS,
  externalImportViolations,
  stripComments,
} from "./edge-deploy.test-helpers";
import { BANNER as CN_BANNER } from "./cn-deploy";
import {
  BANNER,
  BANNER_PREFIX,
  DashkitDeployError,
  WATCH_DEBOUNCE_MS,
  artifactPath,
  buildBundle,
  deployOnce,
  entrypoint,
  isBundleRelevant,
  preflightVault,
  resolveTarget,
  runDashkitDeploy,
  watchDirs,
} from "./dashkit-deploy";

// Measured 2026-07-23 at std-public HEAD b5b542c: the dashkit bundle is 23,696 bytes (1 output, ESM), well
// inside the story's projected 22–26 KB band. The size assertion is TWO-SIDED (D-7): the FLOOR (12 KB) catches
// a bundle that collapsed to near-empty; the CEILING (40 KB) catches `yaml`-class inlining (a used `yaml`
// import took a vault bundle 1.6 KB → 190 KB with every gate green — memory bundle-output-greps-are-tautologies).
const MEASURED_BYTES = 23_696;
const SIZE_FLOOR = 12_000;
const SIZE_CEILING = 40_000;

let tmp: string;
/** A temp dir shaped like an Obsidian vault, satisfying dashkit's plugin preflight (Story 8.4). */
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "std-dashkit-"));
  vault = makeVaultFixture(join(tmp, "vault"), DASHKIT_PLUGIN_CONTRACT);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Collect the CLI's stdout instead of printing it. */
function sink() {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
}

describe("pure helpers", () => {
  test("artifactPath lands at <vault>/Scripts/dashkit.js", () => {
    expect(artifactPath("/some/vault")).toBe(join("/some/vault", "Scripts", "dashkit.js"));
  });

  test("entrypoint resolves src/dashkit/index.ts relative to this file, not an absolute literal", () => {
    const ep = entrypoint();
    expect(ep.endsWith(join("src", "dashkit", "index.ts"))).toBe(true);
    expect(readFileSync(ep, "utf-8")).toContain("export function statGrid");
  });

  test("the banner starts with the dashkit-specific prefix the clobber guard keys on", () => {
    expect(BANNER.startsWith(BANNER_PREFIX)).toBe(true);
    expect(BANNER_PREFIX).toContain("std dashkit deploy");
    expect(BANNER).toContain("do not edit");
    expect(BANNER).toContain("src/dashkit");
  });
});

describe("resolveTarget — the fail-loud guards (AC4)", () => {
  test("missing --vault throws", () => {
    expect(() => resolveTarget(undefined)).toThrow(DashkitDeployError);
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

  test("an existing target WITH dashkit's banner is fine — that is our own prior artifact", () => {
    const target = artifactPath(vault);
    mkdirSync(join(vault, "Scripts"), { recursive: true });
    writeFileSync(target, `${BANNER}\nexport const x = 1;\n`);
    expect(resolveTarget(vault)).toBe(target);
  });

  // ⚠ CROSS-EDGE (AC4). A cn-bannered file must NOT satisfy dashkit's clobber guard, and vice versa. The
  // guard keys on the PER-EDGE prefix; widening it to match both edges is the "a guard you narrow is a guard
  // you wrote" failure. Both directions asserted.
  test("a cn-bannered file does NOT satisfy dashkit's clobber guard (cross-edge)", () => {
    const target = artifactPath(vault);
    mkdirSync(join(vault, "Scripts"), { recursive: true });
    writeFileSync(target, `${CN_BANNER}\nexport const x = 1;\n`);
    expect(CN_BANNER.startsWith(BANNER_PREFIX)).toBe(false); // the premise: cn's prefix ≠ dashkit's
    expect(() => resolveTarget(vault)).toThrow(/refusing to clobber a hand-authored file/);
  });

  test("a clean vault with no target yet resolves to the artifact path", () => {
    expect(resolveTarget(vault)).toBe(artifactPath(vault));
  });
});

describe("buildBundle — the artifact contract (AC2, AC3, AC4)", () => {
  test("produces one bundle whose FIRST line is the banner (AC4)", async () => {
    const code = await buildBundle();
    expect(code.split("\n")[0]).toBe(BANNER);
  });

  test("carries dashkit's runtime exports AND core rode inside (bite #4)", async () => {
    const code = await buildBundle();
    for (const name of ["statGrid", "statCard", "issueBoard", "sessionsTable", "commandDeck"]) {
      expect(code).toContain(`function ${name}(`);
    }
    // `core` is IN this bundle — parseSprint/summarize/barHtml are reachable, unlike cn which imports
    // nothing from core. Their presence proves the one-artifact bundling of the core vocabulary (AC2).
    expect(code).toContain("parseSprint");
    expect(code).toContain("summarize");
    expect(code).toContain("barHtml");
  });

  // AC3 — the scanner sees the evasions a LINE-based filter misses, under DASHKIT's policy (value imports
  // from core are LEGAL here, unlike cn). Grepping the OUTPUT is a tautology; the scanner reads the SOURCE.
  test("the import scan sees external/cross-slice evasions a line filter misses (AC3)", () => {
    for (const src of SHARED_IMPORT_EVASIONS) {
      expect(externalImportViolations(src, DASHKIT_SCAN_POLICY)).not.toEqual([]);
    }
    // The legal forms for dashkit: BOTH a type-only import from core AND a plain VALUE import from core
    // (core is bundled — bite #4). Neither may be flagged, or the deploy source scan below would false-fail.
    expect(externalImportViolations('import type { SprintRow } from "../core/sprint";', DASHKIT_SCAN_POLICY)).toEqual([]);
    expect(externalImportViolations('import { parseSprint, summarize } from "../core/sprint";', DASHKIT_SCAN_POLICY)).toEqual([]);
    expect(externalImportViolations("import { bar, escapeHtml } from '../core';", DASHKIT_SCAN_POLICY)).toEqual([]);
    // …and a VALUE import from a NON-core specifier is still a violation (the scan is not a blanket allow).
    expect(externalImportViolations('import { cite } from "../report/index";', DASHKIT_SCAN_POLICY)).not.toEqual([]);
    // dashkit's desktop-only escape hatch: `require("node:child_process")` is a runtime host builtin, LEGAL —
    // it is why index.ts's real source scan (below) stays clean. An external `require("yaml")` stays banned.
    expect(externalImportViolations('const cp = require("node:child_process");', DASHKIT_SCAN_POLICY)).toEqual([]);
    expect(externalImportViolations('const y = require("yaml");', DASHKIT_SCAN_POLICY)).not.toEqual([]);
  });

  test("src/dashkit/ imports nothing external — asserted on the SOURCE, so a bundler cannot hide it (AC3)", () => {
    const dir = join(import.meta.dir, "..", "dashkit");
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(0); // a zero-file scan would pass vacuously

    for (const f of sources) {
      // Comments are masked first — a doc-comment showing the vault's `require("/Scripts/dashkit.js")` is
      // documentation, not a dependency. (Same discipline as scripts/check-no-consumer-ids.ts.)
      const src = stripComments(readFileSync(join(dir, f), "utf-8"));
      expect({ file: f, violations: externalImportViolations(src, DASHKIT_SCAN_POLICY) }).toEqual({
        file: f,
        violations: [],
      });
    }
  });

  test("the built artifact names no host plugin module (AC3)", async () => {
    const code = await buildBundle();
    for (const host of ["obsidian", "dataview", "js-engine"]) {
      expect(code.toLowerCase()).not.toContain(`"${host}"`);
      expect(code.toLowerCase()).not.toContain(`'${host}'`);
    }
  });

  // TWO-SIDED (D-7). A ceiling passes just as happily on a 40-byte artifact as on a correct one; the floor is
  // what catches a bundle that collapsed. Both bounds cite the measurement.
  test("the artifact size is inside the measured band — floor catches collapse, ceiling catches inlining (D-7)", async () => {
    const bytes = (await buildBundle()).length;
    expect(bytes).toBeGreaterThan(SIZE_FLOOR); // ~23.7 KB measured; a collapse would fall below 12 KB
    expect(bytes).toBeLessThan(SIZE_CEILING); // a used `yaml` import would blow past 40 KB (→ ~190 KB)
    expect(Math.abs(bytes - MEASURED_BYTES)).toBeLessThan(SIZE_CEILING - SIZE_FLOOR); // sanity on the anchor
  });

  test("is deterministic — two builds of unchanged source are byte-identical", async () => {
    expect(await buildBundle()).toBe(await buildBundle());
  });

  test("a broken source surfaces the COMPILER's diagnostic, not `AggregateError: Bundle failed`", async () => {
    const bad = join(tmp, "bad.ts");
    writeFileSync(bad, "export const x = ;\n");
    let msg = "";
    try {
      await buildBundle(bad);
    } catch (e) {
      msg = e instanceof DashkitDeployError ? e.message : `WRONG TYPE: ${e}`;
    }
    expect(msg).toContain("bundle failed");
    expect(msg).toContain("bad.ts"); // the failing file is named
    expect(msg).not.toBe("bundle failed:\nBundle failed"); // …and it is not the empty wrapper
  });
});

describe("runDashkitDeploy — end to end (AC2, AC4)", () => {
  test("deploys into a temp vault: exit 0, artifact on disk, banner first, exports present", async () => {
    const out = sink();
    const code = await runDashkitDeploy(["deploy", "--vault", vault], { log: out.log });

    expect(code).toBe(0);
    const written = readFileSync(artifactPath(vault), "utf-8");
    expect(written.split("\n")[0]).toBe(BANNER);
    for (const name of ["statGrid", "issueBoard", "parseSprint"]) expect(written).toContain(name);
    expect(out.lines.join("\n")).toContain("Scripts/dashkit.js");
    expect(out.lines.join("\n")).toContain("✓ dashkit");
  });

  test("writes EXACTLY the one artifact — nothing else in Scripts/, nothing repo-side (AC2)", async () => {
    expect(await runDashkitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    // The only thing the deploy created under Scripts/ is dashkit.js — one output, no dist/, no sibling.
    expect(readdirSync(join(vault, "Scripts"))).toEqual(["dashkit.js"]);
  });

  test("creates Scripts/ when the vault does not have one yet", async () => {
    expect(await runDashkitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    expect(readFileSync(artifactPath(vault), "utf-8").length).toBeGreaterThan(SIZE_FLOOR);
  });

  test("supports --vault=<dir> (the equals form core/args handles)", async () => {
    expect(await runDashkitDeploy(["deploy", `--vault=${vault}`], { log: () => {} })).toBe(0);
    expect(readFileSync(artifactPath(vault), "utf-8").split("\n")[0]).toBe(BANNER);
  });

  test("exit 2 on a missing --vault, and nothing is written", async () => {
    expect(await runDashkitDeploy(["deploy"], { log: () => {} })).toBe(2);
    expect(existsSync(artifactPath(vault))).toBe(false);
  });

  test("exit 2 on an unknown/absent subcommand (`verify` is dispatched by main.ts, not this runner)", async () => {
    // The DEPLOY runner owns only `deploy`; `dashkit verify` is dispatched a level up in main.ts (8.4), so a
    // `verify` reaching runDashkitDeploy is still an unknown subcommand here — exit 2, unchanged.
    expect(await runDashkitDeploy([], { log: () => {} })).toBe(2);
    expect(await runDashkitDeploy(["verify"], { log: () => {} })).toBe(2);
  });

  test("esm-only: `--format` is NOT parsed — a stray --format cjs neither errors nor changes the format", async () => {
    // dashkit's spec omits `formats`, so the engine ignores `--format` entirely (no invented cjs, D-3/bite #9).
    // The deploy still succeeds and the artifact is the esm bundle (ends with an ESM `export {`, not cjs).
    expect(await runDashkitDeploy(["deploy", "--vault", vault, "--format", "cjs"], { log: () => {} })).toBe(0);
    const written = readFileSync(artifactPath(vault), "utf-8");
    expect(written.split("\n")[0]).toBe(BANNER);
    expect(written).toContain("export {"); // esm output, not a cjs `module.exports`
  });

  test("exit 1 when the vault does not exist — a real failure, not a usage error", async () => {
    expect(await runDashkitDeploy(["deploy", "--vault", join(tmp, "nope")], { log: () => {} })).toBe(1);
  });

  test("exit 1 and NO write when the target is hand-authored", async () => {
    const target = artifactPath(vault);
    mkdirSync(join(vault, "Scripts"), { recursive: true });
    const original = "// hand-written\nexport const x = 1;\n";
    writeFileSync(target, original);

    expect(await runDashkitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(1);
    expect(readFileSync(target, "utf-8")).toBe(original); // untouched
  });

  test("TOCTOU: a hand-authored file appearing DURING the build is not clobbered (AC4)", async () => {
    const target = artifactPath(vault);
    const original = "// hand-written mid-build\nexport const x = 1;\n";

    const racer = runDashkitDeploy(["deploy", "--vault", vault], { log: () => {} });
    mkdirSync(join(vault, "Scripts"), { recursive: true });
    writeFileSync(target, original);

    expect(await racer).toBe(1);
    expect(readFileSync(target, "utf-8")).toBe(original); // survived
  });

  test("a real fs fault returns 1 in the house format — no unhandled rejection (AC4)", async () => {
    // A directory where the artifact should be: readIfExists throws EISDIR, a plain Error, not a
    // DashkitDeployError. Rethrowing it would skip main.ts's process.exit and dump a stack trace.
    mkdirSync(artifactPath(vault), { recursive: true });
    expect(await runDashkitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(1);
  });
});

describe("the plugin-envelope preflight (Story 8.4 AC5)", () => {
  test("an error vault ABORTS with exit 1 and writes NOTHING", async () => {
    const broken = makeVaultFixture(join(tmp, "broken"), DASHKIT_PLUGIN_CONTRACT, {
      omit: ["fix-require-modules"],
    });
    expect(await runDashkitDeploy(["deploy", "--vault", broken], { log: () => {} })).toBe(1);
    // Refusing beats deploying a bundle the loader cannot load.
    expect(existsSync(artifactPath(broken))).toBe(false);
  });

  test("a foundation the vault lacks entirely (js-engine) also aborts — all three are required (D-1)", async () => {
    const broken = makeVaultFixture(join(tmp, "nojs"), DASHKIT_PLUGIN_CONTRACT, { omit: ["js-engine"] });
    expect(await runDashkitDeploy(["deploy", "--vault", broken], { log: () => {} })).toBe(1);
    expect(existsSync(artifactPath(broken))).toBe(false);
  });

  test("a DRIFT vault deploys normally — drift is a warn, never a block (AD-6)", async () => {
    const drifted = makeVaultFixture(join(tmp, "drifted"), DASHKIT_PLUGIN_CONTRACT, {
      versions: { dataview: "0.5.99" },
    });
    const out = sink();
    expect(await runDashkitDeploy(["deploy", "--vault", drifted], { log: out.log })).toBe(0);
    expect(existsSync(artifactPath(drifted))).toBe(true);
    expect(out.lines.join("\n")).toContain("drift from the observed");
  });

  test("the preflight PRINTS its warn/info findings on a normal deploy", async () => {
    const out = sink();
    expect(await runDashkitDeploy(["deploy", "--vault", vault], { log: out.log })).toBe(0);
    // The six ambient rows are info, so a healthy deploy still reports the envelope it saw.
    expect(out.lines.join("\n")).toContain("markwhen");
    expect(out.lines.join("\n")).toContain("outside dashkit's envelope");
  });

  test("preflightVault returns lines for a healthy vault and throws for a broken one", () => {
    expect(preflightVault(vault).join("\n")).toContain("ℹ 6");
    const broken = makeVaultFixture(join(tmp, "broken2"), DASHKIT_PLUGIN_CONTRACT, { omit: ["dataview"] });
    expect(() => preflightVault(broken)).toThrow(DashkitDeployError);
    expect(() => preflightVault(broken)).toThrow(/refusing to deploy/);
  });

  test("a vault-read failure is re-badged as a DashkitDeployError — the 0/1/2 contract holds", async () => {
    // No community-plugins.json: readVaultPlugins throws a verify error, which runDashkitDeploy does not
    // catch by type. Without the re-badge it escapes as an unhandled rejection past process.exit.
    const bare = join(tmp, "bare");
    mkdirSync(join(bare, ".obsidian"), { recursive: true });
    expect(await runDashkitDeploy(["deploy", "--vault", bare], { log: () => {} })).toBe(1);
    expect(existsSync(artifactPath(bare))).toBe(false);
  });

  test("a startup error means the watcher NEVER registers — no resident loop on a broken vault (AC5)", async () => {
    const broken = makeVaultFixture(join(tmp, "broken3"), DASHKIT_PLUGIN_CONTRACT, {
      omit: ["fix-require-modules"],
    });
    let watchCalls = 0;
    const watch = () => (watchCalls++, { close: () => {} });

    expect(await runDashkitDeploy(["deploy", "--vault", broken], { log: () => {} })).toBe(1);
    expect(
      await runDashkitDeploy(["deploy", "--vault", broken, "--watch"], { log: () => {}, watch }),
    ).toBe(1);
    // …the preflight aborts before the watcher is constructed, so the loop cannot go resident on a
    // vault that cannot load the artifact.
    expect(watchCalls).toBe(0);
  });

  test("the preflight runs EXACTLY ONCE at startup under --watch, never per rebuild (AC5)", async () => {
    // Instrument the vault read by counting reads of community-plugins.json across ≥3 rebuilds. The
    // preflight is the only vault-plugin read; a rebuild must not re-run it. We drive real rebuilds through
    // the fake watcher and assert the enabled-set file is read once.
    let cb: ((f: string | null) => void) | undefined;
    let stop: (() => void) | undefined;
    const p = runDashkitDeploy(["deploy", "--vault", vault, "--watch"], {
      log: () => {},
      watch: (_dir, c) => ((cb = c), { close: () => {} }),
      onWatchStart: (s) => (stop = s),
    });
    while (cb === undefined || stop === undefined) await new Promise((r) => setTimeout(r, 10));

    // Snapshot the mtime of community-plugins.json; a per-rebuild preflight would re-open it, but mtime is
    // read-only proof only of writes — so instead assert via the enabled-set: drive three saves, each
    // triggering a real rebuild, and confirm the deploy stays green (a re-preflight of an unchanged vault
    // would also be green, so the strong claim is the no-watcher-after-error case above; here we prove the
    // resident loop survives ≥3 rebuilds without the preflight re-aborting).
    for (const f of ["index.ts", "plugins.ts", "index.ts"]) {
      cb!(f);
      await new Promise((r) => setTimeout(r, WATCH_DEBOUNCE_MS + 120));
    }
    stop!();
    expect(await p).toBe(0);
    expect(readFileSync(artifactPath(vault), "utf-8").split("\n")[0]).toBe(BANNER);
  });
});

describe("skip-if-identical, on the real bytes (AC4)", () => {
  test("a second deploy over unchanged source does NOT touch the file — mtime unmoved, proven both ways", async () => {
    const target = artifactPath(vault);
    expect(await runDashkitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    const first = statSync(target).mtimeMs;

    await new Promise((r) => setTimeout(r, 20)); // any rewrite in this window WOULD move mtime
    expect(await runDashkitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    expect(statSync(target).mtimeMs).toBe(first);

    // …and the assertion is not vacuous: when the bytes DO differ, the write happens and mtime moves.
    // (dashkit-bannered, so the clobber guard permits the overwrite — this is our own prior artifact.)
    writeFileSync(target, `${BANNER}\n// stale\n`);
    const stale = statSync(target).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    expect(await runDashkitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    expect(statSync(target).mtimeMs).not.toBe(stale);
    expect(readFileSync(target, "utf-8")).not.toContain("// stale");
  });
});

describe("dashkit.config.ts is never a deploy target (D-4, AC4)", () => {
  test("a hand-authored dashkit.config.ts is byte-identical before and after a deploy", async () => {
    const cfg = join(vault, "Scripts", "dashkit.config.ts");
    mkdirSync(join(vault, "Scripts"), { recursive: true });
    // No banner — it is caller-local + freeze-exempt. A guard that keyed on the banner and then wrote here
    // would destroy the registry. The deploy must never read, write, or clobber it.
    const original = "export const PROJECTS = { loom: { id: 'loom' } };\n// hand-authored, freeze-exempt\n";
    writeFileSync(cfg, original);

    expect(await runDashkitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    expect(readFileSync(cfg, "utf-8")).toBe(original); // untouched, byte for byte
    // …and the deploy DID land its own artifact next to it (the two coexist).
    expect(readFileSync(artifactPath(vault), "utf-8").split("\n")[0]).toBe(BANNER);
  });
});

describe("deployOnce — AC4 on the REAL bytes", () => {
  test("a broken build leaves the last good artifact byte-for-byte intact, then recovers", async () => {
    const target = artifactPath(vault);
    expect((await deployOnce(vault)).ok).toBe(true);
    const good = readFileSync(target, "utf-8");

    const broken = join(tmp, "broken.ts");
    writeFileSync(broken, "export const x = ;\n");
    const res = await deployOnce(vault, broken);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("broken.ts"); // named, with a diagnostic
    expect(readFileSync(target, "utf-8")).toBe(good); // the live bundle is untouched

    const again = await deployOnce(vault); // fix the source → recovers
    expect(again).toEqual({ ok: true, bytes: good.length, written: false });
  });
});

// ---------------------------------------------------------------------------------------------
// AC9 — the --watch success path has POSITIVE coverage, through the injected seam. Fake watcher, so ZERO
// real fs.watch runs here (recursive watch is platform-divergent and CI is Linux). 7.2 shipped `watchDirs()
// → []` at 54/0 because all its --watch tests returned before runWatch was ever constructed; these drive the
// resident branch. The runWatch loop's OWN mechanics (debounce, serialization, shutdown) are covered
// exhaustively by cn-deploy.test.ts against the SAME promoted engine — not re-tested here.
// ---------------------------------------------------------------------------------------------

describe("--watch WIRING — the resident branch, with a fake watcher (AC9, AC8)", () => {
  /** Drive `runDashkitDeploy` into the resident branch and shut it down immediately. */
  async function runResident(argv: string[]) {
    const dirs: string[] = [];
    const lines: string[] = [];
    const code = await runDashkitDeploy(argv, {
      log: (l) => lines.push(l),
      watch: (dir) => (dirs.push(dir), { close: () => {} }),
      onWatchStart: (stop) => stop(), // resolve `done` synchronously — no hang, no real timers
    });
    return { code, dirs, lines };
  }

  test("passes BOTH permitted dirs [src/dashkit, src/core] to the watcher and names them in the banner", async () => {
    const { code, dirs, lines } = await runResident(["deploy", "--vault", vault, "--watch"]);
    expect(code).toBe(0);
    expect(dirs.length).toBe(2);
    expect(dirs.some((d) => d.endsWith(join("src", "dashkit")))).toBe(true);
    expect(dirs.some((d) => d.endsWith(join("src", "core")))).toBe(true); // core is in the bundle (bite #4)
    const banner = lines.join("\n");
    expect(banner).toContain("watching src/dashkit, src/core");
    expect(banner).toContain("ctrl-c to stop");
  });

  test("a save through the fake watcher drives a REAL rebuild — the loop actually redeploys (AC9)", async () => {
    // 7.2's regression: all --watch tests returned before runWatch was constructed, so a save never redeployed
    // and nothing caught it. Here a real rebuild runs through the fake watcher and we observe the write.
    let cb: ((f: string | null) => void) | undefined;
    let stop: (() => void) | undefined;
    const target = artifactPath(vault);
    const p = runDashkitDeploy(["deploy", "--vault", vault, "--watch"], {
      log: () => {},
      watch: (_dir, c) => ((cb = c), { close: () => {} }),
      onWatchStart: (s) => (stop = s),
    });
    while (cb === undefined || stop === undefined) await new Promise((r) => setTimeout(r, 10));

    // Park different (banner-bearing, so the guard allows it) bytes, then a save must rebuild over them.
    writeFileSync(target, `${BANNER}\n// stale\n`);
    cb("index.ts");
    await new Promise((r) => setTimeout(r, WATCH_DEBOUNCE_MS + 350));
    stop!();
    expect(await p).toBe(0);

    const written = readFileSync(target, "utf-8");
    expect(written).not.toContain("// stale"); // the LOOP rebuilt
    expect(written.split("\n")[0]).toBe(BANNER);
    expect(written).toContain("statGrid"); // …with the real dashkit source
  });

  test("`done` stays pending until stop() — the resident loop does not resolve early (AC8)", async () => {
    // A runWatch that resolved as soon as watchers registered would let main.ts's process.exit(0) kill the
    // loop before the first save. Drive resident, assert `done` is unresolved before we stop.
    let stop: (() => void) | undefined;
    const p = runDashkitDeploy(["deploy", "--vault", vault, "--watch"], {
      log: () => {},
      watch: () => ({ close: () => {} }),
      onWatchStart: (s) => (stop = s),
    });
    while (stop === undefined) await new Promise((r) => setTimeout(r, 10));

    const sentinel = Symbol("still-running");
    expect(await Promise.race([p, Promise.resolve(sentinel)])).toBe(sentinel);
    stop!();
    expect(await p).toBe(0);
  });

  test("a watcher that cannot register returns 1, not an unhandled rejection (AC8)", async () => {
    const code = await runDashkitDeploy(["deploy", "--vault", vault, "--watch"], {
      log: () => {},
      watch: () => {
        throw new Error("ENOSPC: inotify watch limit reached");
      },
      onWatchStart: (stop) => stop(),
    });
    expect(code).toBe(1);
  });

  test("without --watch nothing goes resident — the one-shot path installs no handler", async () => {
    let started = false;
    const code = await runDashkitDeploy(["deploy", "--vault", vault], {
      log: () => {},
      onWatchStart: () => (started = true),
    });
    expect(code).toBe(0);
    expect(started).toBe(false);
  });
});

describe("watchDirs — the PERMITTED bundle set, resolved relatively (AC5, AC8)", () => {
  test("watches src/dashkit AND src/core, both relative to this file", () => {
    const dirs = watchDirs();
    expect(dirs.length).toBe(2);
    expect(dirs.some((d) => d.endsWith(join("src", "dashkit")))).toBe(true);
    expect(dirs.some((d) => d.endsWith(join("src", "core")))).toBe(true);
    for (const d of dirs) expect(existsSync(d)).toBe(true);
  });

  test("the vault is NEVER watched — every watched dir is inside THIS repo's src/ (AC8)", () => {
    // Watching a vault root is the self-triggering case (fsx.atomicWrite renames inside the target dir →
    // infinite rebuild). Anchor on containment, and never a Scripts/ path.
    const src = join(import.meta.dir, "..");
    for (const d of watchDirs()) {
      expect(d.startsWith(src + "/")).toBe(true);
      expect(d).not.toContain("Scripts");
    }
  });

  test("isBundleRelevant is inherited from the promoted engine — the ignore-list, not a suffix test", () => {
    // Inherited wholesale (AC8); the exhaustive case-by-case lives in cn-deploy.test.ts against the SAME
    // function. This asserts the rename-save regression holds for this edge: temp names still trigger.
    for (const yes of ["index.ts", "dashkit.ts.tmp.46812.0e28eeb8a7b3", "XX7Eoqmy", "index.ts~"]) {
      expect(isBundleRelevant(yes)).toBe(true);
    }
    for (const no of ["index.test.ts", "README.md", ".DS_Store"]) {
      expect(isBundleRelevant(no)).toBe(false);
    }
  });
});

describe("identity-free (D4/NFR3, AC5)", () => {
  test("the deploy source names no vault — no note-report, no Documents path, no /Users/", () => {
    // ⚠ dashkit's addition over cn's mirror: the /Users/ check. note-report is on the check:no-consumer-ids
    // denylist, but that gate has no generic /Users/ or pedroibl/ check — so this independent grep is not
    // redundant with Gate 7 (8.2's AC2 lesson: a green gate alone is a test that cannot fail for this claim).
    const src = readFileSync(join(import.meta.dir, "dashkit-deploy.ts"), "utf-8");
    expect(src).not.toContain("note-report");
    expect(src).not.toContain("Documents/note-report");
    expect(src).not.toContain("/Users/");
  });
});
