// Story 2.6 — the dual-surface verify engine, the standalone `verify` command, and the pipeline filter.
//
// WHAT THIS SUITE IS GUARDING AGAINST, stated once because every case below is a variation on it: a
// verification tool's worst failure is not a crash, it is a PASS reported over a comparison that never
// happened. Four routes to that false green exist here, and each has a case that goes red when the code
// preventing it is removed:
//
//   1. a missing `diff` treated as "nothing to check" (SKIP-0)        → case 10
//   2. `diff -x scripts` silently dropping real in-skill payload      → case 8
//   3. an operand widened past the three compared roots (or narrowed
//      to nothing), so the run compares the wrong thing or nothing    → cases 7, 9
//   4. a repo skipped, or a throw swallowed, and counted as verified  → cases 11, 14, 17
//
// FIXTURES ARE PROGRAMMATIC AND DISPOSABLE (BM-9): scratch repos and estate modules under `os.tmpdir()`,
// never a committed `fixtures/` tree and never a real `bmad install` — so this file runs green on CI with
// no `bmad` binary. The REAL `diff` runs against them, though: stubbing `diff` green everywhere would be
// the same vacuous gate the module is built to prevent, so the stub appears only where the exit code
// itself is the subject (cases 10 and 17).
//
// IDENTITY-FREE (AC13/D4): repos are `alpha`/`beta` under `os.tmpdir()`; no `/Users/…` and no real-repo
// literal. `check:no-consumer-ids` skips `.test.ts`, so this is discipline rather than gate-driven.

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { exists, readIfExists } from "../fsx/index";
import { spawnCapture } from "../proc/index";
import { BmadVerifyError, renderVerifyFindings, SURFACES, verifyRepo } from "./bmad-verify";
import {
  listSkillDirs,
  makeEstateModule,
  makeScratchRepo,
  removeTempTree,
  renderInstalledSurfaces,
} from "./bmad.test-helpers";
import { defaultBmadDeps, type BmadDeps, type InstallLeg, type RepoResult } from "./deps";
import type { BmadRepo } from "./manifest";
import { DEFAULT_SKILLS, parseBmadOpts } from "./opts";
import { runRepoPipeline } from "./pipeline";
import { runBmadVerify } from "./verify";

const JHON = "bmad-agent-jhon-the-loop";
const EPIC = "bmad-agent-epic-the-loop";
const DEV = "bmad-agent-dev-the-loop";
/** The BM-12 default pair — 2 of the 3 dirs a full estate ships. `DEV` is opt-in and must stay unselected. */
const SELECTED = [...DEFAULT_SKILLS];

const CLAUDE = SURFACES[0];
const AGENTS = SURFACES[1];

const scratch = mkdtempSync(join(tmpdir(), "bmad-verify-"));
afterAll(() => removeTempTree(scratch));

