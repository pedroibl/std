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
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BANNER,
  BANNER_PREFIX,
  CnDeployError,
  artifactPath,
  buildBundle,
  entrypoint,
  resolveTarget,
  runCnDeploy,
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

describe("identity-free (D4/NFR3)", () => {
  test("the deploy source names no vault — the path arrives only as --vault", () => {
    const src = readFileSync(join(import.meta.dir, "cn-deploy.ts"), "utf-8");
    expect(src.toLowerCase()).not.toContain("zdrafts");
    expect(src).not.toContain("obsidian2");
    expect(src).not.toContain("Mobile Documents");
  });
});
