// notekit-deploy tests (Story 1.4 AC #3). Every fail-loud guard as its own case, plus a real end-to-end
// build into a temp dir shaped like a vault. The e2e cases run the ACTUAL `Bun.build` over
// `src/notekit/edge/index.ts` — a mocked build would assert nothing about the artifact's real shape.
//
// A green run here is NOT evidence that Obsidian's host can load the artifact. That assumption is tested
// live, in the vault (SM-1, AC #4). Fixtures test your assertions; contact tests your assumptions.
//
// ⚠️-2 IS TESTED AS BEHAVIOUR, NOT PROSE. notekit declares no `preflight`, so a BARE `.obsidian` dir is a
// complete vault for this command — which is why these fixtures are two `mkdirSync` calls rather than
// dashkit's contract-satisfying `makeVaultFixture`. If someone later adds a plugin envelope to
// `NOTEKIT_SPEC` (the Epic-3 scope leak the story forbids), every case below goes red at once.
//
// ⚠️-1 IS TESTED AS REACHABILITY. The deploy entrypoint is the EDGE barrel, so the bundle must contain the
// DOM renderer; the package barrel would produce a bundle with no renderer in it and every "it deployed"
// assertion would still pass. `entrypoint()` is pinned, the built bytes are checked for `renderCardDom`,
// and the import graph is walked to prove the bundle can only contain `src/notekit` + `src/core` (AD-5
// rule 2).

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { specifiers, stripStringsAndComments } from "../../scripts/lib/specifiers";
import { BANNER as CN_BANNER } from "./cn-deploy";
import { BANNER as DASHKIT_BANNER } from "./dashkit-deploy";
import {
  BANNER,
  BANNER_PREFIX,
  NOTEKIT_SPEC,
  NotekitDeployError,
  WATCH_DEBOUNCE_MS,
  artifactPath,
  buildBundle,
  deployOnce,
  entrypoint,
  isBundleRelevant,
  resolveTarget,
  runNotekitDeploy,
  watchDirs,
} from "./notekit-deploy";

// Measured 2026-08-05 on this branch: the notekit edge bundle is 22,439 bytes (1 output, ESM). The size
// assertion is TWO-SIDED: the FLOOR catches a bundle that collapsed to near-empty (the exact failure a
// package-barrel entrypoint would produce — ⚠️-1); the CEILING catches dependency inlining (a used `yaml`
// import once took a vault bundle 1.6 KB → 190 KB with every gate green).
const MEASURED_BYTES = 22_439;
const SIZE_FLOOR = 10_000;
const SIZE_CEILING = 40_000;
// The DRIFT tolerance, which is a different claim from the band and must be MUCH tighter or it says
// nothing: the widest distance from `MEASURED_BYTES` that still sits inside the band is 12,439, so the
// first cut's `SIZE_CEILING - SIZE_FLOOR` (30,000) was passed by every value the band already passed —
// an assertion with no reachable failure, which reads as coverage and is worse than no line at all.
// 2,000 is floored by a MEASURED effect, not a guess: `Bun.build` embeds source-path comments relative
// to the process cwd, so the same artifact is 22,439 units built from the repo root and 22,931 from
// `/tmp` (re-measured 2026-08-05). The tolerance is ~4x that 492-unit spread, so running the suite from
// another directory cannot flake it, while a real 9% drift in the slice goes red.
const SIZE_DRIFT_TOLERANCE = 2_000;

// ---------------------------------------------------------------------------------------------
// ⚠ VERIFIED BUN GOTCHA — the FIRST `Bun.build` in a `bun test` process can fail to resolve a
// `..`-crossing specifier out of `src/notekit/edge/`, and the SECOND identical call succeeds.
//
// Measured on bun 1.3.14 (0d9b296a), 2026-08-05, isolated to three lines:
//     attempt 0 FAIL 5   ("Could not resolve: ../core-fence", ../core-renderspec, …)
//     attempt 1 OK 1
//     attempt 2 OK 1
// It is a COLD-CACHE effect in the bundler's resolver, not a defect in the slice: the same build from
// `bun -e` and from the real `std` bin succeeds on the first try, from any cwd (asserted below by
// running the actual CLI in a fresh subprocess). It also depends on where the CALLING test file lives —
// the same build driven from a test in `src/notekit/` succeeds cold, from `src/cli/` it does not — which
// is why cn and dashkit, whose entrypoints sit one directory shallower, never surfaced it.
//
// So: one throwaway build warms the resolver, and the production claim is proven separately and colder.
// Delete this and the suite fails on whichever build happens to run first — a flake that would look like
// a broken bundle rather than a runner artefact.
// ---------------------------------------------------------------------------------------------
beforeAll(async () => {
  try {
    await buildBundle();
  } catch {
    /* the documented cold-cache miss — the next build is the real one */
  }
});

let tmp: string;
/** A temp dir shaped like an Obsidian vault. notekit needs only `.obsidian/` — there is no preflight. */
let vault: string;