let seq = 0;
function fresh(prefix: string): string {
  const dir = join(scratch, `${prefix}-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function put(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf-8");
}

/**
 * `comm` is probed at MODULE SCOPE because `test.skipIf` is evaluated at registration time and therefore
 * cannot read an exit code produced inside a test body. The house precedent is `dual-surface-proof.test.ts`.
 */
const HAS_COMM = (await spawnCapture("comm", ["-3", "/dev/null", "/dev/null"])).code !== 127;

// ── the effect seam under test ────────────────────────────────────────────────────────────────────

interface Spy {
  /** Every subprocess the run issued, with the options object it passed. */
  exec: { cmd: string; args: string[]; opts?: { env?: Record<string, string>; timeout?: number } }[];
  /** Every `deps.git` argv — the instrument behind the NFR-5 verb-allowlist proof. */
  git: string[][];
  /** Every fs WRITE. Must stay empty for the whole file; the members also throw by name. */
  writes: string[];
  print: string[];
  logged: string[];
  json: unknown[];
}

/**
 * A `BmadDeps` whose reads are REAL, whose writes EXPLODE BY NAME, and whose `exec` records and then runs
 * the real `spawnCapture`. `execStub` replaces the subprocess entirely for the cases where the exit code
 * is the subject.
 *
 * The write members do double duty: they record (so a test can assert `writes` is empty) and they throw
 * (so a test cannot pass by forgetting to assert). Either alone is weaker than both.
 */
function verifyDeps(over: {
  moduleRoot?: string;
  manifestPath?: string;
  execStub?: (cmd: string, args: string[]) => { stdout: string; stderr: string; code: number } | undefined;
} = {}): { deps: BmadDeps; spy: Spy } {
  const spy: Spy = { exec: [], git: [], writes: [], print: [], logged: [], json: [] };
  const boom = (what: string) => (target: string) => {
    spy.writes.push(`${what}:${target}`);
    throw new Error(`WRITE in a read-only command: ${what}(${target})`);
  };
  const deps: BmadDeps = {
    exec: async (cmd, args, opts) => {
      spy.exec.push({ cmd, args, ...(opts ? { opts } : {}) });
      const stubbed = over.execStub?.(cmd, args);
      if (stubbed !== undefined) return stubbed;
      return spawnCapture(cmd, args, opts);
    },
    // Records, then answers with the fail-soft `""` the real wrapper returns for a non-repo path. No test
    // here needs a live posture value; what they need is the ARGV, so a mutating verb is provably absent.
    git: (_repo, args) => {
      spy.git.push(args);
      return "";
    },
    fs: {
      readIfExists,
      exists,
      atomicWrite: boom("atomicWrite") as unknown as BmadDeps["fs"]["atomicWrite"],
      ensureDir: boom("ensureDir"),
      cpDir: boom("cpDir") as unknown as BmadDeps["fs"]["cpDir"],
      listDirs: (root) => listDirsReal(root),
    },
    report: {
      lines: () => {
        const buf: string[] = [];
        return { p: (l = "") => void buf.push(l), toString: () => buf.join("\n") };
      },
      jsonOutput: (d) => JSON.stringify(d, null, 2),
      emitJson: (d) => void spy.json.push(d),
      log: (m) => void spy.logged.push(m),
      print: (m) => void spy.print.push(m),
    },
    clock: () => "T0",
    bmadBin: "bmad-under-test",
    manifestPath: over.manifestPath ?? join(scratch, "no-such-manifest.toml"),
    estateModulePath: over.moduleRoot ?? join(scratch, "no-such-module"),
    backupRoot: join(scratch, "backups"),
  };
  return { deps, spy };
}

/** The production `listDirs` behavior, re-expressed here so the seam under test is not its own oracle. */
function listDirsReal(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** A repo in the state a clean dual-surface install leaves it in, plus the module it was rendered from. */
function cleanInstall(skills: readonly string[] = SELECTED, moduleSkills: readonly string[] = skills): {
  repoRoot: string;
  moduleRoot: string;
} {
  const moduleRoot = makeEstateModule({ skills: [...moduleSkills] });
  const repoRoot = fresh("repo");
  renderInstalledSurfaces(repoRoot, moduleRoot, skills);
  return { repoRoot, moduleRoot };
}

/** Write a `[[repos]]` TOML with 2.1's three REQUIRED fields per entry. */
function writeManifest(entries: { path: string; claudeTracked?: boolean; role?: string; name?: string }[]): string {
  const body = entries
    .map(
      (e) =>
        `[[repos]]\npath = ${JSON.stringify(e.path)}\nclaudeTracked = ${e.claudeTracked ?? true}\n` +
        `hasUpstream = false\n${e.name ? `name = ${JSON.stringify(e.name)}\n` : ""}` +
        `${e.role ? `role = ${JSON.stringify(e.role)}\n` : ""}`,
    )
    .join("\n");
  const path = join(fresh("manifest"), "estate.toml");
  writeFileSync(path, body, "utf-8");
  return path;
}

/** The two operand paths of a recorded `diff` argv (`diff -rq -- a b`). */
function operandsOf(call: { args: string[] }): string[] {
  return call.args.slice(call.args.indexOf("--") + 1);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════

describe("AC2/AC3/AC4 — the three comparisons", () => {
  test("1. clean install ⇒ zero findings", async () => {
    const { repoRoot, moduleRoot } = cleanInstall();
    const { deps } = verifyDeps();
    // RED-TURNING INPUT: flip one byte anywhere under either Surface and this is non-empty (case 2).
    expect(await verifyRepo(repoRoot, SELECTED, moduleRoot, deps)).toEqual([]);
    removeTempTree(moduleRoot);
  });

  test("2. Parity: one changed byte under .agents/skills is reported, naming the FILE", async () => {
    const { repoRoot, moduleRoot } = cleanInstall();
    put(join(repoRoot, AGENTS, JHON, "SKILL.md"), "# tampered\n");
    const { deps } = verifyDeps();

    const findings = await verifyRepo(repoRoot, SELECTED, moduleRoot, deps);
    const parity = findings.filter((f) => f.id === "parity");
    expect(parity.length).toBeGreaterThan(0);
    // RED-TURNING INPUT: replace `message` with a count or a boolean and this assertion fires. The path
    // is the operator's next action; a number is not.
    expect(parity.map((f) => f.message).join("\n")).toContain(join(JHON, "SKILL.md"));
    removeTempTree(moduleRoot);
  });

  test("3. Faithfulness: a byte changed in the MODULE is reported under `faithfulness:<skill>`", async () => {
    const { repoRoot, moduleRoot } = cleanInstall();
    put(join(moduleRoot, "skills", EPIC, "SKILL.md"), "# module drifted\n");
    const { deps } = verifyDeps();

    const findings = await verifyRepo(repoRoot, SELECTED, moduleRoot, deps);
    // RED-TURNING INPUT: skip the Faithfulness leg entirely and no finding appears — Parity alone cannot
    // see this, because BOTH Surfaces still agree with each other.
    expect(findings.filter((f) => f.id === "parity")).toEqual([]);
    const faith = findings.filter((f) => f.id === `faithfulness:${EPIC}`);
    expect(faith.length).toBe(1);
    expect(faith[0]!.message).toContain(join(EPIC, "SKILL.md"));
    removeTempTree(moduleRoot);
  });

  test("4. set Parity names a Surface-only skill, in BOTH directions", async () => {
    const { repoRoot, moduleRoot } = cleanInstall();
    mkdirSync(join(repoRoot, CLAUDE, "claude-only"), { recursive: true });
    mkdirSync(join(repoRoot, AGENTS, "agents-only"), { recursive: true });
    const { deps } = verifyDeps();

    const set = (await verifyRepo(repoRoot, SELECTED, moduleRoot, deps)).filter((f) => f.id === "set-parity");
    // RED-TURNING INPUT: compute only `a \ b` and the second assertion fires — half of every real
    // divergence would go unreported by a one-sided difference.
    expect(set.map((f) => f.message)).toContain(`only in ${CLAUDE}: claude-only`);
    expect(set.map((f) => f.message)).toContain(`only in ${AGENTS}: agents-only`);
    removeTempTree(moduleRoot);
  });

  test.skipIf(!HAS_COMM)("5. the in-process symmetric difference matches real `comm -3`", async () => {
    const { repoRoot, moduleRoot } = cleanInstall();
    mkdirSync(join(repoRoot, CLAUDE, "extra-a"), { recursive: true });
    mkdirSync(join(repoRoot, AGENTS, "extra-b"), { recursive: true });
    const { deps } = verifyDeps();

    const mine = (await verifyRepo(repoRoot, SELECTED, moduleRoot, deps))
      .filter((f) => f.id === "set-parity")
      .map((f) => f.message.slice(f.message.lastIndexOf(": ") + 2))
      .sort();

    const oracleDir = fresh("comm");
    const a = join(oracleDir, "a");
    const b = join(oracleDir, "b");
    writeFileSync(a, `${deps.fs.listDirs(join(repoRoot, CLAUDE)).join("\n")}\n`, "utf-8");
    writeFileSync(b, `${deps.fs.listDirs(join(repoRoot, AGENTS)).join("\n")}\n`, "utf-8");
    // THE SPREAD IS MANDATORY. `spawnCapture`'s `env` uses node semantics — it REPLACES the child
    // environment — so a bare `{LC_ALL:"C"}` strips `PATH` and the spawn fails with 127. Case 23 pins
    // exactly that, because a 127 here would look like "comm is unavailable" rather than "the oracle
    // never ran", which is a false green wearing a skip.
    const out = await spawnCapture("comm", ["-3", a, b], { env: { ...process.env, LC_ALL: "C" } });
    expect(out.code).toBe(0);
    // Column-2 entries are TAB-prefixed; both columns are divergences for `comm -3`.
    const oracle = out.stdout.split("\n").map((l) => l.trim()).filter(Boolean).sort();

    expect(mine).toEqual(oracle);
    expect(oracle).toEqual(["extra-a", "extra-b"]);
    removeTempTree(moduleRoot);
  });
});

describe("AC1/AC8 — the scope IS the mechanism", () => {
  test("7. all three `_bmad/*` regen locations are invisible to verify, before and after mutation", async () => {
    const { repoRoot, moduleRoot } = cleanInstall();
    const regen = [
      join(repoRoot, "_bmad", "_config", "manifest.yaml"),
      join(repoRoot, "_bmad", "config.toml"),
      join(repoRoot, "_bmad", "scripts", "x.py"),
    ];
    for (const p of regen) put(p, "v1\n");
    const { deps } = verifyDeps();
    expect(await verifyRepo(repoRoot, SELECTED, moduleRoot, deps)).toEqual([]);

    // MUTATE ALL THREE — this is what `bmad install` does on every run (FR-10), and it is not drift.
    for (const p of regen) put(p, "v2-regenerated-differently\n");
    expect(await verifyRepo(repoRoot, SELECTED, moduleRoot, deps)).toEqual([]);

    // …while a real skill byte still IS drift. Without this half the case above would also pass for a
    // verify that compares nothing at all.
    put(join(repoRoot, CLAUDE, JHON, "SKILL.md"), "# real drift\n");
    expect((await verifyRepo(repoRoot, SELECTED, moduleRoot, deps)).length).toBeGreaterThan(0);
    removeTempTree(moduleRoot);
  });

  test("8. THE `-x scripts` TRAP: an in-skill scripts/ divergence IS reported", async () => {
    // The live estate carries 14 in-skill `scripts/` dirs under `.claude/skills` and 11 under
    // `.agents/skills`, holding real payload. `diff -x` matches BASENAMES, so implementing the
    // regen-exclusion as `-x scripts` would drop every one of them from Parity and report a clean run.
    const { repoRoot, moduleRoot } = cleanInstall();
    put(join(repoRoot, CLAUDE, JHON, "scripts", "pick_methods.py"), "print(1)\n");
    put(join(repoRoot, AGENTS, JHON, "scripts", "pick_methods.py"), "print(2)\n");
    const { deps } = verifyDeps();

    const findings = await verifyRepo(repoRoot, SELECTED, moduleRoot, deps);
    // RED-TURNING INPUT: add `-x scripts` to the argv in `diffTrees` and this goes silently clean.
    expect(findings.map((f) => f.message).join("\n")).toContain("pick_methods.py");
    removeTempTree(moduleRoot);
  });

  test("9. every diff operand sits under one of the 3 compared roots — never repoRoot", async () => {
    const { repoRoot, moduleRoot } = cleanInstall();
    const { deps, spy } = verifyDeps();
    await verifyRepo(repoRoot, SELECTED, moduleRoot, deps);

    const roots = [join(repoRoot, CLAUDE), join(repoRoot, AGENTS), join(moduleRoot, "skills")];
    expect(spy.exec.length).toBe(1 + SELECTED.length);
    for (const call of spy.exec) {
      expect(call.cmd).toBe("diff");
      const operands = operandsOf(call);
      expect(operands.length).toBe(2);
      for (const o of operands) {
        // RED-TURNING INPUT: `diff -rq <repoRoot> <repoRoot>` and both assertions fire at once.
        expect(o).not.toBe(repoRoot);
        expect(roots.some((r) => o === r || o.startsWith(`${r}/`))).toBe(true);
      }
    }
    removeTempTree(moduleRoot);
  });

  test("9b. the engine's own source carries no hashing symbol and no direct effect import", () => {
    // AC1's provable negative and AC13's NFR-4 gate, asserted here as well as at the shell so a future
    // edit turns a TEST red rather than only a CI step nobody runs locally.
    for (const file of ["bmad-verify.ts", "verify.ts"]) {
      const src = readFileSync(join(import.meta.dir, file), "utf-8");
      expect(src).not.toMatch(/createHash|sha256|contentHash|digest/);
      // Every effect arrives through the injected seam — a bare `spawnCapture`/`git`/`fsx` import here
      // would bypass BM-7 entirely. The character class covers BOTH quote styles: a double-quote-only
      // pattern lets `import '../proc'` through and the gate becomes bypassable.
      expect(src).not.toMatch(/["']\.\.\/proc|["']\.\.\/git|["']\.\.\/fsx|node:child_process/);
      // The `./cli` cycle trap — banned even as `import type`, because `check:dep-root` counts type edges.
      expect(src).not.toMatch(/["']\.\/cli["']/);
      // The shared vocabulary is IMPORTED, never re-declared (AC10).
      expect(src).not.toMatch(/const GLYPH|function statusLine|function emptyCounts/);
    }
  });

  test("9c. the engine passes NO `env` to diff — a replaced child env would strip PATH ⇒ 127", async () => {
    // `spawnCapture`'s `env` REPLACES the child environment. If the engine ever supplies one without
    // spreading `process.env`, every `diff` exits 127 — and paired with a SKIP-0 on 127 that is a run
    // that reports PASS having compared nothing. Inheriting is the structural answer; this pins it.
    const { repoRoot, moduleRoot } = cleanInstall();
    const { deps, spy } = verifyDeps();
    await verifyRepo(repoRoot, SELECTED, moduleRoot, deps);
    for (const call of spy.exec) expect(call.opts?.env).toBeUndefined();
    // …and a timeout IS supplied, so a wedged diff resolves 124 instead of hanging the batch.
    for (const call of spy.exec) expect(typeof call.opts?.timeout).toBe("number");
    removeTempTree(moduleRoot);
  });
});

describe("AC5/AC9 — the exit-code mapping and fail-loud completeness", () => {
  test("10. diff 0 / 1 / 2 / 127 map three ways; a missing diff is NOT a SKIP-0", async () => {
    const { repoRoot, moduleRoot } = cleanInstall();

    // 1 ⇒ findings, NO throw. A normal mismatch must never crash the run.
    const one = verifyDeps({
      execStub: () => ({ stdout: "Files a/SKILL.md and b/SKILL.md differ\n", stderr: "", code: 1 }),
    });
    const findings = await verifyRepo(repoRoot, SELECTED, moduleRoot, one.deps);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.message).toBe("Files a/SKILL.md and b/SKILL.md differ");

    // 2 ⇒ throw, carrying stderr VERBATIM. A broken diff must never read as drift.
    const two = verifyDeps({
      execStub: () => ({ stdout: "", stderr: "diff: /x: No such file or directory\n", code: 2 }),
    });
    await expect(verifyRepo(repoRoot, SELECTED, moduleRoot, two.deps)).rejects.toThrow(BmadVerifyError);
    await expect(verifyRepo(repoRoot, SELECTED, moduleRoot, two.deps)).rejects.toThrow(
      /diff: \/x: No such file or directory/,
    );

    // 127 ⇒ ALSO a throw. THE DEVIATION FROM "absent binary = SKIP 0", and the single most important
    // assertion in this file: a SKIP-0 here reports "verify passed" having compared nothing.
    const missing = verifyDeps({ execStub: () => ({ stdout: "", stderr: "spawn diff ENOENT", code: 127 }) });
    await expect(verifyRepo(repoRoot, SELECTED, moduleRoot, missing.deps)).rejects.toThrow(BmadVerifyError);

    // 124 (the timeout sentinel) lands in the same branch by construction.
    const wedged = verifyDeps({ execStub: () => ({ stdout: "", stderr: "", code: 124 }) });
    await expect(verifyRepo(repoRoot, SELECTED, moduleRoot, wedged.deps)).rejects.toThrow(BmadVerifyError);

    removeTempTree(moduleRoot);
  });

  test("11. missing Surface / empty trees / missing module skill all NAME the offender, never throw", async () => {
    // (a) one Surface absent ⇒ a named finding and NOT ONE `diff` CALL. Shelling diff at a missing path
    // would produce exit 2 — correctly fail-loud, but with a far worse message and the rest of the
    // report lost to the throw.
    const a = cleanInstall();
    rmSync(join(a.repoRoot, AGENTS), { recursive: true, force: true });
    const da = verifyDeps();
    const fa = await verifyRepo(a.repoRoot, SELECTED, a.moduleRoot, da.deps);
    expect(fa.length).toBe(1);
    expect(fa[0]!.message).toBe(`missing Surface: ${join(a.repoRoot, AGENTS)}`);
    expect(da.spy.exec).toEqual([]);

    // (b) both roots present but EMPTY ⇒ Parity clean, one named finding per selected skill.
    const emptyRepo = fresh("empty-repo");
    mkdirSync(join(emptyRepo, CLAUDE), { recursive: true });
    mkdirSync(join(emptyRepo, AGENTS), { recursive: true });
    const db = verifyDeps();
    const fb = await verifyRepo(emptyRepo, SELECTED, a.moduleRoot, db.deps);
    expect(fb.filter((f) => f.id === "parity")).toEqual([]);
    expect(fb.map((f) => f.message)).toEqual(
      SELECTED.map((s) => `skill missing from Surface: ${s} (expected ${join(emptyRepo, CLAUDE, s)})`),
    );

    // (c) the MODULE's copy of a selected skill is gone ⇒ named, and the other skill still verifies.
    const c = cleanInstall();
    rmSync(join(c.moduleRoot, "skills", JHON), { recursive: true, force: true });
    const dc = verifyDeps();
    const fc = await verifyRepo(c.repoRoot, SELECTED, c.moduleRoot, dc.deps);
    expect(fc.length).toBe(1);
    expect(fc[0]!.message).toBe(`module skill missing: ${join(c.moduleRoot, "skills", JHON)}`);

    removeTempTree(a.moduleRoot);
    removeTempTree(c.moduleRoot);
  });

  test("12. Faithfulness iterates the SELECTED set, never `readdir(<module>/skills)`", async () => {
    // The module ships THREE skills; a default run selects TWO. `dev-the-loop` is absent from both
    // Surfaces BY DESIGN, so a readdir loop would diff it against a missing directory and manufacture a
    // Faithfulness break out of a correct install.
    const moduleRoot = makeEstateModule({ skills: [JHON, EPIC, DEV] });
    const repoRoot = fresh("repo-selected");
    renderInstalledSurfaces(repoRoot, moduleRoot, SELECTED);
    expect(listSkillDirs(moduleRoot).length).toBe(3);

    const { deps, spy } = verifyDeps();
    // RED-TURNING INPUT: switch the loop to `readdir` and a false `dev-the-loop` break appears here.
    expect(await verifyRepo(repoRoot, SELECTED, moduleRoot, deps)).toEqual([]);
    expect(spy.exec.some((c) => c.args.join(" ").includes(DEV))).toBe(false);
    removeTempTree(moduleRoot);
  });

  test("12b. the marketplace ARRAY is the gate, not the on-disk dir set (2 of 3)", async () => {
    // A module whose `marketplace.json` names two skills while three dirs sit on disk is the ordinary
    // opt-in shape, not a defect. Verify follows the SELECTED set, which is what the array produced —
    // so the third dir's absence from the Surfaces is silence, not a finding.
    const moduleRoot = makeEstateModule({
      skills: [JHON, EPIC, DEV],
      marketplace: {
        name: "estate-fixture",
        plugins: [{ name: "estate-fixture", source: "./", skills: SELECTED.map((s) => `./skills/${s}`) }],
      },
    });
    const repoRoot = fresh("repo-marketplace");
    renderInstalledSurfaces(repoRoot, moduleRoot, SELECTED);
    const { deps } = verifyDeps();
    expect(await verifyRepo(repoRoot, SELECTED, moduleRoot, deps)).toEqual([]);
    removeTempTree(moduleRoot);
  });
});

describe("AC10 — the pure renderer", () => {
  test("15. fixed line format, and the all-zero summary is suppressed entirely", () => {
    expect(renderVerifyFindings([])).toEqual([]);
    expect(renderVerifyFindings([{ severity: "error", id: "parity", message: "m" }])).toEqual([
      `✗ ${"parity".padEnd(40)} m`,
      "",
      "✗ 1",
    ]);
    // RED-TURNING INPUT: hoist the tally to module scope and it accumulates across calls, so this second
    // render would report `✗ 2`. Calling twice is the only way that defect is visible at all.
    expect(renderVerifyFindings([{ severity: "error", id: "parity", message: "m" }])).toEqual([
      `✗ ${"parity".padEnd(40)} m`,
      "",
      "✗ 1",
    ]);
    // `padEnd` never truncates: an id longer than the column widens its own row rather than losing text.
    const long = `faithfulness:${"x".repeat(60)}`;
    expect(renderVerifyFindings([{ severity: "error", id: long, message: "m" }])[0]).toContain(long);
  });
});

describe("AC6/AC9(e,f)/AC10/AC12 — the standalone command", () => {
  test("16. exit contract, the report seam, and the ManifestError path", async () => {
    const { repoRoot, moduleRoot } = cleanInstall();
    const manifestPath = writeManifest([{ path: repoRoot, name: "alpha" }]);

    // clean ⇒ 0, and EVERY stdout write went through the seam (zero bare `console.log`).
    const ok = verifyDeps({ moduleRoot, manifestPath });
    expect(await runBmadVerify({ skills: SELECTED }, [], ok.deps)).toBe(0);
    expect(ok.spy.print.length).toBe(1);
    expect(ok.spy.print[0]).toContain("alpha — ok");

    // `--json` ⇒ the ledger through `emitJson`, and nothing on the human path.
    const asJson = verifyDeps({ moduleRoot, manifestPath });
    expect(await runBmadVerify({ skills: SELECTED }, ["--json"], asJson.deps)).toBe(0);
    expect(asJson.spy.print).toEqual([]);
    expect(asJson.spy.json.length).toBe(1);
    expect((asJson.spy.json[0] as { command: string }).command).toBe("verify");

    // a divergence ⇒ 1.
    put(join(repoRoot, AGENTS, JHON, "SKILL.md"), "# tampered\n");
    const bad = verifyDeps({ moduleRoot, manifestPath });
    expect(await runBmadVerify({ skills: SELECTED }, [], bad.deps)).toBe(1);

    // an unknown `--repos` ⇒ 1 (2.1's declared mapping), NOT 2 and NOT a throw. RED-TURNING INPUT:
    // remove the outer catch and this `resolves` assertion fails with an escaped ManifestError.
    const unknown = verifyDeps({ moduleRoot, manifestPath });
    await expect(runBmadVerify({ skills: SELECTED, repos: ["zzz"] }, [], unknown.deps)).resolves.toBe(1);
    expect(unknown.spy.logged.join("\n")).toContain("zzz");

    removeTempTree(moduleRoot);
  });

  test("13. batch honesty: repo-1 fails, repo-2 is still verified, batchExit is 1", async () => {
    const moduleRoot = makeEstateModule({ skills: SELECTED });
    const alpha = fresh("alpha");
    const beta = fresh("beta");
    renderInstalledSurfaces(alpha, moduleRoot, SELECTED);
    renderInstalledSurfaces(beta, moduleRoot, SELECTED);
    put(join(alpha, AGENTS, JHON, "SKILL.md"), "# tampered\n");

    const manifestPath = writeManifest([
      { path: alpha, name: "alpha" },
      { path: beta, name: "beta" },
    ]);
    const { deps, spy } = verifyDeps({ moduleRoot, manifestPath });
    expect(await runBmadVerify({ skills: SELECTED }, ["--json"], deps)).toBe(1);

    const rows = (spy.json[0] as { repos: RepoResult[] }).repos;
    expect(rows.map((r) => r.repo)).toEqual(["alpha", "beta"]); // Manifest declaration order (BM-16)
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.reason).toContain(join(JHON, "SKILL.md")); // names the file, never a count
    expect(rows[1]!.status).toBe("ok");
    // RED-TURNING INPUT: `return` out of the loop on the first failure and beta's diffs never appear.
    expect(spy.exec.some((c) => operandsOf(c).some((o) => o.startsWith(beta)))).toBe(true);
    // Zero new record fields: every outcome is at its literal zero and `planned` is the empty projection.
    for (const r of rows) {
      expect(r.stagedPaths).toEqual([]);
      expect(r.committed).toBe(false);
      expect(r.pushed).toBe(false);
      expect(r.planned).toEqual({
        installArgv: [],
        backupPath: "",
        wouldStage: [],
        wouldCommit: false,
        wouldPush: false,
      });
    }
    removeTempTree(moduleRoot);
  });

  test("14. BM-17 gitignored and BM-11 source-only are BOTH verified, never skipped", async () => {
    const moduleRoot = makeEstateModule({ skills: SELECTED });
    const ignored = fresh("ignored");
    const sourceOnly = fresh("source-only");
    renderInstalledSurfaces(ignored, moduleRoot, SELECTED);
    renderInstalledSurfaces(sourceOnly, moduleRoot, SELECTED);
    const manifestPath = writeManifest([
      { path: ignored, name: "ignored", claudeTracked: false },
      { path: sourceOnly, name: "src-only", role: "source-only" },
    ]);

    // Default set: 2.1's `selectRepos` omits source-only — the gitignored repo is still verified.
    // RED-TURNING INPUT: add `if (!repo.claudeTracked) continue` and `rows` comes back empty.
    const def = verifyDeps({ moduleRoot, manifestPath });
    expect(await runBmadVerify({ skills: SELECTED }, ["--json"], def.deps)).toBe(0);
    expect((def.spy.json[0] as { repos: RepoResult[] }).repos.map((r) => r.repo)).toEqual(["ignored"]);

    // Explicitly selected: a source-only repo IS verified. Reading it is not operating on it (BM-11
    // scopes the exclusion to the default set and the COMMIT loop; verify is neither).
    const explicit = verifyDeps({ moduleRoot, manifestPath });
    expect(await runBmadVerify({ skills: SELECTED, repos: ["src-only"] }, ["--json"], explicit.deps)).toBe(0);
    const rows = (explicit.spy.json[0] as { repos: RepoResult[] }).repos;
    expect(rows.map((r) => r.repo)).toEqual(["src-only"]);
    expect(rows[0]!.status).toBe("ok");
    removeTempTree(moduleRoot);
  });

  test("17. a code-2 diff in repo-1 fails ONLY repo-1; runBmadVerify resolves, never rejects", async () => {
    const moduleRoot = makeEstateModule({ skills: SELECTED });
    const alpha = fresh("alpha-throw");
    const beta = fresh("beta-throw");
    renderInstalledSurfaces(alpha, moduleRoot, SELECTED);
    renderInstalledSurfaces(beta, moduleRoot, SELECTED);
    const manifestPath = writeManifest([
      { path: alpha, name: "alpha" },
      { path: beta, name: "beta" },
    ]);

    const STDERR = "diff: /nope: No such file or directory";
    const { deps, spy } = verifyDeps({
      moduleRoot,
      manifestPath,
      // Repo-1 only; repo-2 runs the REAL diff, which is what proves the batch actually continued
      // rather than merely returning a second row.
      execStub: (_cmd, args) =>
        args.some((a) => a.startsWith(alpha)) ? { stdout: "", stderr: STDERR, code: 2 } : undefined,
    });

    // RED-TURNING INPUT: drop the per-repo try/catch and this `resolves` assertion fails outright —
    // the BmadVerifyError escapes and the whole batch dies at repo #1.
    await expect(runBmadVerify({ skills: SELECTED }, ["--json"], deps)).resolves.toBe(1);
    const rows = (spy.json[0] as { repos: RepoResult[] }).repos;
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.reason).toContain(STDERR); // stderr VERBATIM
    expect(rows[1]!.status).toBe("ok");
    removeTempTree(moduleRoot);
  });
});

describe("AC7/NFR-5 — read-only, proven on the working tree", () => {
  test("6. a DIRTY repo is byte-identically dirty afterwards; nothing staged; no write; no git verb", async () => {
    const s = await makeScratchRepo();
    const moduleRoot = makeEstateModule({ skills: SELECTED });
    try {
      const g = (...args: string[]): string =>
        execFileSync("git", ["-C", s.dir, ...args], { encoding: "utf-8" }).trim();
      g("config", "user.email", "fixture@example.invalid");
      g("config", "user.name", "bmad fixture");
      g("config", "commit.gpgsign", "false");
      renderInstalledSurfaces(s.dir, moduleRoot, SELECTED);
      // A SEED COMMIT: `makeScratchRepo` only `git init`s, so without this there is no TRACKED file to
      // modify and the "dirty" fixture would be untracked-only — a weaker instrument.
      g("add", "-A");
      g("commit", "-m", "seed");

      // DELIBERATELY DIRTY: a modified TRACKED file plus an untracked one, so any mutation the run made
      // would visibly change the porcelain output.
      put(join(s.dir, CLAUDE, JHON, "SKILL.md"), "# operator edit in flight\n");
      put(join(s.dir, "scratch-note.txt"), "untracked\n");

      const manifestPath = writeManifest([{ path: s.dir, name: "alpha" }]);
      const before = g("status", "--porcelain");
      expect(before).not.toBe(""); // the fixture really is dirty — otherwise this proves nothing

      const { deps, spy } = verifyDeps({ moduleRoot, manifestPath });
      const code = await runBmadVerify({ skills: SELECTED }, [], deps);
      expect(code).toBe(1); // the edit IS a real divergence — verify reports it and still writes nothing

      // 1. WORKING-TREE anchored, byte-identical. Explicitly NOT `git diff <base>..HEAD`: a range diff
      //    is blind to the working tree and green by construction pre-commit — a vacuous gate.
      expect(g("status", "--porcelain")).toBe(before);
      // 2. Nothing staged.
      expect(g("diff", "--cached", "--name-only")).toBe("");
      // 3. The fs write-spy saw nothing (and the members throw, so it could not have been silent).
      expect(spy.writes).toEqual([]);
      // 4. The `deps.git` VERB ALLOWLIST — git mutations ride `deps.git`, not `deps.exec`, so the exec
      //    spy alone cannot prove their absence.
      for (const argv of spy.git) expect(["rev-parse", "rev-list"]).toContain(argv[0]!);
      // 5. The exec-operand spy: only `diff`, and never against `repoRoot`.
      for (const call of spy.exec) {
        expect(call.cmd).toBe("diff");
        for (const o of operandsOf(call)) expect(o).not.toBe(s.dir);
      }
    } finally {
      await s.cleanup();
      removeTempTree(moduleRoot);
    }
  });

  test("6b. `--apply` on the verify path changes nothing — there is no gate to trip", async () => {
    // `VerifyOpts` has no `apply` field, so this is a type-level guarantee as much as a runtime one. The
    // case exists so that adding an `opts.apply` read later has to delete an assertion, not just a comment.
    const { repoRoot, moduleRoot } = cleanInstall();
    const manifestPath = writeManifest([{ path: repoRoot, name: "alpha" }]);
    const plain = verifyDeps({ moduleRoot, manifestPath });
    const applied = verifyDeps({ moduleRoot, manifestPath });

    expect(await runBmadVerify({ skills: SELECTED }, [], plain.deps)).toBe(0);
    expect(await runBmadVerify({ skills: SELECTED }, ["--apply", "--push"], applied.deps)).toBe(0);
    expect(applied.spy.writes).toEqual([]);
    expect(applied.spy.exec.map((c) => c.cmd)).toEqual(plain.spy.exec.map((c) => c.cmd));
    removeTempTree(moduleRoot);
  });
});

describe("AC9 — inputs that violate the stated invariants (the class that bit 2.1–2.4)", () => {
  test("18. a skill dir present in ONE Surface and absent from the other is named twice over", async () => {
    const { repoRoot, moduleRoot } = cleanInstall();
    rmSync(join(repoRoot, AGENTS, EPIC), { recursive: true, force: true });
    const { deps } = verifyDeps();

    const findings = await verifyRepo(repoRoot, SELECTED, moduleRoot, deps);
    // Parity's `Only in …` line AND the set-Parity finding. The redundancy is deliberate: Parity is a
    // content comparison and set Parity is a set comparison, and only the latter survives the case below.
    expect(findings.some((f) => f.id === "parity" && f.message.includes(EPIC))).toBe(true);
    expect(findings.map((f) => f.message)).toContain(`only in ${CLAUDE}: ${EPIC}`);
    removeTempTree(moduleRoot);
  });

  test("19. an EMPTY skill dir on one Surface is still a divergence (why `listDirs`, not `walkFiles`)", async () => {
    // The disqualifying case for deriving the skill set from `walkFiles`: a directory with no files is
    // invisible to a file walk, and it is precisely a real set-Parity divergence.
    const { repoRoot, moduleRoot } = cleanInstall();
    mkdirSync(join(repoRoot, CLAUDE, "hollow"), { recursive: true });
    const { deps } = verifyDeps();
    const findings = await verifyRepo(repoRoot, SELECTED, moduleRoot, deps);
    expect(findings.map((f) => f.message)).toContain(`only in ${CLAUDE}: hollow`);
    removeTempTree(moduleRoot);
  });

  test("20. a symlinked `.claude` is followed, not mistaken for a missing Surface", async () => {
    const moduleRoot = makeEstateModule({ skills: SELECTED });
    const repoRoot = fresh("symlinked");
    const real = fresh("elsewhere-claude");
    // Render into a directory OUTSIDE the repo, then point `.claude` at it — the shape a shared-config
    // estate uses. `exists` and `diff` both follow the link, so the comparison is of the real trees.
    renderInstalledSurfaces(real, moduleRoot, SELECTED);
    renderInstalledSurfaces(repoRoot, moduleRoot, SELECTED);
    rmSync(join(repoRoot, ".claude"), { recursive: true, force: true });
    symlinkSync(join(real, ".claude"), join(repoRoot, ".claude"), "dir");

    const { deps } = verifyDeps();
    expect(await verifyRepo(repoRoot, SELECTED, moduleRoot, deps)).toEqual([]);
    removeTempTree(moduleRoot);
  });

  test("20b. the REAL `listDirs` counts a symlinked CHILD skill dir as a directory", () => {
    // Case 20 covers a symlinked Surface ROOT, which works because the later `diff` operands follow
    // the root link. A symlinked CHILD is the distinct shape, and it is a FALSE GREEN if unhandled:
    // `Dirent.isDirectory()` describes the link, not its target, so a symlinked skill dir present on
    // BOTH Surfaces would drop out of both listings and vanish from the set-Parity comparison
    // entirely — never named, never counted, reported clean. Exercises the REAL `defaultBmadDeps`
    // seam, not the fake, because that is where the bug would live.
    const listDirs = defaultBmadDeps({}).fs.listDirs;
    const root = fresh("symlinked-child");
    const target = fresh("link-target");
    mkdirSync(join(root, "plain-skill"), { recursive: true });
    mkdirSync(join(target, "real-skill"), { recursive: true });
    symlinkSync(join(target, "real-skill"), join(root, "linked-skill"), "dir");
    writeFileSync(join(root, "not-a-dir.md"), "x");
    symlinkSync(join(root, "not-a-dir.md"), join(root, "linked-file"), "file");
    symlinkSync(join(root, "nowhere"), join(root, "broken-link"), "dir");

    // Sorted, and exactly the two real directories: the symlinked FILE and the BROKEN link are
    // both correctly excluded — a following stat says "not a directory" / throws, and neither
    // failure may take the whole listing down to the fail-soft `[]`.
    expect(listDirs(root)).toEqual(["linked-skill", "plain-skill"]);
    // Fail-soft on a missing root is preserved (the Surface pre-check owns that NAMED finding).
    expect(listDirs(join(root, "absent"))).toEqual([]);
  });

  test("21. skill names with a space, a leading dash, or a path escape", async () => {
    const SPACED = "skill with space";
    const DASHED = "-dashed-skill";
    const moduleRoot = makeEstateModule({ skills: [SPACED, DASHED] });
    const repoRoot = fresh("odd-names");
    renderInstalledSurfaces(repoRoot, moduleRoot, [SPACED, DASHED]);
    const { deps, spy } = verifyDeps();

    // A space is just a character: `deps.exec` takes an ARGV ARRAY, never an authored shell string
    // (BM-15), and `--` keeps a leading-dash operand from being re-read as a flag.
    expect(await verifyRepo(repoRoot, [SPACED, DASHED], moduleRoot, deps)).toEqual([]);
    for (const call of spy.exec) expect(call.args[call.args.indexOf("--") - 1]).toBe("-rq");

    // A PATH ESCAPE is refused, and — the part that matters for AC1 — no `diff` operand is ever built
    // from it. RED-TURNING INPUT: drop the `isPlainSegment` guard and `../../etc` becomes an operand
    // outside all three compared roots, which is the invariant AC1 states.
    const escape = verifyDeps();
    const findings = await verifyRepo(repoRoot, ["../../etc", ".", ""], moduleRoot, escape.deps);
    expect(findings.length).toBe(3);
    for (const f of findings) expect(f.id).toBe("skill-name");
    // Only Parity ran; not one Faithfulness comparison was issued for the three bad tokens.
    expect(escape.spy.exec.length).toBe(1);
    removeTempTree(moduleRoot);
  });

  test("22. KNOWN LIMITATION, pinned: `diff -rq` compares CONTENT, not file MODE", async () => {
    // Documented rather than silently inherited. FR-16 prescribes `diff -rq`, and `diff -rq` reports two
    // byte-identical files as identical even when one is executable and the other is not — so a skill
    // script that loses its `+x` in one Surface verifies clean today. This case exists so the limitation
    // is a KNOWN, asserted fact with a test that changes colour the day the mechanism changes, rather
    // than a surprise a later reader discovers in production. Raising it is a spine decision (it means
    // deviating from FR-16's literal recipe), not a story decision — see the Dev Report.
    const { repoRoot, moduleRoot } = cleanInstall();
    // Same bytes on both Surfaces; only the executable bit differs. For a skill that ships a runnable
    // `scripts/*.py`, losing `+x` on one Surface is a real, operator-visible defect that verifies clean.
    chmodSync(join(repoRoot, CLAUDE, JHON, "SKILL.md"), 0o755);
    const { deps } = verifyDeps();
    expect(await verifyRepo(repoRoot, SELECTED, moduleRoot, deps)).toEqual([]);
    // …and the content channel still works, so this is a MODE blind spot and not a dead comparison.
    put(join(repoRoot, CLAUDE, JHON, "SKILL.md"), "# now the content differs too\n");
    expect((await verifyRepo(repoRoot, SELECTED, moduleRoot, deps)).length).toBeGreaterThan(0);
    removeTempTree(moduleRoot);
  });

  test("23. THE ENV TRAP: a supplied `env` REPLACES the child env, so PATH must be spread", async () => {
    // `spawnCapture`'s `env` uses node semantics — `opts.env ? { env: opts.env } : {}` — so a supplied
    // object is the WHOLE child environment. This is why case 5's oracle spreads `process.env` and why
    // the engine passes no `env` at all (case 9c): paired with a SKIP-0 on 127, a binary that stopped
    // resolving would make every comparison silently not run while the run reported PASS.
    //
    // Demonstrated with a binary OUTSIDE the default path on purpose. `diff` and `comm` live in
    // `/usr/bin`, which `execvp` falls back to when PATH is unset, so they happen to survive a stripped
    // env on this platform — which makes the trap LOOK harmless right up until the binary moves or
    // `$BMAD_BIN` points somewhere else. A tool the default path cannot find shows the real behavior.
    const dir = fresh("env-trap");
    const bin = join(dir, "verify-probe");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", "utf-8");
    chmodSync(bin, 0o755);

    const stripped = await spawnCapture("verify-probe", [], { env: { LC_ALL: "C" } });
    expect(stripped.code).toBe(127);
    const spread = await spawnCapture("verify-probe", [], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, LC_ALL: "C" },
    });
    expect(spread.code).toBe(0);
  });

  test("24. an empty selected set compares the Surfaces and NOTHING ELSE — no vacuous pass", async () => {
    // `--skills` is additive so this cannot arise from the CLI today, but a caller CAN pass `[]`, and the
    // honest answer is "Parity and set Parity still ran". What must never happen is a run that issues
    // zero comparisons and reports success; the operand assertion is what says it did not.
    const { repoRoot, moduleRoot } = cleanInstall();
    const { deps, spy } = verifyDeps();
    expect(await verifyRepo(repoRoot, [], moduleRoot, deps)).toEqual([]);
    expect(spy.exec.length).toBe(1);
    expect(operandsOf(spy.exec[0]!)).toEqual([join(repoRoot, CLAUDE), join(repoRoot, AGENTS)]);
    removeTempTree(moduleRoot);
  });

  test("25. no repos selected ⇒ exit 0 and a report that SAYS so, not a silent success", async () => {
    const manifestPath = writeManifest([{ path: fresh("only"), name: "only", role: "source-only" }]);
    const { deps, spy } = verifyDeps({ manifestPath });
    expect(await runBmadVerify({ skills: SELECTED }, [], deps)).toBe(0);
    expect(spy.print.join("")).toContain("No repos selected");
    expect(spy.exec).toEqual([]);
  });
});

describe("Task 3 / AC6+AC11+AC12 — the pipeline verify filter (BM-4 ordering)", () => {
  /**
   * A pipeline-capable seam: writes WORK (the backup filter needs `cpDir`), `git` records and answers
   * fail-soft `""`, and `exec` runs the real `diff` while faking the installer. The installer fake writes
   * nothing on purpose here — these fixtures are pre-rendered, so what is under test is the FILTER, not
   * the harness.
   */
  function pipelineDeps(): { deps: BmadDeps; spy: Spy } {
    const { deps, spy } = verifyDeps();
    const fs = deps.fs as unknown as Record<string, unknown>;
    fs.cpDir = (src: string, dest: string) => cpSync(src, dest, { recursive: true });
    fs.ensureDir = (d: string) => void mkdirSync(d, { recursive: true });
    (deps as unknown as Record<string, unknown>).exec = async (
      cmd: string,
      args: string[],
      opts?: { timeout?: number },
    ) => {
      spy.exec.push({ cmd, args, ...(opts ? { opts } : {}) });
      if (cmd === "diff") return spawnCapture(cmd, args, opts);
      return { stdout: "", stderr: "", code: 0 };
    };
    return { deps, spy };
  }

  const LEG: InstallLeg = { kind: "install", buildArgv: (ctx) => [["install", "--directory", ctx.repo.path]] };

  test("26. a divergent repo FAILS in the pipeline and the git spine never runs (BM-4 fail-fast)", async () => {
    const moduleRoot = makeEstateModule({ skills: SELECTED });
    const repoRoot = fresh("pipe-bad");
    renderInstalledSurfaces(repoRoot, moduleRoot, SELECTED);
    put(join(repoRoot, AGENTS, JHON, "SKILL.md"), "# tampered\n");

    const { deps, spy } = pipelineDeps();
    (deps as unknown as Record<string, unknown>).estateModulePath = moduleRoot;
    const repo: BmadRepo = { path: repoRoot, tools: ["claude-code"], claudeTracked: true, hasUpstream: false };

    const r = await runRepoPipeline(repo, LEG, parseBmadOpts(["--apply"]), deps);
    expect(r.status).toBe("failed");
    // Names the diverging FILE, verbatim — never a count (FR-15/AC6).
    expect(r.reason).toContain(join(JHON, "SKILL.md"));
    // RED-TURNING INPUT: move the filter BELOW the git spine and these fire — a divergent repo would
    // have been staged and committed before anyone noticed.
    expect(r.stagedPaths).toEqual([]);
    expect(r.committed).toBe(false);
    for (const argv of spy.git) expect(["rev-parse", "rev-list"]).toContain(argv[0]!);
    removeTempTree(moduleRoot);
  });

  test("27. dry-run does NOT verify — the filter lives inside the `--apply` branch, correctly", async () => {
    // Diffing a PRE-install tree would manufacture drift out of a repo nothing has happened to yet. The
    // mode-independent path is the standalone `std bmad verify`, which takes no `--apply` at all (case 6b).
    const moduleRoot = makeEstateModule({ skills: SELECTED });
    const repoRoot = fresh("pipe-dry");
    const { deps, spy } = pipelineDeps();
    (deps as unknown as Record<string, unknown>).estateModulePath = moduleRoot;
    const repo: BmadRepo = { path: repoRoot, tools: ["claude-code"], claudeTracked: true, hasUpstream: false };

    const r = await runRepoPipeline(repo, LEG, parseBmadOpts([]), deps);
    expect(r.status).toBe("ok");
    expect(spy.exec).toEqual([]);
    removeTempTree(moduleRoot);
  });

  test("28. a `skipped-gitignored` repo IS verified first (BM-17 — verify never gates on claudeTracked)", async () => {
    const moduleRoot = makeEstateModule({ skills: SELECTED });
    const repoRoot = fresh("pipe-ignored");
    renderInstalledSurfaces(repoRoot, moduleRoot, SELECTED);

    const { deps, spy } = pipelineDeps();
    (deps as unknown as Record<string, unknown>).estateModulePath = moduleRoot;
    const repo: BmadRepo = { path: repoRoot, tools: ["claude-code"], claudeTracked: false, hasUpstream: false };

    const r = await runRepoPipeline(repo, LEG, parseBmadOpts(["--apply"]), deps);
    expect(r.status).toBe("skipped-gitignored");
    // RED-TURNING INPUT: add `if (!repo.claudeTracked) return` ABOVE the verify filter and the diff calls
    // vanish — the estate's working-copy-only repos would then be installed into but never verified.
    expect(spy.exec.filter((c) => c.cmd === "diff").length).toBe(1 + SELECTED.length);

    // …and a DIVERGENT gitignored repo still fails rather than being waved through as a clean skip.
    put(join(repoRoot, AGENTS, EPIC, "SKILL.md"), "# tampered\n");
    const { deps: d2 } = pipelineDeps();
    (d2 as unknown as Record<string, unknown>).estateModulePath = moduleRoot;
    const bad = await runRepoPipeline(repo, LEG, parseBmadOpts(["--apply"]), d2);
    expect(bad.status).toBe("failed");
    removeTempTree(moduleRoot);
  });
});
