// Story 2.3 acceptance suite — the install leg: guard → backup → shell-installer → [verify] (AC1–AC9).
//
// This is the first story where `--apply` MUTATES, so the suite's job is not coverage — it is to make
// each safety claim fail loudly when its invariant is violated. Every block below names the input that
// would break the property, because "a property stated in prose that nothing enforces" is how the two
// previous stories in this epic shipped defects that passed review.
//
// THE FOUR ASSERTIONS THAT ARE THE CONTRACT, not ordinary coverage:
//   1. A half-family estate aborts BEFORE any repo is touched — proven by asserting the exec and cpDir
//      spies recorded ZERO calls, not merely that a throw happened.
//   2. bmad-manager writes NOTHING into a Surface tree — proven by a seam whose writes THROW when the
//      destination resolves under the repo. The installer (mocked) is the only thing that copies.
//   3. The staging dir the installer is pointed at is the staging dir that was WRITTEN — proven under a
//      MONOTONIC clock, because a fixed clock cannot see a double `stagingPathFor` call, and the
//      production clock is live. This is the one test that catches the C3 trap.
//   4. The digest detects a whitespace-only edit — the property that separates an exact hash from
//      `core.contentHash`, whose normalization would report false-equal on real drift.
//
// MOCKED `proc` MEANS THIS IS NOT THE WHOLE-SYSTEM IDEMPOTENCY PROOF. No real `bmad install` runs here,
// so FR-10's "0 of 75 files changed, three times" cannot be measured. What is honestly locked at unit
// scope is (a) bmad-manager itself writes zero Surface-tree files, so any re-run drift must come from
// the installer, and (b) `skillTreeDigest` excludes by-design regen and detects real drift. The
// end-to-end composition is Story 2.7's real-install fixture harness.
//
// IDENTITY-FREE (AC9/D4): every path is `os.tmpdir()`-derived, repos are `alpha`/`beta`, and the estate
// is a synthetic module — never the package's own `bmad-estate/`, whose contents would silently decide
// whether these tests pass.

import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { makeEstateModule, removeTempTree } from "./bmad.test-helpers";
import { runBmad } from "./cli";
import { BmadError, type BmadDeps, type RepoResult } from "./deps";
import { materializeStaging, moduleGuard, stagingPathFor } from "./estate-source";
import { installLeg, runBmadInstall } from "./install";
import { parseBmadOpts } from "./opts";
import { buildPlan, isRegenDir, skillTreeDigest } from "./pipeline";

const JHON = "bmad-agent-jhon-the-loop";
const EPIC = "bmad-agent-epic-the-loop";
const DEV = "bmad-agent-dev-the-loop";

/** The two Surface trees, spelled out here rather than imported — a test that shares the constant with */
/** the code under test cannot catch the code renaming it. */
const CLAUDE_SKILLS = join(".claude", "skills");
const AGENTS_SKILLS = join(".agents", "skills");

const scratch = mkdtempSync(join(tmpdir(), "bmad-install-"));
const tempTrees: string[] = [scratch];

afterAll(() => {
  for (const dir of tempTrees) removeTempTree(dir);
});