/** The whole notekit vault contract: a directory with a `.obsidian/` inside it. */
function bareVault(dir: string): string {
  mkdirSync(join(dir, ".obsidian"), { recursive: true });
  return dir;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "std-notekit-"));
  vault = bareVault(join(tmp, "vault"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Collect the CLI's stdout instead of printing it. */
function sink() {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
}

/** Park `body` at the deploy target, creating `Scripts/` if needed. */
function plant(body: string): string {
  const target = artifactPath(vault);
  mkdirSync(join(vault, "Scripts"), { recursive: true });
  writeFileSync(target, body);
  return target;
}

describe("pure helpers", () => {
  test("artifactPath lands at <vault>/Scripts/notekit.js", () => {
    expect(artifactPath("/some/vault")).toBe(join("/some/vault", "Scripts", "notekit.js"));
  });

  // ⚠️-1. The single most consequential line in this file: the entrypoint is `edge/index.ts`, NOT
  // `index.ts`. Both files exist, both import cleanly, and a deploy pointed at the wrong one succeeds —
  // it just ships a bundle with no renderer. So the path is pinned AND the file's contents are read back.
  test("entrypoint resolves src/notekit/EDGE/index.ts relative to this file, not an absolute literal", () => {
    const ep = entrypoint();
    expect(ep.endsWith(join("src", "notekit", "edge", "index.ts"))).toBe(true);
    expect(ep.endsWith(join("src", "notekit", "index.ts"))).toBe(false);
    // Derived from `import.meta.dir`, so it tracks THIS file wherever the repo is checked out. The
    // absolute-path check is against a BAKED literal, not against absoluteness itself: the path this
    // returns is of course absolute — what must not appear is a hardcoded home directory in the source.
    expect(readFileSync(join(import.meta.dir, "notekit-deploy.ts"), "utf-8")).not.toContain("/Users/");
    expect(ep).toBe(join(import.meta.dir, "..", "notekit", "edge", "index.ts"));
    const src = readFileSync(ep, "utf-8");
    expect(src).toContain('export { postProcess } from "./post-processor"');
    expect(src).toContain("renderCardDom");
  });

  test("watchDirs are src/notekit + src/core, both relative and both real", () => {
    const dirs = watchDirs();
    expect(dirs.length).toBe(2);
    expect(dirs.some((d) => d.endsWith(join("src", "notekit")))).toBe(true);
    expect(dirs.some((d) => d.endsWith(join("src", "core")))).toBe(true);
    for (const d of dirs) expect(existsSync(d)).toBe(true);
  });

  test("the vault is NEVER watched — every watched dir is inside THIS repo's src/", () => {
    // Watching a vault root is the self-triggering case (atomicWrite renames inside the target dir →
    // infinite rebuild). Anchor on containment, and never a Scripts/ path.
    const src = join(import.meta.dir, "..");
    for (const d of watchDirs()) {
      expect(d.startsWith(src + "/")).toBe(true);
      expect(d).not.toContain("Scripts");
    }
  });

  test("the banner starts with the notekit-specific prefix the clobber guard keys on", () => {
    expect(BANNER.startsWith(BANNER_PREFIX)).toBe(true);
    expect(BANNER_PREFIX).toContain("std notekit deploy");
    expect(BANNER).toContain("do not edit");
    expect(BANNER).toContain("src/notekit");
    expect(NOTEKIT_SPEC.bannerPrefix).toBe(BANNER_PREFIX);
    expect(NOTEKIT_SPEC.banner).toBe(BANNER);
  });

  test("the spec omits `formats` AND `preflight` — both deliberate (⚠️-2, esm-only)", () => {
    expect(NOTEKIT_SPEC.formats).toBeUndefined();
    expect(NOTEKIT_SPEC.preflight).toBeUndefined();
    expect(NOTEKIT_SPEC.name).toBe("notekit");
    expect(NOTEKIT_SPEC.artifact).toBe("notekit.js");
  });
});

describe("resolveTarget — the fail-loud guards", () => {
  test("missing --vault throws", () => {
    expect(() => resolveTarget(undefined)).toThrow(NotekitDeployError);
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

  test("a clean vault with no target yet resolves to the artifact path", () => {
    expect(resolveTarget(vault)).toBe(artifactPath(vault));
  });

  test("an existing target WITH notekit's banner is fine — that is our own prior artifact", () => {
    const target = plant(`${BANNER}\nexport const x = 1;\n`);
    expect(resolveTarget(vault)).toBe(target);
  });
});

// ---------------------------------------------------------------------------------------------
// THE CLOBBER GUARD, OVER ITS REAL DOMAIN.
//
// "It has a banner" is not the claim. The claim is that a file which is not THIS edge's artifact is
// refused — so each near-miss gets its own case: a sibling edge's real artifact (both of them), an empty
// file, a whitespace-only file, a banner truncated one character short, a banner that is present but not
// at offset 0, and the same prefix belonging to a DIFFERENT command. The guard is `startsWith`, and every
// one of these is a way to be almost-but-not a notekit artifact.
// ---------------------------------------------------------------------------------------------
describe("the clobber guard refuses everything that is not a notekit artifact", () => {
  const REFUSED = /refusing to clobber a hand-authored file/;

  test("the premise: no sibling edge's banner is a prefix of notekit's, in either direction", () => {
    expect(DASHKIT_BANNER.startsWith(BANNER_PREFIX)).toBe(false);
    expect(CN_BANNER.startsWith(BANNER_PREFIX)).toBe(false);
    expect(BANNER.startsWith("// GENERATED by `std dashkit deploy`")).toBe(false);
    expect(BANNER.startsWith("// GENERATED by `std cn deploy`")).toBe(false);
  });

  test("a DASHKIT artifact is refused (the sibling edge in the SAME vault — AD-8)", () => {
    plant(`${DASHKIT_BANNER}\nexport function statGrid() {}\n`);
    expect(() => resolveTarget(vault)).toThrow(REFUSED);
  });

  test("a CN artifact is refused (the other vault's edge, if one were ever copied in)", () => {
    plant(`${CN_BANNER}\nexport const cn = 1;\n`);
    expect(() => resolveTarget(vault)).toThrow(REFUSED);
  });

  test("an EMPTY file is refused — the empty string starts with no prefix, and is not `absent`", () => {
    // The dangerous reading is `readIfExists(target) ?? ""` collapsing an empty file into "no file".
    plant("");
    expect(() => resolveTarget(vault)).toThrow(REFUSED);
  });

  test("a whitespace-only file is refused", () => {
    plant("\n\n   \n");
    expect(() => resolveTarget(vault)).toThrow(REFUSED);
  });

  test("a TRUNCATED banner is refused — one character short is not this edge's artifact", () => {
    plant(`${BANNER_PREFIX.slice(0, -1)}\nexport const x = 1;\n`);
    expect(() => resolveTarget(vault)).toThrow(REFUSED);
  });

  test("a banner that is present but NOT on line 1 is refused (startsWith, not includes)", () => {
    plant(`// someone's own header\n${BANNER}\nexport const x = 1;\n`);
    expect(() => resolveTarget(vault)).toThrow(REFUSED);
  });

  test("a leading blank line before the banner is refused", () => {
    plant(`\n${BANNER}\n`);
    expect(() => resolveTarget(vault)).toThrow(REFUSED);
  });

  test("plain hand-authored work is refused", () => {
    plant("// hand-written by a human\nexport const x = 1;\n");
    expect(() => resolveTarget(vault)).toThrow(REFUSED);
  });

  // THE OTHER DIRECTION, which a per-edge guard is only half-proven without: notekit's artifact must
  // fail DASHKIT's guard too. A shared prefix would pass both files both ways and nothing else here
  // would notice.
  test("a NOTEKIT artifact does NOT satisfy dashkit's guard (cross-edge, both ways)", async () => {
    const { resolveTarget: dashkitResolve, artifactPath: dashkitPath } = await import(
      "./dashkit-deploy"
    );
    mkdirSync(join(vault, "Scripts"), { recursive: true });
    writeFileSync(dashkitPath(vault), `${BANNER}\nexport const x = 1;\n`);
    expect(() => dashkitResolve(vault)).toThrow(/refusing to clobber a hand-authored file/);
  });

  test("a refused target is left BYTE-IDENTICAL — the guard refuses, it does not repair", async () => {
    const original = `${DASHKIT_BANNER}\nexport function statGrid() {}\n`;
    const target = plant(original);
    expect(await runNotekitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(1);
    expect(readFileSync(target, "utf-8")).toBe(original);
  });
});

describe("buildBundle — the artifact contract", () => {
  test("produces one bundle whose FIRST line is the banner", async () => {
    const code = await buildBundle();
    expect(code.split("\n")[0]).toBe(BANNER);
  });

  // ⚠️-1 in the BYTES. `renderCardDom` lives only in `edge/nkcard.ts`; if the entrypoint were the
  // package barrel the build would still succeed and this is the assertion that would fail.
  test("carries the DOM renderer AND the pure core rode inside", async () => {
    const code = await buildBundle();
    for (const name of ["renderCardDom", "nkTreeToDom", "postProcess", "dispatch"]) {
      expect(code).toContain(name);
    }
    expect(code).toContain("nk-card"); // the renderer table's one entry
    // The pure half is bundled too — the vault has no other copy of this vocabulary.
    for (const name of ["parseFenceBody", "noteToRenderSpec", "resolveTemplate", "cardTree"]) {
      expect(code).toContain(name);
    }
    // …and `core` rode in with it (`classify` comes from src/core, not from src/notekit).
    expect(code).toContain("classify");
  });

  test("the artifact size is inside the measured band — floor catches collapse, ceiling catches inlining", async () => {
    const bytes = (await buildBundle()).length;
    expect(bytes).toBeGreaterThan(SIZE_FLOOR);
    expect(bytes).toBeLessThan(SIZE_CEILING);
    expect(Math.abs(bytes - MEASURED_BYTES)).toBeLessThan(SIZE_DRIFT_TOLERANCE);
    // The tolerance is inside the band, not around it — stated so a future widening of either bound
    // cannot silently re-create the assertion that could not fail.
    expect(SIZE_DRIFT_TOLERANCE).toBeLessThan(
      Math.max(SIZE_CEILING - MEASURED_BYTES, MEASURED_BYTES - SIZE_FLOOR),
    );
  });

  test("is deterministic — two builds of unchanged source are byte-identical", async () => {
    expect(await buildBundle()).toBe(await buildBundle());
  });

  test("the built artifact names no host plugin module", async () => {
    const code = await buildBundle();
    for (const host of ["obsidian", "dataview", "js-engine"]) {
      expect(code.toLowerCase()).not.toContain(`"${host}"`);
      expect(code.toLowerCase()).not.toContain(`'${host}'`);
    }
  });

  test("a broken source surfaces the COMPILER's diagnostic, not `AggregateError: Bundle failed`", async () => {
    const bad = join(tmp, "bad.ts");
    writeFileSync(bad, "export const x = ;\n");
    let msg = "";
    try {
      await buildBundle(bad);
    } catch (e) {
      msg = e instanceof NotekitDeployError ? e.message : `WRONG TYPE: ${e}`;
    }
    expect(msg).toContain("bundle failed");
    expect(msg).toContain("bad.ts");
    expect(msg).not.toBe("bundle failed:\nBundle failed");
  });
});

// ---------------------------------------------------------------------------------------------
// AD-5 RULE 2 — "the bundle MAY contain src/notekit + src/core", asserted on the REAL import graph.
//
// The estate's precedent (dashkit) scans each source file's text under a policy. That does not fit a
// MIXED slice: notekit's intra-slice specifiers are `./core-fence` and `../core-registry`, neither of
// which is the `../core` root a text policy keys on, so a text scan would flag notekit's own files. The
// stronger check is available anyway — resolve every specifier against its own file and assert where it
// LANDS. Grepping the built output is a tautology a bundler defeats; this reads the graph.
//
// ⚠ THE MASKER IS PART OF THE CLAIM, AND THE FIRST CUT OF IT WAS ERASIVE. It deleted every LINE
// containing `//`, so `import { x } from "./y"; // note` dropped a real edge — and a walker that sees
// FEWER files reports a SMALLER graph, which makes every assertion below pass more easily without ever
// going red. Same hole for a `//` inside a string on an import line, and for `import "./x"`, which was
// filed as an external dep instead of being followed. None of that was reachable on today's sources
// (measured: old and new walkers return the identical 25 files), which is exactly why it had to be
// fixed — a latent hole in a load-bearing test is invisible until the day it matters.
//
// So the scan now uses the estate's shared, already-unit-tested machinery from
// `scripts/lib/specifiers.ts`: `stripStringsAndComments` blanks comment/string/regex INTERIORS to
// spaces and keeps every other byte, and `specifiers()` covers all five edge forms (import-from,
// export-from, side-effect, require, dynamic) through ONE resolver. The regression that proves the fix
// is not vacuous is the last `describe` in this section.
// ---------------------------------------------------------------------------------------------

/** Resolve one relative specifier to a real `.ts` on disk, or null when it leaves the repo. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && candidate.endsWith(".ts")) return candidate;
  }
  return null;
}

/** Every module edge in one file, read through the shared string/comment/regex-aware masker. */
function edgesOf(file: string): string[] {
  return specifiers(stripStringsAndComments(readFileSync(file, "utf-8"))).map((s) => s.spec);
}

function walk(entry: string, from: string): { files: string[]; bare: string[] } {
  const seen = new Set<string>();
  const bare: string[] = [];
  const queue = [resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of edgesOf(file)) {
      // ONE resolver for every edge form — a relative side-effect import is an internal edge to be
      // FOLLOWED, not an external dependency to be reported.
      const next = resolveSpecifier(file, spec);
      if (next !== null) queue.push(next);
      else bare.push(`${relative(from, file)} → ${spec}`);
    }
  }
  return { files: [...seen], bare };
}

describe("the bundle's import graph can only reach src/notekit + src/core (AD-5 rule 2)", () => {
  const SRC = join(import.meta.dir, "..");
  const graph = walk(entrypoint(), SRC);

  test("the walk is not vacuous — it reached the renderer and the pure half", () => {
    const names = graph.files.map((f) => relative(SRC, f));
    expect(names).toContain(join("notekit", "edge", "index.ts"));
    expect(names).toContain(join("notekit", "edge", "nkcard.ts"));
    expect(names).toContain(join("notekit", "core-renderspec.ts"));
    expect(names).toContain(join("core", "index.ts"));
    expect(graph.files.length).toBeGreaterThan(6);
  });

  test("every reachable file is under src/notekit/ or src/core/ — no cn, no dashkit, no cli", () => {
    for (const f of graph.files) {
      const rel = relative(SRC, f);
      expect({ rel, ok: rel.startsWith("notekit/") || rel.startsWith("core/") }).toEqual({
        rel,
        ok: true,
      });
    }
    // AD-8 named explicitly, because "no cn/dashkit" is the rule a future refactor is most likely to
    // break by reaching sideways for a shared helper instead of promoting it down to core.
    for (const f of graph.files) {
      expect(f).not.toContain(join("src", "cn"));
      expect(f).not.toContain(join("src", "dashkit"));
    }
  });

  test("no reachable file imports anything external — zero runtime deps in the artifact", () => {
    expect(graph.bare).toEqual([]);
  });

  test("no reachable file requires or dynamically imports a non-node specifier", () => {
    // Deliberately NOT `specifiers()`: that reads only LITERAL specifiers, and the claim here also
    // covers a COMPUTED one — `import(someVar)` — which has no literal to capture. The optional group
    // is what makes an unquoted argument visible as `spec === undefined`.
    for (const f of graph.files) {
      const src = stripStringsAndComments(readFileSync(f, "utf-8"));
      for (const m of src.matchAll(/\b(?:require|import)\s*\(\s*(?:(["'])([^"']*)\1)?/g)) {
        const spec = m[2];
        expect({ file: relative(SRC, f), spec, ok: spec !== undefined }).toEqual({
          file: relative(SRC, f),
          spec,
          ok: true,
        });
        expect(spec!.startsWith("node:") || spec!.startsWith(".")).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// THE WALKER'S OWN REGRESSION — a fix to a weak test is itself a claim, so it carries evidence.
//
// The three assertions above are only as strong as the scan that feeds them, and the failure mode of a
// broken scan is SILENCE: fewer files found, every assertion still green. So the constructs the first
// cut could not see are PLANTED here in a throwaway module tree, and the legacy walker is kept — as the
// thing being disproved — so each case is a measured old-misses/new-catches pair rather than a promise.
//
// Delete the legacy half and this file loses the only proof that the fix changed anything.
// ---------------------------------------------------------------------------------------------
describe("the graph walker is non-erasive (regression: the masker that ate real edges)", () => {
  /** The masker exactly as it shipped in the first cut: whole-LINE erasure on any `//`. */
  const LEGACY_MASK = (s: string): string =>
    s.replace(/^[^\n]*?\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  /** The first cut's scan: from-clauses only, line-anchored, side-effect imports filed as external. */
  function legacyWalk(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [resolve(entry)];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = LEGACY_MASK(readFileSync(file, "utf-8"));
      for (const m of src.matchAll(/^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)) {
        const next = resolveSpecifier(file, m[1]!);
        if (next !== null) queue.push(next);
      }
    }
    return [...seen];
  }

  /**
   * A four-leaf module tree whose entry reaches every leaf through a DIFFERENT construct — one
   * construct per leaf, so a failure names which one regressed.
   */
  function plantGraph(): { entry: string; leaf: (n: string) => string } {
    const dir = join(tmp, "graph");
    mkdirSync(dir, { recursive: true });
    for (const n of ["a", "b", "c", "d"]) {
      writeFileSync(join(dir, `${n}.ts`), `export const ${n} = "${n}";\n`);
    }
    writeFileSync(
      join(dir, "entry.ts"),
      [
        `import { a } from "./a"; // a trailing comment — the legacy masker ate this whole line`,
        `export {`,
        `  b,`,
        `} from "./b"; // a multi-line head AND a trailing comment on the \`from\` line`,
        `import "./c";`,
        `import { d } from "./d"; const NOT_A_COMMENT = "//d";`,
        `export const all = [a, d, NOT_A_COMMENT];`,
        ``,
      ].join("\n"),
    );
    return { entry: join(dir, "entry.ts"), leaf: (n: string) => join(dir, `${n}.ts`) };
  }

  test("the premise: each planted construct is a REAL edge the fixed walker follows", () => {
    const { entry, leaf } = plantGraph();
    const found = walk(entry, tmp).files;
    for (const n of ["a", "b", "c", "d"]) expect(found).toContain(leaf(n));
    expect(found.length).toBe(5); // entry + four leaves, nothing invented
    expect(walk(entry, tmp).bare).toEqual([]); // …and no real edge was misfiled as external
  });

  test("…and the LEGACY walker missed every one of them — the fix is not cosmetic", () => {
    const { entry, leaf } = plantGraph();
    const legacy = legacyWalk(entry);
    expect(legacy).toEqual([resolve(entry)]); // it walked NOTHING but the entry itself
    for (const n of ["a", "b", "c", "d"]) expect(legacy).not.toContain(leaf(n));
  });

  test("a trailing `//` comment on an import line no longer deletes the edge", () => {
    const dir = join(tmp, "trailing");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "e.ts"), 'import { x } from "./x"; // AD-8: never sideways\nexport { x };\n');
    expect(walk(join(dir, "e.ts"), tmp).files).toContain(join(dir, "x.ts"));
    expect(legacyWalk(join(dir, "e.ts"))).not.toContain(join(dir, "x.ts"));
  });

  test("a relative side-effect import is FOLLOWED, not filed as an external dependency", () => {
    // This is the shape that would defeat the barrel's DOM-freedom proof: `import "./edge/index"` is a
    // real module edge with no binding, and the first cut pushed it to `bare` instead of walking it.
    const dir = join(tmp, "sideeffect");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s.ts"), "console.log(1);\n");
    writeFileSync(join(dir, "e.ts"), 'import "./s";\nexport const e = 1;\n');
    const g = walk(join(dir, "e.ts"), tmp);
    expect(g.files).toContain(join(dir, "s.ts"));
    expect(g.bare).toEqual([]);
  });

  test("a genuinely external specifier is still reported — the masker did not make the scan blind", () => {
    // The other direction: over-masking would empty `bare` and turn the zero-external-deps assertion
    // into a tautology. Plant a real bare import and require it to surface.
    const dir = join(tmp, "external");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "e.ts"), 'import { parse } from "yaml";\nexport const e = parse;\n');
    expect(walk(join(dir, "e.ts"), tmp).bare).toEqual([join("external", "e.ts") + " → yaml"]);
  });

  test("a `from` clause inside a STRING is not read as an edge (no phantom files)", () => {
    const dir = join(tmp, "phantom");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "real.ts"), "export const real = 1;\n");
    writeFileSync(
      join(dir, "e.ts"),
      'import { real } from "./real";\nexport const q = `select x from "./ghost"`;\n',
    );
    const g = walk(join(dir, "e.ts"), tmp);
    expect(g.files).toContain(join(dir, "real.ts"));
    expect(g.bare).toEqual([]); // `./ghost` does not exist — had it been read, it would show up here
  });
});

describe("runNotekitDeploy — end to end", () => {
  test("deploys into a bare temp vault: exit 0, artifact on disk, banner first, renderer present", async () => {
    const out = sink();
    const code = await runNotekitDeploy(["deploy", "--vault", vault], { log: out.log });

    expect(code).toBe(0);
    const written = readFileSync(artifactPath(vault), "utf-8");
    expect(written.split("\n")[0]).toBe(BANNER);
    expect(written).toContain("renderCardDom");
    expect(written).toContain("postProcess");
    expect(out.lines.join("\n")).toContain("Scripts/notekit.js");
    expect(out.lines.join("\n")).toContain("✓ notekit");
  });

  // ⚠️-2 as behaviour: a vault with NOTHING but `.obsidian/` deploys. If a preflight were added, this
  // is the case that would start failing — which is what makes the omission enforced rather than noted.
  test("a bare `.obsidian/` vault is enough — there is NO plugin preflight in v1", async () => {
    const bare = bareVault(join(tmp, "bare"));
    expect(readdirSync(bare)).toEqual([".obsidian"]);
    expect(await runNotekitDeploy(["deploy", "--vault", bare], { log: () => {} })).toBe(0);
    expect(existsSync(artifactPath(bare))).toBe(true);
  });

  test("writes EXACTLY the one artifact — nothing else in Scripts/, nothing repo-side", async () => {
    expect(await runNotekitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    expect(readdirSync(join(vault, "Scripts"))).toEqual(["notekit.js"]);
  });

  test("creates Scripts/ when the vault does not have one yet", async () => {
    expect(existsSync(join(vault, "Scripts"))).toBe(false);
    expect(await runNotekitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    expect(readFileSync(artifactPath(vault), "utf-8").length).toBeGreaterThan(SIZE_FLOOR);
  });

  test("supports --vault=<dir> (the equals form core/args handles)", async () => {
    expect(await runNotekitDeploy(["deploy", `--vault=${vault}`], { log: () => {} })).toBe(0);
    expect(readFileSync(artifactPath(vault), "utf-8").split("\n")[0]).toBe(BANNER);
  });

  test("exit 2 on a missing --vault, and nothing is written", async () => {
    expect(await runNotekitDeploy(["deploy"], { log: () => {} })).toBe(2);
    expect(existsSync(artifactPath(vault))).toBe(false);
  });

  test("exit 2 on an unknown/absent subcommand — including `verify`, which v1 does not have", async () => {
    expect(await runNotekitDeploy([], { log: () => {} })).toBe(2);
    expect(await runNotekitDeploy(["verify"], { log: () => {} })).toBe(2);
    expect(await runNotekitDeploy(["render"], { log: () => {} })).toBe(2);
    expect(existsSync(artifactPath(vault))).toBe(false);
  });

  test("esm-only: a stray `--format cjs` neither errors nor changes the format", async () => {
    expect(
      await runNotekitDeploy(["deploy", "--vault", vault, "--format", "cjs"], { log: () => {} }),
    ).toBe(0);
    const written = readFileSync(artifactPath(vault), "utf-8");
    expect(written.split("\n")[0]).toBe(BANNER);
    expect(written).toContain("export {"); // esm output, not a cjs `module.exports`
  });

  test("exit 1 when the vault does not exist — a real failure, not a usage error", async () => {
    expect(await runNotekitDeploy(["deploy", "--vault", join(tmp, "nope")], { log: () => {} })).toBe(
      1,
    );
  });

  test("TOCTOU: a hand-authored file appearing DURING the build is not clobbered", async () => {
    const target = artifactPath(vault);
    const original = "// hand-written mid-build\nexport const x = 1;\n";

    const racer = runNotekitDeploy(["deploy", "--vault", vault], { log: () => {} });
    mkdirSync(join(vault, "Scripts"), { recursive: true });
    writeFileSync(target, original);

    expect(await racer).toBe(1);
    expect(readFileSync(target, "utf-8")).toBe(original); // survived
  });

  test("a real fs fault returns 1 in the house format — no unhandled rejection", async () => {
    mkdirSync(artifactPath(vault), { recursive: true }); // a DIRECTORY where the artifact should be
    expect(await runNotekitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// IDEMPOTENCE, AS A CLAIM ABOUT BYTES AND ABOUT WHAT IS REPORTED.
//
// "Run it twice and it does not crash" is not idempotence. Three things are asserted separately: the
// bytes on disk are identical, the file was NOT rewritten (mtime unmoved), and the run REPORTS the skip
// — `deployOnce().written === false` on the API, and the resident loop's `· unchanged` line on the CLI.
// And the whole thing is proven non-vacuous by showing the same assertions FAIL when the bytes differ.
// ---------------------------------------------------------------------------------------------
describe("idempotence — skip-if-identical, on the real bytes", () => {
  test("a second deploy is byte-identical, does not touch the file, and reports `written: false`", async () => {
    const target = artifactPath(vault);
    expect(await runNotekitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    const firstRaw = readFileSync(target);
    const firstText = readFileSync(target, "utf-8");
    const firstMtime = statSync(target).mtimeMs;

    await new Promise((r) => setTimeout(r, 20)); // any rewrite in this window WOULD move mtime
    const second = await deployOnce(vault);

    // ⚠ `DeployResult.bytes` is `code.length` — UTF-16 UNITS, not bytes. The banner carries an em dash,
    // so the artifact is 16 bytes longer on disk than it is long as a string. Comparing the reported
    // number against `Buffer.length` fails by exactly that much, and the misreading would have been
    // recorded as "the second deploy produced a different artifact". Compare like with like.
    expect(second).toEqual({ ok: true, bytes: firstText.length, written: false }); // the REPORT
    expect(Buffer.byteLength(firstText)).toBeGreaterThan(firstText.length); // the premise, stated
    expect(readFileSync(target).equals(firstRaw)).toBe(true); // the BYTES, compared as bytes
    expect(statSync(target).mtimeMs).toBe(firstMtime); // the FILE was not rewritten
  });

  test("…and none of that is vacuous: when the bytes differ, it writes and says so", async () => {
    const target = artifactPath(vault);
    expect(await runNotekitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    const good = readFileSync(target, "utf-8");

    // notekit-bannered, so the clobber guard permits the overwrite — this is our own prior artifact.
    writeFileSync(target, `${BANNER}\n// stale\n`);
    const stale = statSync(target).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));

    const third = await deployOnce(vault);
    expect(third).toEqual({ ok: true, bytes: good.length, written: true });
    expect(statSync(target).mtimeMs).not.toBe(stale);
    expect(readFileSync(target, "utf-8")).toBe(good);
  });

  test("a third and fourth run stay identical too — idempotence is not a one-shot property", async () => {
    const target = artifactPath(vault);
    expect(await runNotekitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    const bytes = readFileSync(target);
    for (let i = 0; i < 3; i++) {
      expect(await runNotekitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
      expect(readFileSync(target).equals(bytes)).toBe(true);
    }
  });

  test("the resident loop REPORTS the skip in words — `· unchanged`, not a silent no-op", async () => {
    // The one-shot path prints the same `✓ notekit …` line either way (shared engine, unchanged by this
    // story), so the human-visible skip report lives in the watch loop. Drive a rebuild over unchanged
    // source through a fake watcher and read the line back.
    let cb: ((f: string | null) => void) | undefined;
    let stop: (() => void) | undefined;
    const lines: string[] = [];
    const p = runNotekitDeploy(["deploy", "--vault", vault, "--watch"], {
      log: (l) => lines.push(l),
      watch: (_dir, c) => ((cb = c), { close: () => {} }),
      onWatchStart: (s) => (stop = s),
    });
    while (cb === undefined || stop === undefined) await new Promise((r) => setTimeout(r, 10));

    cb("index.ts"); // a save, but the source did not actually change
    await new Promise((r) => setTimeout(r, WATCH_DEBOUNCE_MS + 350));
    stop!();
    expect(await p).toBe(0);
    expect(lines.join("\n")).toContain("· unchanged");
  });
});

describe("deployOnce — failure leaves the last good artifact intact", () => {
  test("a broken build does not touch the live bundle, then recovers", async () => {
    const target = artifactPath(vault);
    expect((await deployOnce(vault)).ok).toBe(true);
    const good = readFileSync(target, "utf-8");

    const broken = join(tmp, "broken.ts");
    writeFileSync(broken, "export const x = ;\n");
    const res = await deployOnce(vault, broken);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("broken.ts");
    expect(readFileSync(target, "utf-8")).toBe(good); // untouched

    const again = await deployOnce(vault);
    expect(again).toEqual({ ok: true, bytes: good.length, written: false });
  });
});

describe("notekit.config.ts is never a deploy target (D4)", () => {
  test("a hand-authored notekit.config.ts is byte-identical before and after a deploy", async () => {
    const cfg = join(vault, "Scripts", "notekit.config.ts");
    mkdirSync(join(vault, "Scripts"), { recursive: true });
    // No banner — it is caller-local + freeze-exempt. A guard that keyed on the banner and then wrote
    // here would destroy the registry. The deploy must never read, write, or clobber it.
    const original = "export const config = { noteTypes: {}, templates: {} };\n// freeze-exempt\n";
    writeFileSync(cfg, original);

    expect(await runNotekitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    expect(readFileSync(cfg, "utf-8")).toBe(original); // untouched, byte for byte
    expect(readFileSync(artifactPath(vault), "utf-8").split("\n")[0]).toBe(BANNER);
    // …and both files coexist in Scripts/ — the deploy added, it did not replace the directory.
    expect(readdirSync(join(vault, "Scripts")).sort()).toEqual(["notekit.config.ts", "notekit.js"]);
  });

  test("a sibling edge's artifact in the same Scripts/ is untouched by a notekit deploy (AD-8)", async () => {
    // The two note-report edges share one `Scripts/`. Deploying one must not disturb the other.
    mkdirSync(join(vault, "Scripts"), { recursive: true });
    const dashkitArtifact = join(vault, "Scripts", "dashkit.js");
    const original = `${DASHKIT_BANNER}\nexport function statGrid() {}\n`;
    writeFileSync(dashkitArtifact, original);

    expect(await runNotekitDeploy(["deploy", "--vault", vault], { log: () => {} })).toBe(0);
    expect(readFileSync(dashkitArtifact, "utf-8")).toBe(original);
    expect(readdirSync(join(vault, "Scripts")).sort()).toEqual(["dashkit.js", "notekit.js"]);
  });
});

describe("--watch WIRING — the resident branch, with a fake watcher", () => {
  /** Drive `runNotekitDeploy` into the resident branch and shut it down immediately. */
  async function runResident(argv: string[]) {
    const dirs: string[] = [];
    const lines: string[] = [];
    const code = await runNotekitDeploy(argv, {
      log: (l) => lines.push(l),
      watch: (dir) => (dirs.push(dir), { close: () => {} }),
      onWatchStart: (stop) => stop(), // resolve `done` synchronously — no hang, no real timers
    });
    return { code, dirs, lines };
  }

  test("passes BOTH permitted dirs [src/notekit, src/core] to the watcher and names them", async () => {
    const { code, dirs, lines } = await runResident(["deploy", "--vault", vault, "--watch"]);
    expect(code).toBe(0);
    expect(dirs.length).toBe(2);
    expect(dirs.some((d) => d.endsWith(join("src", "notekit")))).toBe(true);
    expect(dirs.some((d) => d.endsWith(join("src", "core")))).toBe(true);
    expect(lines.join("\n")).toContain("watching src/notekit, src/core");
    expect(lines.join("\n")).toContain("ctrl-c to stop");
  });

  test("a save through the fake watcher drives a REAL rebuild — the loop actually redeploys", async () => {
    let cb: ((f: string | null) => void) | undefined;
    let stop: (() => void) | undefined;
    const target = artifactPath(vault);
    const p = runNotekitDeploy(["deploy", "--vault", vault, "--watch"], {
      log: () => {},
      watch: (_dir, c) => ((cb = c), { close: () => {} }),
      onWatchStart: (s) => (stop = s),
    });
    while (cb === undefined || stop === undefined) await new Promise((r) => setTimeout(r, 10));

    writeFileSync(target, `${BANNER}\n// stale\n`); // banner-bearing, so the guard allows the rewrite
    cb("index.ts");
    await new Promise((r) => setTimeout(r, WATCH_DEBOUNCE_MS + 350));
    stop!();
    expect(await p).toBe(0);

    const written = readFileSync(target, "utf-8");
    expect(written).not.toContain("// stale"); // the LOOP rebuilt
    expect(written.split("\n")[0]).toBe(BANNER);
    expect(written).toContain("renderCardDom"); // …with the real notekit edge source
  });

  test("`done` stays pending until stop() — the resident loop does not resolve early", async () => {
    let stop: (() => void) | undefined;
    const p = runNotekitDeploy(["deploy", "--vault", vault, "--watch"], {
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

  test("a watcher that cannot register returns 1, not an unhandled rejection", async () => {
    const code = await runNotekitDeploy(["deploy", "--vault", vault, "--watch"], {
      log: () => {},
      watch: () => {
        throw new Error("ENOSPC: inotify watch limit reached");
      },
      onWatchStart: (stop) => stop(),
    });
    expect(code).toBe(1);
  });

  test("a failing guard means the watcher NEVER registers — no resident loop on a bad vault", async () => {
    let watchCalls = 0;
    const watch = () => (watchCalls++, { close: () => {} });
    expect(
      await runNotekitDeploy(["deploy", "--vault", join(tmp, "nope"), "--watch"], {
        log: () => {},
        watch,
      }),
    ).toBe(1);
    expect(watchCalls).toBe(0);
  });

  test("without --watch nothing goes resident — the one-shot path installs no handler", async () => {
    let started = false;
    const code = await runNotekitDeploy(["deploy", "--vault", vault], {
      log: () => {},
      onWatchStart: () => (started = true),
    });
    expect(code).toBe(0);
    expect(started).toBe(false);
  });

  test("isBundleRelevant is inherited from the shared engine — the ignore-list, not a suffix test", () => {
    for (const yes of ["index.ts", "nkcard.ts.tmp.46812.0e28eeb8a7b3", "XX7Eoqmy", "index.ts~"]) {
      expect(isBundleRelevant(yes)).toBe(true);
    }
    for (const no of ["index.test.ts", "README.md", ".DS_Store"]) {
      expect(isBundleRelevant(no)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// CONTACT — the real `std` bin, in a FRESH process, with a COLD resolver.
//
// Every other case here drives `runNotekitDeploy` in-process, behind the warm-up above. That leaves one
// claim untested and it is the one that matters to a human at a terminal: does `std notekit deploy`
// work on its first try? A subprocess is the only way to ask, because the warm-up cannot be un-done
// inside this process. This is what turns the Bun note above from an excuse into a measurement.
// ---------------------------------------------------------------------------------------------
describe("the real CLI, in a cold subprocess", () => {
  test("`std notekit deploy --vault <dir>` succeeds on the FIRST build of a fresh process", async () => {
    const cold = bareVault(join(tmp, "cold"));
    const repoRoot = join(import.meta.dir, "..", "..");
    const proc = Bun.spawnSync({
      cmd: ["bun", join(repoRoot, "src", "cli", "main.ts"), "notekit", "deploy", "--vault", cold],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();
    expect({ code: proc.exitCode, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("✓ notekit (esm)");
    expect(stdout).toContain(join("Scripts", "notekit.js"));

    const written = readFileSync(artifactPath(cold), "utf-8");
    expect(written.split("\n")[0]).toBe(BANNER);
    expect(written).toContain("renderCardDom"); // ⚠️-1: the EDGE went into the bundle, not the barrel
    expect(written.length).toBeGreaterThan(SIZE_FLOOR);
  });

  test("a second cold invocation is byte-identical and reports the same size", async () => {
    const cold = bareVault(join(tmp, "cold2"));
    const repoRoot = join(import.meta.dir, "..", "..");
    const run = () =>
      Bun.spawnSync({
        cmd: ["bun", join(repoRoot, "src", "cli", "main.ts"), "notekit", "deploy", "--vault", cold],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

    const first = run();
    expect(first.exitCode).toBe(0);
    const bytes = readFileSync(artifactPath(cold));
    const mtime = statSync(artifactPath(cold)).mtimeMs;

    await new Promise((r) => setTimeout(r, 20));
    const second = run();
    expect(second.exitCode).toBe(0);
    expect(readFileSync(artifactPath(cold)).equals(bytes)).toBe(true);
    expect(statSync(artifactPath(cold)).mtimeMs).toBe(mtime); // skip-if-identical, across processes
    // ⚠ Both runs use the SAME cwd on purpose — idempotence holds PER-CWD only. The characterization
    // test below is the oracle for that caveat; this line is not the place it is proven.
    expect(first.stdout.toString()).toBe(second.stdout.toString());
  });

  // -------------------------------------------------------------------------------------------
  // THE CWD-DEPENDENCE, AS A TEST RATHER THAN A COMMENT.
  //
  // The claim used to live only in prose above: `Bun.build` embeds source-path comments relative to
  // `process.cwd()`, so the artifact's bytes depend on where the deploy ran from. Two reasons that was
  // not good enough:
  //
  //   1. It is a REAL PRODUCT PROPERTY, not a test artefact. A deploy from a different working
  //      directory rewrites a byte-identical-in-spirit artifact, so a vault on iCloud re-syncs and
  //      Obsidian re-reads a file whose meaning did not change — the exact cost skip-if-identical
  //      (AC4) exists to avoid.
  //   2. It is worse than an idempotence caveat: the off-root build embeds the ABSOLUTE path of the
  //      repo, so the artifact written into a vault carries the operator's home directory. That is a
  //      D4/NFR3 identity leak in the DEPLOYED bytes, which `check:no-consumer-ids` cannot see because
  //      it scans SOURCE, and which the identity-free cases at the bottom of this file cannot see
  //      because they read the source too.
  //
  // NOT FIXED HERE, and the cheap fix was tried and rejected on evidence: `Bun.build`'s `root` option
  // does NOT re-anchor these comments — measured 2026-08-05, `{root: repoRoot}` produced byte-identical
  // output to no-`root` from BOTH cwds (22,330 from the repo root, 22,822 from `/tmp`, `/Users/` still
  // embedded). A real fix means either mutating `process.cwd()` around the build — global state in a
  // shared engine with a resident watch loop, so no — or post-processing the emitted path comments,
  // which is a change to `src/cli/edge-deploy.ts`, the engine cn and dashkit also ship. Story 1.4 does
  // not own that file and this PR does not touch it.
  //
  // So it is CHARACTERIZED instead: pinned as measured behaviour, both halves stated, and deliberately
  // written to go RED the day the engine is fixed — at which point delete this test and the caveat
  // above with it. A comment cannot do that.
  // -------------------------------------------------------------------------------------------
  test("KNOWN DEFECT (shared engine): a deploy from another cwd rewrites the artifact, and leaks the repo path into it", async () => {
    const cold = bareVault(join(tmp, "cwd"));
    const repoRoot = join(import.meta.dir, "..", "..");
    const run = (cwd: string) =>
      Bun.spawnSync({
        cmd: ["bun", join(repoRoot, "src", "cli", "main.ts"), "notekit", "deploy", "--vault", cold],
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

    expect(run(repoRoot).exitCode).toBe(0);
    const fromRoot = readFileSync(artifactPath(cold), "utf-8");
    // The repo-root artifact is clean: relative source-path comments, no absolute path in it.
    expect(fromRoot).not.toContain(resolve(repoRoot));

    // `tmp` is an OS temp dir, so it shares no meaningful prefix with the repo — the build has to
    // reach for an absolute-ish path to name the sources.
    expect(run(tmp).exitCode).toBe(0);
    const fromElsewhere = readFileSync(artifactPath(cold), "utf-8");

    // 1. NOT idempotent across cwds — the artifact really was rewritten.
    expect(fromElsewhere).not.toBe(fromRoot);
    // 2. …and the rewrite embedded the repo's absolute path. Derived from `import.meta.dir`, never a
    //    baked literal, so this asserts the leak without itself carrying an identity (D4).
    expect(fromRoot.includes(resolve(repoRoot))).toBe(false);
    expect(fromElsewhere.includes(resolve(repoRoot))).toBe(true);
    // 3. The difference is the path comments only — the code is the same length either side of them.
    expect(Math.abs(fromElsewhere.length - fromRoot.length)).toBeGreaterThan(0);
    expect(Math.abs(fromElsewhere.length - fromRoot.length)).toBeLessThan(SIZE_DRIFT_TOLERANCE);
    // 4. Deploying back from the repo root restores the clean bytes — the defect is cwd, not decay.
    expect(run(repoRoot).exitCode).toBe(0);
    expect(readFileSync(artifactPath(cold), "utf-8")).toBe(fromRoot);
  });
});

describe("identity-free (D4/NFR3)", () => {
  test("the deploy source names no vault — no vault name, no Documents path, no /Users/", () => {
    // ⚠ Not redundant with `check:no-consumer-ids`: that gate MASKS comments, so a vault name written
    // in a `//` line passes it. This grep reads the RAW source, comments included, which is the
    // conservative practice the story asks for.
    const src = readFileSync(join(import.meta.dir, "notekit-deploy.ts"), "utf-8");
    expect(src).not.toContain("/Users/");
    expect(src).not.toContain("Documents");
    expect(src.toLowerCase()).not.toContain("pedroibl");
  });

  test("the edge barrel and the package barrel name no vault either", () => {
    for (const f of [
      join(import.meta.dir, "..", "notekit", "index.ts"),
      join(import.meta.dir, "..", "notekit", "edge", "index.ts"),
    ]) {
      const src = readFileSync(f, "utf-8");
      expect(src).not.toContain("/Users/");
      expect(src).not.toContain("Documents");
    }
  });
});