let seq = 0;
/** A fresh, uniquely-named directory under the suite scratch. */
function fresh(prefix: string): string {
  const dir = join(scratch, `${prefix}-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a file (and its parents) with `content`. */
function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

// ── the fake seam ─────────────────────────────────────────────────────────────────────────────────

/** Everything an assertion needs to see about what a run DID. */
interface Spy {
  exec: { cmd: string; args: string[] }[];
  /** Every `deps.git` argv the run issued (2.4) — the instrument for "which git calls did 2.3 cause?". */
  git: string[][];
  cpDir: { src: string; dest: string }[];
  atomicWrite: { path: string; content: string }[];
  ensureDir: string[];
  clock: number;
  json: unknown[];
  print: string[];
  logged: string[];
}

interface Harness {
  deps: BmadDeps;
  spy: Spy;
  /** The temp repo roots, in Manifest order. */
  repos: { alpha: string; beta: string };
  estate: string;
  stateHome: string;
}

interface HarnessOpts {
  /** What the mocked installer returns, keyed by repo basename; `*` is the fallback. */
  exec?: Record<string, { stdout?: string; stderr?: string; code: number }>;
  /** Skill dirs the synthetic estate carries WITH files. Default: all three. */
  skills?: string[];
  /** Skill dirs the synthetic estate carries EMPTY. */
  emptySkills?: string[];
  /** Replaces the estate's marketplace.json body (`null` writes none). */
  marketplace?: unknown;
  /** `false` ⇒ a MONOTONIC clock (`T0`, `T1`, …) instead of a fixed `T0`. */
  fixedClock?: boolean;
  /** Make every write whose destination resolves inside a repo THROW (the no-self-copy instrument). */
  forbidRepoWrites?: boolean;
}

/**
 * Build a fully-wired fake seam over real temp directories.
 *
 * The fs members are REAL (against temp trees) rather than pure spies: the guard walks the estate, the
 * backup copies actual files, and the digest reads actual bytes — a recorded-call-only fake would let
 * every one of those pass while doing nothing. Only `exec` is mocked, because shelling a real `bmad`
 * is Story 2.7's fixture harness, not a unit test.
 */
function harness(opts: HarnessOpts = {}): Harness {
  const spy: Spy = {
    exec: [],
    git: [],
    cpDir: [],
    atomicWrite: [],
    ensureDir: [],
    clock: 0,
    json: [],
    print: [],
    logged: [],
  };

  const root = fresh("case");
  const alpha = join(root, "repos", "alpha");
  const beta = join(root, "repos", "beta");
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });

  const estate = makeEstateModule({
    skills: opts.skills ?? [JHON, EPIC, DEV],
    ...(opts.emptySkills ? { emptySkills: opts.emptySkills } : {}),
    ...(opts.marketplace !== undefined ? { marketplace: opts.marketplace } : {}),
  });
  tempTrees.push(estate);

  const stateHome = join(root, "state", "std", "bmad-manager");
  const manifestPath = join(root, "estate.toml");
  writeFileSync(
    manifestPath,
    `[[repos]]\npath = ${JSON.stringify(alpha)}\nclaudeTracked = true\nhasUpstream = true\nbranch = "main"\n\n` +
      `[[repos]]\npath = ${JSON.stringify(beta)}\nclaudeTracked = true\nhasUpstream = false\n`,
    "utf-8",
  );

  const repoRoots = [alpha, beta];
  const guardRepoWrite = (what: string, target: string): void => {
    if (!opts.forbidRepoWrites) return;
    const abs = resolve(target);
    for (const repo of repoRoots) {
      if (abs === resolve(repo) || abs.startsWith(resolve(repo) + sep)) {
        throw new Error(`SELF-COPY: bmad-manager ${what} inside the repo at ${abs}`);
      }
    }
  };

  const execTable = opts.exec ?? { "*": { code: 0 } };
  let tick = 0;

  const deps: BmadDeps = {
    exec: async (cmd, args) => {
      spy.exec.push({ cmd, args });
      // Keyed off `--directory`, so a two-repo batch can make one repo fail and one succeed.
      const dirFlag = args.indexOf("--directory");
      const target = dirFlag >= 0 ? (args[dirFlag + 1] ?? "") : "";
      const key = Object.keys(execTable).find((k) => k !== "*" && target.endsWith(k));
      const r = (key ? execTable[key] : execTable["*"]) ?? { code: 0 };
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code };
    },
    // AMENDED BY 2.4, which lands the real git spine on the apply path — "this harness never reaches
    // git" stopped being true, and pretending otherwise would have meant fencing 2.4 out of the very
    // pipeline it fills. RECORD-AND-FAIL-SOFT is the honest replacement: it returns `""` for every
    // call, which is EXACTLY what `src/git` returns against this suite's repo roots (plain temp dirs,
    // never `git init`-ed). So 2.3's outcomes stay at their zero values for the real reason rather than
    // by construction, and `spy.git` still lets a test assert precisely which argv the spine issued.
    // Deliberately NOT the real `git`: a unit suite must never run a `git` write, and `git-safety.test.ts`
    // owns the real-git behavior against disposable scratch repos.
    git: (_repo, args) => {
      spy.git.push(args);
      return "";
    },
    fs: {
      readIfExists: (p) => {
        try {
          return readFileSync(p, "utf-8");
        } catch {
          return null;
        }
      },
      exists: (p) => existsSync(p),
      ensureDir: (dir) => {
        guardRepoWrite("ensureDir", dir);
        spy.ensureDir.push(dir);
        mkdirSync(dir, { recursive: true });
      },
      atomicWrite: (p, content) => {
        guardRepoWrite("atomicWrite", p);
        spy.atomicWrite.push({ path: p, content });
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content, "utf-8");
      },
      cpDir: (src, dest) => {
        guardRepoWrite("cpDir", dest);
        spy.cpDir.push({ src, dest });
        cpSync(src, dest, { recursive: true });
      },
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
    clock: () => {
      spy.clock++;
      // Fixed by default (SM-3 comparability); monotonic on demand, which is what exposes a second
      // `stagingPathFor` call — the failure mode a fixed clock structurally cannot see.
      return opts.fixedClock === false ? `T${tick++}` : "T0";
    },
    bmadBin: "bmad-under-test",
    manifestPath,
    estateModulePath: estate,
    backupRoot: join(stateHome, "backups"),
  };

  return { deps, spy, repos: { alpha, beta }, estate, stateHome };
}

/** Give a repo one or both Surface trees, each with a file. */
function seedSurfaces(repo: string, trees: string[] = [CLAUDE_SKILLS, AGENTS_SKILLS]): void {
  for (const tree of trees) put(join(repo, tree, JHON, "SKILL.md"), `# ${JHON}\n`);
}

/** Only the BACKUP copies — a run also copies skill dirs into the staging tree, which is not a backup. */
function backupCopies(spy: Spy): { src: string; dest: string }[] {
  return spy.cpDir.filter((c) => c.dest.includes(`${sep}backups${sep}`));
}

/** The written staging descriptor's `plugins[0].skills` array — the BM-12 install gate. */
function stagedSkillsArray(spy: Spy): string[] {
  const write = spy.atomicWrite.find((w) => w.path.endsWith("marketplace.json"));
  if (!write) throw new Error("no marketplace.json was written");
  return (JSON.parse(write.content) as { plugins: { skills: string[] }[] }).plugins[0]!.skills;
}

// ── AC1 — the module guard is a whole-run precondition ────────────────────────────────────────────

describe("AC1 — module guard aborts the WHOLE RUN before any repo is touched (FR-6/BM-13)", () => {
  test("an ABSENT skill dir throws BmadError naming it — and nothing was executed or copied", async () => {
    // Only jhon ships; the default set also wants epic.
    const { deps, spy } = harness({ skills: [JHON] });
    await expect(runBmadInstall(["--repos", "alpha", "--apply"], deps)).rejects.toThrow(BmadError);
    await expect(runBmadInstall(["--repos", "alpha", "--apply"], deps)).rejects.toThrow(EPIC);
    // The assertion that matters: not "it threw", but "it threw before touching anything".
    expect(spy.exec).toEqual([]);
    expect(spy.cpDir).toEqual([]);
    expect(spy.atomicWrite).toEqual([]);
  });

  test("a PRESENT-BUT-EMPTY skill dir is a half-family too, and also aborts (the exists-only hole)", async () => {
    const { deps, spy } = harness({ skills: [JHON], emptySkills: [EPIC] });
    await expect(runBmadInstall(["--apply"], deps)).rejects.toThrow(BmadError);
    await expect(runBmadInstall(["--apply"], deps)).rejects.toThrow(/empty/);
    expect(spy.exec).toEqual([]);
    expect(spy.cpDir).toEqual([]);
  });

  test("the control: with the family complete, the guard passes and the installer DOES fire", async () => {
    // The red-turning input for the two cases above — if this did not shell, they would pass vacuously.
    const { deps, spy } = harness();
    expect(await runBmadInstall(["--repos", "alpha", "--apply"], deps)).toBe(0);
    expect(spy.exec.length).toBe(1);
  });

  test("the guard runs in DRY RUN too — a half-family is surfaced without writing anything", async () => {
    const { deps, spy } = harness({ skills: [JHON] });
    await expect(runBmadInstall([], deps)).rejects.toThrow(BmadError);
    expect(spy.atomicWrite).toEqual([]);
    expect(spy.ensureDir).toEqual([]);
    expect(spy.exec).toEqual([]);
  });

  test("a BmadError from the guard maps to exit 1 at the router, and names the skill on stderr", async () => {
    const { deps, spy } = harness({ skills: [JHON] });
    expect(await runBmad(["install", "--apply"], deps)).toBe(1);
    expect(spy.logged.join("\n")).toContain(EPIC);
  });

  test("a --skills value with a path separator is rejected before it can escape the estate", async () => {
    const { deps, spy } = harness();
    await expect(runBmadInstall(["--skills", "../../elsewhere", "--apply"], deps)).rejects.toThrow(
      BmadError,
    );
    // Without the segment check, `join(estate,'skills','../../elsewhere')` would resolve outside the
    // module and the staging copy would happily read from there.
    expect(spy.cpDir).toEqual([]);
  });

  test("moduleGuard returns the RESOLVED estate dir names, de-duplicated", () => {
    const { deps } = harness();
    // The shorthand and the full name are the same directory; two entries would be a malformed
    // marketplace descriptor with a duplicated skill.
    expect(moduleGuard(deps, [JHON, "dev-the-loop", DEV])).toEqual([JHON, DEV]);
  });
});

// ── AC2 — reversible, out-of-repo backup ──────────────────────────────────────────────────────────

describe("AC2 — backup of both Surface trees, out-of-repo, reported (FR-7/BM-8)", () => {
  test("both trees present ⇒ both copied under <backupRoot>/<repo>/<clock>, path reported", async () => {
    const h = harness();
    seedSurfaces(h.repos.alpha);
    await runBmadInstall(["--repos", "alpha", "--apply", "--json"], h.deps);

    const expected = join(h.stateHome, "backups", "alpha", "T0");
    expect(backupCopies(h.spy).map((c) => c.dest).sort()).toEqual(
      [join(expected, AGENTS_SKILLS), join(expected, CLAUDE_SKILLS)].sort(),
    );
    expect(rowsOf(h.spy)[0]?.backupPath).toBe(expected);
    // Reversible for real, not just reported: the bytes are on disk under the state home.
    expect(existsSync(join(expected, CLAUDE_SKILLS, JHON, "SKILL.md"))).toBe(true);
  });

  test("only ONE tree present ⇒ only that one is copied, and the path is still reported", async () => {
    const h = harness();
    seedSurfaces(h.repos.alpha, [CLAUDE_SKILLS]);
    await runBmadInstall(["--repos", "alpha", "--apply", "--json"], h.deps);

    const backups = backupCopies(h.spy);
    expect(backups.length).toBe(1);
    expect(backups[0]!.dest).toContain(CLAUDE_SKILLS);
    expect(rowsOf(h.spy)[0]?.backupPath).toBe(join(h.stateHome, "backups", "alpha", "T0"));
  });

  test("NEITHER tree ⇒ a reported no-op, not an error (the ordinary first-install case)", async () => {
    const h = harness();
    await runBmadInstall(["--repos", "alpha", "--apply", "--json"], h.deps);

    const row = rowsOf(h.spy)[0]!;
    expect(row.status).toBe("ok");
    expect(row.backupPath).toBeUndefined();
    expect(row.reason).toContain("no existing Surface trees");
    expect(backupCopies(h.spy)).toEqual([]);
  });

  test("the backup NEVER writes inside the repo — the seam explodes if it tries (BM-8)", async () => {
    const h = harness({ forbidRepoWrites: true });
    seedSurfaces(h.repos.alpha);
    // Completes cleanly: every write lands under the state home or the staging dir, never `<repo>/…`.
    expect(await runBmadInstall(["--repos", "alpha", "--apply"], h.deps)).toBe(0);
  });

  test("a FAILING backup fails the repo and the installer is NOT shelled (fail-fast, FR-7)", async () => {
    const h = harness();
    seedSurfaces(h.repos.alpha);
    const realCpDir = h.deps.fs.cpDir;
    h.deps.fs.cpDir = (src, dest) => {
      if (dest.includes("backups")) throw new Error("disk full");
      realCpDir(src, dest);
    };
    expect(await runBmadInstall(["--repos", "alpha", "--apply", "--json"], h.deps)).toBe(1);

    const row = rowsOf(h.spy)[0]!;
    expect(row.status).toBe("failed");
    expect(row.reason).toContain("disk full");
    // The whole point: a repo we could not snapshot must not be mutated.
    expect(h.spy.exec).toEqual([]);
  });

  test("the backup timestamp comes from deps.clock, so two runs are comparable", async () => {
    const h = harness();
    seedSurfaces(h.repos.alpha);
    await runBmadInstall(["--repos", "alpha", "--apply", "--json"], h.deps);
    expect(rowsOf(h.spy)[0]?.backupPath?.endsWith(join("alpha", "T0"))).toBe(true);
  });
});

/** The `--json` ledger rows of the most recent render. */
function rowsOf(spy: Spy): RepoResult[] {
  const payload = spy.json[spy.json.length - 1] as { repos: RepoResult[] } | undefined;
  return payload?.repos ?? [];
}

// ── AC3 — the exact installer invocation, and zero self-copy ──────────────────────────────────────

describe("AC3 — exact FR-8 invocation through deps.exec, no self-copy (BM-3/BM-12/BM-15)", () => {
  test("the argv is the frozen FR-8 string, verbatim and order-preserved", async () => {
    const h = harness();
    await runBmadInstall(["--repos", "alpha", "--apply"], h.deps);

    const call = h.spy.exec[0]!;
    expect(call.cmd).toBe("bmad-under-test"); // BM-3: the injected binary, never a baked path
    expect(call.args).toEqual([
      "install",
      "--directory",
      h.repos.alpha,
      "--modules",
      "core",
      "--custom-source",
      join(h.stateHome, "staging", "T0"),
      "--tools",
      "claude-code,antigravity-cli",
      "--yes",
    ]);
  });

  // Found by the cross-vendor review. `stateHomeOf` hand-rolled a `lastIndexOf` slice, which returns
  // the directory ITSELF when the input carries a trailing separator — so staging would have nested
  // INSIDE backups instead of beside it. Reachable in production: `defaultBmadDeps` derives
  // `backupRoot` from `$XDG_STATE_HOME`, and a trailing slash there is perfectly legal. Nothing in the
  // suite supplied that input, which is exactly the shape of defect this epic keeps shipping.
  test("stagingPathFor puts staging BESIDE backups, even when backupRoot has a trailing separator", () => {
    const h = harness();
    const clean = stagingPathFor({ ...h.deps, backupRoot: join(h.stateHome, "backups") });
    const trailing = stagingPathFor({ ...h.deps, backupRoot: `${join(h.stateHome, "backups")}/` });

    expect(clean).toBe(join(h.stateHome, "staging", "T0"));
    expect(trailing).toBe(clean);
    expect(trailing).not.toContain(join("backups", "staging"));
  });

  test("--custom-source points at the STAGING dir, never at the estate module itself (BM-12)", async () => {
    const h = harness();
    await runBmadInstall(["--repos", "alpha", "--apply"], h.deps);
    const source = h.spy.exec[0]!.args[h.spy.exec[0]!.args.indexOf("--custom-source") + 1];
    expect(source).not.toBe(h.estate);
    expect(source).toContain(join("bmad-manager", "staging"));
  });

  test("--tools overrides the default toolset", async () => {
    const h = harness();
    await runBmadInstall(["--repos", "alpha", "--tools", "claude-code", "--apply"], h.deps);
    const args = h.spy.exec[0]!.args;
    expect(args[args.indexOf("--tools") + 1]).toBe("claude-code");
  });

  test("an EMPTY --tools value falls back to the default, it does not ship `--tools ''`", async () => {
    // `ctx.opts.tools ?? DEFAULT_TOOLS` is nullish-coalescing, so an EMPTY ARRAY would sail past the
    // fallback and hand the installer a blank toolset. 2.1's `splitList` returns `undefined` rather
    // than `[]` for a value with no real entries, which is what makes the `??` correct — this pins that
    // cross-module invariant here, where the consequence lives.
    for (const value of ["", " , "]) {
      const h = harness();
      await runBmadInstall(["--repos", "alpha", "--tools", value, "--apply"], h.deps);
      const args = h.spy.exec[0]!.args;
      expect(args[args.indexOf("--tools") + 1]).toBe("claude-code,antigravity-cli");
    }
  });

  test("--set is passed through, appended after the frozen tokens (2.2's documented contract)", async () => {
    const h = harness();
    await runBmadInstall(["--repos", "alpha", "--set", "bmm.a=1", "--set", "core.b=2", "--apply"], h.deps);
    const args = h.spy.exec[0]!.args;
    // A parsed, documented flag that reached no subprocess would be a silent drop.
    expect(args.slice(args.indexOf("--yes"))).toEqual([
      "--yes",
      "--set",
      "bmm.a=1",
      "--set",
      "core.b=2",
    ]);
  });

  test("bmad-manager copies NOTHING into either Surface tree — the installer does all of it", async () => {
    const h = harness({ forbidRepoWrites: true });
    seedSurfaces(h.repos.alpha);
    seedSurfaces(h.repos.beta);
    expect(await runBmadInstall(["--apply"], h.deps)).toBe(0);
    // Belt-and-suspenders on top of the exploding seam: no recorded destination is inside a repo.
    for (const { dest } of h.spy.cpDir) {
      expect(dest.startsWith(resolve(h.repos.alpha) + sep)).toBe(false);
      expect(dest.startsWith(resolve(h.repos.beta) + sep)).toBe(false);
    }
  });

  test("the leg reads ctx.repo.path and ctx.opts.tools, and closes over the staging dir", () => {
    const h = harness();
    const leg = installLeg("/staging/fixed");
    const plan = buildPlan(
      { path: "/srv/estate/gamma", tools: ["x"], claudeTracked: true, hasUpstream: true },
      leg,
      parseBmadOpts(["--tools", "a,b"]),
      h.deps,
    );
    expect(plan.installArgv).toContain("/srv/estate/gamma");
    expect(plan.installArgv[plan.installArgv.indexOf("--custom-source") + 1]).toBe("/staging/fixed");
    expect(plan.installArgv[plan.installArgv.indexOf("--tools") + 1]).toBe("a,b");
  });
});

// ── AC4 — default-estate --skills gating ──────────────────────────────────────────────────────────

describe("AC4 — the marketplace skills ARRAY is the install gate (BM-12)", () => {
  test("with no --skills the array is exactly the two loop-family defaults — no dev", async () => {
    const h = harness();
    await runBmadInstall(["--repos", "alpha", "--apply"], h.deps);
    expect(stagedSkillsArray(h.spy)).toEqual([`./skills/${JHON}`, `./skills/${EPIC}`]);
  });

  test("--skills dev-the-loop ADDS dev — three entries, defaults intact", async () => {
    const h = harness();
    await runBmadInstall(["--repos", "alpha", "--skills", "dev-the-loop", "--apply"], h.deps);
    const arr = stagedSkillsArray(h.spy);
    expect(arr).toEqual([`./skills/${JHON}`, `./skills/${EPIC}`, `./skills/${DEV}`]);
  });

  test("the full directory name works too, and mixing the two forms does not duplicate the entry", async () => {
    const h = harness();
    await runBmadInstall(
      ["--repos", "alpha", "--skills", `dev-the-loop,${DEV}`, "--apply"],
      h.deps,
    );
    // An uncontrolled resolution would emit `./skills/bmad-agent-dev-the-loop` twice.
    expect(stagedSkillsArray(h.spy)).toEqual([
      `./skills/${JHON}`,
      `./skills/${EPIC}`,
      `./skills/${DEV}`,
    ]);
  });

  test("the array is a REWRITE of the estate's descriptor, not a verbatim copy", async () => {
    // The estate ships an array that already lists all three. If materializeStaging copied the file
    // through, a DEFAULT run would ship dev — this is the assertion that catches that.
    const h = harness();
    await runBmadInstall(["--repos", "alpha", "--apply"], h.deps);
    const shipped = JSON.parse(
      readFileSync(join(h.estate, ".claude-plugin", "marketplace.json"), "utf-8"),
    ) as { plugins: { skills: string[] }[] };
    expect(shipped.plugins[0]!.skills.length).toBe(3);
    expect(stagedSkillsArray(h.spy).length).toBe(2);
  });

  test("every skill the array names is also present on disk in the staging tree", async () => {
    const h = harness();
    await runBmadInstall(["--repos", "alpha", "--skills", "dev-the-loop", "--apply"], h.deps);
    const staging = join(h.stateHome, "staging", "T0");
    for (const skill of [JHON, EPIC, DEV]) {
      expect(existsSync(join(staging, "skills", skill, "SKILL.md"))).toBe(true);
    }
    // …and the one that was NOT selected is absent from a default run's staging tree.
    const h2 = harness();
    await runBmadInstall(["--repos", "alpha", "--apply"], h2.deps);
    expect(existsSync(join(h2.stateHome, "staging", "T0", "skills", DEV))).toBe(false);
  });

  test("staging is materialized ONCE per run, not once per repo", async () => {
    const h = harness();
    await runBmadInstall(["--apply"], h.deps); // two repos
    expect(h.spy.exec.length).toBe(2);
    expect(h.spy.atomicWrite.filter((w) => w.path.endsWith("marketplace.json")).length).toBe(1);
  });

  test("a missing or malformed marketplace.json fails loud, with nothing staged", async () => {
    for (const marketplace of [null, "{ not json", { plugins: [] }]) {
      const h = harness({ marketplace });
      await expect(runBmadInstall(["--repos", "alpha", "--apply"], h.deps)).rejects.toThrow(BmadError);
      expect(h.spy.atomicWrite).toEqual([]);
      expect(h.spy.exec).toEqual([]);
    }
  });

  test("materializeStaging takes RESOLVED names — it does not re-resolve the operator's tokens", () => {
    const h = harness();
    const staging = join(h.stateHome, "staging", "manual");
    materializeStaging(h.deps, [DEV], staging);
    expect(stagedSkillsArray(h.spy)).toEqual([`./skills/${DEV}`]);
  });
});

// ── AC5 — idempotency digest ──────────────────────────────────────────────────────────────────────

describe("AC5 — skillTreeDigest is an EXACT, Surface-scoped, regen-excluding hash (FR-10/BM-10)", () => {
  const { deps } = harness();

  /** Two independently-built repos with identical Surface trees. */
  function twoIdenticalRepos(): [string, string] {
    const a = fresh("digest-a");
    const b = fresh("digest-b");
    for (const repo of [a, b]) {
      put(join(repo, CLAUDE_SKILLS, JHON, "SKILL.md"), "# jhon\nbody\n");
      put(join(repo, AGENTS_SKILLS, JHON, "SKILL.md"), "# jhon\nbody\n");
    }
    return [a, b];
  }

  test("(a) two identical trees digest EQUAL — a re-install over an unchanged estate is 0 changed", () => {
    const [a, b] = twoIdenticalRepos();
    expect(skillTreeDigest(a, deps)).toBe(skillTreeDigest(b, deps));
  });

  test("(b) a change under _bmad/_config or _bmad/scripts is REGEN, not drift", () => {
    const [a, b] = twoIdenticalRepos();
    const before = skillTreeDigest(a, deps);
    put(join(a, CLAUDE_SKILLS, JHON, "_bmad", "_config", "config.toml"), "regenerated=1\n");
    put(join(a, CLAUDE_SKILLS, JHON, "_bmad", "scripts", "gen.sh"), "echo regenerated\n");
    expect(skillTreeDigest(a, deps)).toBe(before);
    expect(skillTreeDigest(a, deps)).toBe(skillTreeDigest(b, deps));
  });

  test("(c) one changed byte in a skill file IS drift", () => {
    const [a] = twoIdenticalRepos();
    const before = skillTreeDigest(a, deps);
    put(join(a, CLAUDE_SKILLS, JHON, "SKILL.md"), "# jhon\nbodY\n");
    expect(skillTreeDigest(a, deps)).not.toBe(before);
  });

  test("(d) a WHITESPACE-ONLY change is drift — this is what core.contentHash would miss", () => {
    const [a] = twoIdenticalRepos();
    const before = skillTreeDigest(a, deps);
    put(join(a, CLAUDE_SKILLS, JHON, "SKILL.md"), "# jhon\nbody \n");
    expect(skillTreeDigest(a, deps)).not.toBe(before);
  });

  test("(e) drift past character 400 is still drift (contentHash slices at 400)", () => {
    const [a] = twoIdenticalRepos();
    const filler = "x".repeat(500);
    put(join(a, CLAUDE_SKILLS, JHON, "SKILL.md"), `${filler}A`);
    const before = skillTreeDigest(a, deps);
    put(join(a, CLAUDE_SKILLS, JHON, "SKILL.md"), `${filler}B`);
    expect(skillTreeDigest(a, deps)).not.toBe(before);
  });

  test("(f) a file's PATH is part of the digest — a rename with identical bytes is drift", () => {
    const [a] = twoIdenticalRepos();
    const before = skillTreeDigest(a, deps);
    rmSync(join(a, CLAUDE_SKILLS, JHON, "SKILL.md"));
    put(join(a, CLAUDE_SKILLS, JHON, "RENAMED.md"), "# jhon\nbody\n");
    expect(skillTreeDigest(a, deps)).not.toBe(before);
  });

  test("(g) it is SCOPED to the two Surface trees — a change elsewhere in the repo is invisible", () => {
    const [a] = twoIdenticalRepos();
    const before = skillTreeDigest(a, deps);
    put(join(a, "src", "main.ts"), "export const x = 1;\n");
    put(join(a, ".claude", "settings.json"), "{}\n");
    expect(skillTreeDigest(a, deps)).toBe(before);
  });

  test("(h) a repo with no Surface trees digests stably rather than throwing", () => {
    const empty1 = fresh("digest-empty-a");
    const empty2 = fresh("digest-empty-b");
    expect(skillTreeDigest(empty1, deps)).toBe(skillTreeDigest(empty2, deps));
  });

  test("isRegenDir matches only the two by-design paths", () => {
    expect(isRegenDir(join("/r", CLAUDE_SKILLS, JHON, "_bmad", "_config"))).toBe(true);
    expect(isRegenDir(join("/r", CLAUDE_SKILLS, JHON, "_bmad", "scripts"))).toBe(true);
    expect(isRegenDir(join("/r", CLAUDE_SKILLS, JHON, "_bmad"))).toBe(false);
    expect(isRegenDir(join("/r", CLAUDE_SKILLS, JHON, "config"))).toBe(false);
  });
});

// ── AC6 — single source of plan through the first real mutation ───────────────────────────────────

describe("AC6 — the plan survives the mutation path unchanged (FR-5/SM-3/BM-14)", () => {
  test("dry-run and --apply report the IDENTICAL plan over an unchanged estate (fixed clock)", async () => {
    // ONE harness, two runs against the SAME estate — the comparison must be able to see a divergence
    // introduced by the apply path, which two independently-built fixtures would hide behind their
    // different temp roots.
    const h = harness();
    await runBmadInstall(["--json"], h.deps);
    const dry = (h.spy.json[0] as { repos: RepoResult[] }).repos.map((r) => r.planned);
    await runBmadInstall(["--json", "--apply"], h.deps);
    const applied = (h.spy.json[1] as { repos: RepoResult[] }).repos.map((r) => r.planned);
    // Compared on `planned` ONLY — never on `backupPath`/`committed`, which are outcomes (BM-14).
    expect(JSON.stringify(applied)).toBe(JSON.stringify(dry));
  });

  test("a DRY RUN writes nothing and shells nothing, even though the guard ran", async () => {
    const h = harness();
    seedSurfaces(h.repos.alpha);
    expect(await runBmadInstall(["--json", "--push"], h.deps)).toBe(0);
    expect(h.spy.exec).toEqual([]);
    expect(h.spy.cpDir).toEqual([]);
    expect(h.spy.atomicWrite).toEqual([]);
    expect(h.spy.ensureDir).toEqual([]);
    // …and the render still reports the full intent, including the argv it did not run.
    expect(rowsOf(h.spy)[0]?.planned.installArgv).toContain("--custom-source");
  });

  test("the plan is built EXACTLY ONCE per repo, on the apply path too", async () => {
    const h = harness();
    await runBmadInstall(["--apply", "--json"], h.deps); // two repos
    // One clock per repo (backupPath) + one for the run's staging dir = 3 across a two-repo run. A
    // recomputed plan inside the apply branch shows up here immediately.
    expect(h.spy.clock).toBe(3);
  });

  test("THE C3 TRAP: the installer's --custom-source is the staging dir that was WRITTEN", async () => {
    // A MONOTONIC clock. If `stagingPathFor` were called twice (once to materialize, once inside
    // buildArgv), the two would differ by a tick and the installer would be pointed at a directory
    // that does not exist. Every fixed-clock test in this file passes either way — only this one fails.
    const h = harness({ fixedClock: false });
    await runBmadInstall(["--repos", "alpha", "--apply"], h.deps);

    const args = h.spy.exec[0]!.args;
    const customSource = args[args.indexOf("--custom-source") + 1]!;
    const written = h.spy.atomicWrite.find((w) => w.path.endsWith("marketplace.json"))!.path;
    expect(written.startsWith(customSource + sep)).toBe(true);
    expect(existsSync(join(customSource, ".claude-plugin", "marketplace.json"))).toBe(true);
  });

  test("stagingPathFor is a sibling of backupRoot under the same state home (BM-8)", () => {
    const h = harness();
    expect(stagingPathFor(h.deps)).toBe(join(h.stateHome, "staging", "T0"));
    expect(h.deps.backupRoot).toBe(join(h.stateHome, "backups"));
  });
});

// ── AC7 — fail loud per repo, batch continues ─────────────────────────────────────────────────────

describe("AC7 — installer failures are per-repo, verbatim, and never silent (FR-15/BM-4/BM-11)", () => {
  const ANCESTOR = "ANCESTOR CONFLICT: repo nested under another BMAD install";

  test("a non-zero exit fails THAT repo verbatim; the batch continues; exit is 1", async () => {
    const h = harness({ exec: { alpha: { code: 1, stderr: ANCESTOR }, "*": { code: 0 } } });
    expect(await runBmadInstall(["--apply", "--json"], h.deps)).toBe(1);

    const [alpha, beta] = rowsOf(h.spy);
    expect(alpha!.status).toBe("failed");
    expect(alpha!.reason).toContain(ANCESTOR); // VERBATIM — never paraphrased (BM-11)
    expect(beta!.status).toBe("ok"); // the loop continued (FR-15/BM-16)
    expect(h.spy.exec.length).toBe(2);
  });

  test("after a failed install the later filters do NOT run for that repo (fail-fast within a repo)", async () => {
    const h = harness({ exec: { "*": { code: 1, stderr: ANCESTOR } } });
    await runBmadInstall(["--repos", "alpha", "--apply", "--json"], h.deps);
    const row = rowsOf(h.spy)[0]!;
    expect(row.stagedPaths).toEqual([]);
    expect(row.committed).toBe(false);
    expect(row.pushed).toBe(false);
  });

  test("a missing bmad binary (127) FAILS with remediation — it is never a skip (BM-3)", async () => {
    const h = harness({ exec: { "*": { code: 127, stderr: "spawn bmad ENOENT" } } });
    expect(await runBmadInstall(["--repos", "alpha", "--apply", "--json"], h.deps)).toBe(1);

    const row = rowsOf(h.spy)[0]!;
    expect(row.status).toBe("failed");
    expect(row.reason).toContain("BMAD_BIN"); // the actionable remediation
    expect(row.reason).toContain("spawn bmad ENOENT"); // …and the raw launch error
    expect(row.status).not.toBe("skipped-gitignored");
  });

  test("a non-zero exit with EMPTY stderr still produces an actionable reason, never a bare prefix", async () => {
    const h = harness({ exec: { "*": { code: 3, stdout: "wrote nothing", stderr: "   " } } });
    await runBmadInstall(["--repos", "alpha", "--apply", "--json"], h.deps);
    const reason = rowsOf(h.spy)[0]!.reason!;
    expect(reason).toContain("exit 3");
    expect(reason).toContain("wrote nothing"); // falls back to stdout rather than reporting nothing
  });

  test("a non-zero exit with NO output at all says so explicitly", async () => {
    const h = harness({ exec: { "*": { code: 9 } } });
    await runBmadInstall(["--repos", "alpha", "--apply", "--json"], h.deps);
    expect(rowsOf(h.spy)[0]!.reason).toContain("(no output)");
  });

  test("a clean run over two repos exits 0 with both rows ok", async () => {
    const h = harness();
    expect(await runBmadInstall(["--apply", "--json"], h.deps)).toBe(0);
    expect(rowsOf(h.spy).map((r) => r.status)).toEqual(["ok", "ok"]);
  });
});

// ── AC8 — verify and git are DELEGATED ────────────────────────────────────────────────────────────

describe("AC8 — 2.3 delegates verify (2.6) and the git spine (2.4); it implements neither", () => {
  // REWRITTEN BY 2.4. The git spine is no longer delegated-away — it runs here now, and this suite's
  // job became proving that 2.3 still IMPLEMENTS none of it: every git call the run makes must come
  // from `git-safety.ts`'s vocabulary, and 2.3's own filters (backup, installer) must add nothing.
  test("the git spine runs through git-safety's argv only — 2.3 inlines no git of its own", async () => {
    const h = harness();
    seedSurfaces(h.repos.alpha);
    // No `--push` here: a push against a non-repo cannot advance an upstream, and `pushGate` correctly
    // fails the repo for it — which the next test owns. This one is the clean-run shape.
    expect(await runBmadInstall(["--repos", "alpha", "--apply", "--json"], h.deps)).toBe(0);

    // Every argv, in the order issued — the whole git surface of an install run.
    const subs = h.spy.git.map((a) => a[0]);
    expect(subs.length).toBeGreaterThan(0);
    for (const s of subs) {
      expect(["rev-parse", "rev-list", "add", "status", "diff"]).toContain(s);
    }
    expect(subs).not.toContain("push"); // no `--push` ⇒ no push, ever (BM-6)
    // THE NEVER-`-A` INVARIANT, asserted here too — this is the only suite that exercises the spine
    // through the full `runBmadInstall` entry point, so a `git add -A` introduced anywhere above the
    // pipeline would show up here and nowhere else.
    for (const a of h.spy.git.filter((a) => a[0] === "add")) {
      expect(a).not.toContain("-A");
      expect(a).not.toContain(".");
      expect(a).toContain("--");
    }

    const row = rowsOf(h.spy)[0]!;
    // Still the zero values — but now for the REAL reason: the fail-soft git returns `""` for every
    // call against these non-repo temp dirs, so nothing staged, nothing committed, nothing pushed.
    expect(row.stagedPaths).toEqual([]);
    expect(row.committed).toBe(false);
    expect(row.pushed).toBe(false);
    expect(row.planned.wouldPush).toBe(false);
  });

  // THE FAIL-SOFT PUSH IS THE POINT. `deps.git` here returns `""` for `push` exactly as `src/git` does
  // for a push that git rejected — and the run must NOT report success. That it exits 1 through 2.3's
  // own command entry point is the FR-15 contract working end-to-end, not just inside 2.4's unit tests.
  test("a --push that could not advance the upstream FAILS the repo (FR-15, through the command)", async () => {
    const h = harness();
    seedSurfaces(h.repos.alpha);
    expect(await runBmadInstall(["--repos", "alpha", "--apply", "--push", "--json"], h.deps)).toBe(1);

    const row = rowsOf(h.spy)[0]!;
    expect(row.status).toBe("failed");
    expect(row.pushed).toBe(false);
    expect(row.reason).toContain("push failed");
    expect(row.planned.wouldPush).toBe(true); // the INTENT is still reported (BM-14)
  });
});

// ── AC9 — render + identity ───────────────────────────────────────────────────────────────────────

describe("AC9 — render composes the 2.2 path, and nothing bakes an identity", () => {
  test("human mode reports the backup OUTCOME distinctly from the backup INTENT", async () => {
    const h = harness();
    seedSurfaces(h.repos.alpha);
    await runBmadInstall(["--repos", "alpha", "--apply"], h.deps);
    const md = h.spy.print.join("");
    expect(md).toContain("APPLY");
    expect(md).toContain("would back up to:"); // intent
    expect(md).toContain("backed up to:"); // outcome — only present because one was written
    expect(h.spy.json).toEqual([]);
  });

  test("--json is the only thing on stdout, and carries the outcome fields", async () => {
    const h = harness();
    seedSurfaces(h.repos.alpha);
    await runBmadInstall(["--repos", "alpha", "--apply", "--json"], h.deps);
    expect(h.spy.print).toEqual([]);
    expect(rowsOf(h.spy)[0]?.backupPath).toBeDefined();
  });

  test("no shipped module in the slice bakes an absolute machine path (D4/NFR3)", () => {
    // A cheap standing companion to `check:no-consumer-ids`, which does not look for home-dir roots.
    // Asserted as a boolean so a hit reports the file name rather than dumping the whole module.
    for (const file of ["install.ts", "estate-source.ts", "pipeline.ts", "deps.ts", "batch.ts"]) {
      const src = readFileSync(join(import.meta.dir, file), "utf-8");
      for (const root of ["/Users/", "/home/"]) {
        expect(`${file}: ${src.includes(root)}`).toBe(`${file}: false`);
      }
    }
  });
});
