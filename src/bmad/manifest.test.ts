// Story 2.1 acceptance suite for the BMAD estate Manifest — the loader's fail-loud contract, the
// defaults, and the `--repos`/`--tools`/`--set` selectors (AC1–AC9).
//
// Every fixture is written INLINE to a fresh file under `os.tmpdir()` and injected as
// `deps.manifestPath` (mirroring `bmad.test-helpers.ts`'s tmpdir discipline). The real
// `~/.config/std/estate.toml` is a machine owner's file — this suite never reads it, never writes it,
// and never depends on it existing.
//
// IDENTITY-FREE fixtures on purpose. The `check:no-consumer-ids` gate globs `src/**/*.ts` and SKIPS
// `*.test.ts`, so nothing here is scanned — but a real consumer path in a fixture is bad hygiene
// regardless, and the gate's fence could widen. Repos here are `alpha`/`beta`/`gamma`/`delta` under
// generic temp-ish paths; no machine-owner path appears.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TOOLS,
  ManifestError,
  loadManifest,
  parseSelectors,
  repoName,
  resolveManifestPath,
  selectRepos,
  type BmadRepo,
} from "./manifest";

const scratch = mkdtempSync(join(tmpdir(), "estate-fixture-"));
let seq = 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Write a TOML fixture to a fresh temp file and return its path (the injected `deps.manifestPath`). */
function fixture(toml: string): string {
  const path = join(scratch, `estate-${seq++}.toml`);
  writeFileSync(path, toml, "utf-8");
  return path;
}

/** A four-entry estate: two plain targets, one explicit `role:"target"`, one `source-only`. */
const FULL_ESTATE = `
[[repos]]
path = "/srv/estate/alpha"
claudeTracked = true
hasUpstream = true

[[repos]]
path = "/srv/estate/beta"
claudeTracked = false
hasUpstream = true
branch = "feature/wip"
notes = "working-copy-only"
tools = ["claude-code"]

[[repos]]
path = "/srv/estate/gamma"
role = "target"
claudeTracked = true
hasUpstream = false

[[repos]]
path = "/srv/estate/hq/delta"
role = "source-only"
claudeTracked = false
hasUpstream = false
`;

describe("AC2/AC8 — resolveManifestPath is the single canonical, caller-local Manifest path", () => {
  test("honors $XDG_CONFIG_HOME", () => {
    expect(resolveManifestPath({ XDG_CONFIG_HOME: "/x" } as NodeJS.ProcessEnv)).toBe("/x/std/estate.toml");
  });

  test("falls back to <home>/.config when XDG_CONFIG_HOME is absent", () => {
    expect(resolveManifestPath({} as NodeJS.ProcessEnv)).toBe(join(homedir(), ".config", "std", "estate.toml"));
  });

  test("an empty XDG_CONFIG_HOME takes the homedir fallback, not a bare /std/estate.toml", () => {
    expect(resolveManifestPath({ XDG_CONFIG_HOME: "" } as NodeJS.ProcessEnv)).toBe(
      join(homedir(), ".config", "std", "estate.toml"),
    );
  });

  // AC8: the shared cross-tool contract. `bmad-lifeos-sync` reads no estate list today (it works one
  // `--directory <target>` per invocation), so there is no second reader to assert equality against —
  // the honest assertion is that this resolver IS the single source of the path sync must adopt when it
  // gains batch mode. Asserting the literal, not a fabricated sync-side reader.
  test("the shared path both tools must resolve is <xdg-or-home-config>/std/estate.toml", () => {
    expect(resolveManifestPath({ XDG_CONFIG_HOME: "/shared/config" } as NodeJS.ProcessEnv)).toBe(
      "/shared/config/std/estate.toml",
    );
  });
});

describe("AC3 — loadManifest parses, and fails loud naming the offender", () => {
  test("parses a [[repos]] list into BmadRepo[]", () => {
    const repos = loadManifest({ manifestPath: fixture(FULL_ESTATE) });
    expect(repos).toHaveLength(4);
    expect(repos[0]).toEqual({
      path: "/srv/estate/alpha",
      tools: ["claude-code", "antigravity-cli"],
      claudeTracked: true,
      hasUpstream: true,
    });
    expect(repos[1]).toEqual({
      path: "/srv/estate/beta",
      tools: ["claude-code"],
      claudeTracked: false,
      hasUpstream: true,
      branch: "feature/wip",
      notes: "working-copy-only",
    });
  });

  test("a missing file throws ManifestError naming the path", () => {
    const missing = join(scratch, "does-not-exist.toml");
    expect(() => loadManifest({ manifestPath: missing })).toThrow(ManifestError);
    expect(() => loadManifest({ manifestPath: missing })).toThrow(missing);
  });

  test("unparseable TOML throws ManifestError naming the path", () => {
    const path = fixture("this is = = not toml [[[");
    expect(() => loadManifest({ manifestPath: path })).toThrow(ManifestError);
    expect(() => loadManifest({ manifestPath: path })).toThrow(path);
  });

  // The guard that keeps an empty/no-[[repos]] file from surfacing a raw TypeError: Bun.TOML.parse("")
  // is {} and Bun.TOML.parse("foo=1") is {foo:1} — `.repos` is undefined in both.
  test("an empty file throws a named ManifestError, not a TypeError", () => {
    const path = fixture("");
    expect(() => loadManifest({ manifestPath: path })).toThrow(ManifestError);
    expect(() => loadManifest({ manifestPath: path })).toThrow(`estate.toml at ${path} has no [[repos]] entries`);
  });

  test("a file with no [[repos]] array throws a named ManifestError, not a TypeError", () => {
    const path = fixture("foo = 1\n");
    expect(() => loadManifest({ manifestPath: path })).toThrow(ManifestError);
    expect(() => loadManifest({ manifestPath: path })).toThrow(`estate.toml at ${path} has no [[repos]] entries`);
    // Explicitly NOT the raw iteration fault the guard exists to prevent.
    expect(() => loadManifest({ manifestPath: path })).not.toThrow(TypeError);
  });

  test("a missing `path` names the entry by index", () => {
    const path = fixture(`[[repos]]\nclaudeTracked = true\nhasUpstream = true\n`);
    expect(() => loadManifest({ manifestPath: path })).toThrow(ManifestError);
    expect(() => loadManifest({ manifestPath: path })).toThrow(
      'estate.toml entry #0: missing required field "path"',
    );
  });

  test("a missing `claudeTracked` names the entry by path", () => {
    const path = fixture(`[[repos]]\npath = "/srv/estate/alpha"\nhasUpstream = true\n`);
    expect(() => loadManifest({ manifestPath: path })).toThrow(ManifestError);
    expect(() => loadManifest({ manifestPath: path })).toThrow(
      'estate.toml entry "/srv/estate/alpha": missing required field "claudeTracked"',
    );
  });

  test("a missing `hasUpstream` names the entry by path", () => {
    const path = fixture(`[[repos]]\npath = "/srv/estate/beta"\nclaudeTracked = true\n`);
    expect(() => loadManifest({ manifestPath: path })).toThrow(ManifestError);
    expect(() => loadManifest({ manifestPath: path })).toThrow(
      'estate.toml entry "/srv/estate/beta": missing required field "hasUpstream"',
    );
  });

  test("the second entry's fault is caught too — no silent skip of a bad row", () => {
    const path = fixture(
      `[[repos]]\npath = "/srv/estate/alpha"\nclaudeTracked = true\nhasUpstream = true\n\n` +
        `[[repos]]\npath = "/srv/estate/beta"\nclaudeTracked = true\n`,
    );
    expect(() => loadManifest({ manifestPath: path })).toThrow(
      'estate.toml entry "/srv/estate/beta": missing required field "hasUpstream"',
    );
  });

  test("a wrong-typed required boolean fails loud rather than coercing", () => {
    const path = fixture(`[[repos]]\npath = "/srv/estate/alpha"\nclaudeTracked = "yes"\nhasUpstream = true\n`);
    expect(() => loadManifest({ manifestPath: path })).toThrow(
      'estate.toml entry "/srv/estate/alpha": field "claudeTracked" must be a boolean',
    );
  });

  test("an unknown `role` value fails loud instead of silently reading as a target", () => {
    const path = fixture(
      `[[repos]]\npath = "/srv/estate/alpha"\nrole = "sourceonly"\nclaudeTracked = true\nhasUpstream = true\n`,
    );
    expect(() => loadManifest({ manifestPath: path })).toThrow(ManifestError);
    expect(() => loadManifest({ manifestPath: path })).toThrow('field "role" must be "target" or "source-only"');
  });

  test("the default reader is injectable — a fake fs is honored", () => {
    const repos = loadManifest({
      manifestPath: "/nowhere/estate.toml",
      fs: { readIfExists: () => `[[repos]]\npath = "/srv/estate/alpha"\nclaudeTracked = true\nhasUpstream = true\n` },
    });
    expect(repos.map((r) => r.path)).toEqual(["/srv/estate/alpha"]);
  });

  test("with no manifestPath the resolver + injected env pick the read target", () => {
    let asked = "";
    loadManifest({
      env: { XDG_CONFIG_HOME: "/x" } as NodeJS.ProcessEnv,
      fs: {
        readIfExists: (p) => {
          asked = p;
          return `[[repos]]\npath = "/srv/estate/alpha"\nclaudeTracked = true\nhasUpstream = true\n`;
        },
      },
    });
    expect(asked).toBe("/x/std/estate.toml");
  });
});

describe("AC4 — defaults", () => {
  test("an omitted `tools` resolves to ['claude-code','antigravity-cli']", () => {
    const [alpha] = loadManifest({ manifestPath: fixture(FULL_ESTATE) });
    expect(alpha!.tools).toEqual(["claude-code", "antigravity-cli"]);
    expect(DEFAULT_TOOLS).toEqual(["claude-code", "antigravity-cli"]);
  });

  test("a declared `tools` is preserved, not merged with the default", () => {
    const repos = loadManifest({ manifestPath: fixture(FULL_ESTATE) });
    expect(repos[1]!.tools).toEqual(["claude-code"]);
  });

  test("each entry gets its own tools array — mutating one cannot leak into another", () => {
    const repos = loadManifest({ manifestPath: fixture(FULL_ESTATE) });
    repos[0]!.tools.push("mutant");
    expect(repos[2]!.tools).toEqual(["claude-code", "antigravity-cli"]);
    expect(DEFAULT_TOOLS).toEqual(["claude-code", "antigravity-cli"]);
  });

  test("an omitted `role` is absent on the record and treated as a target", () => {
    const repos = loadManifest({ manifestPath: fixture(FULL_ESTATE) });
    expect(repos[0]!.role).toBeUndefined();
    expect(selectRepos(repos).map((r) => r.path)).toContain("/srv/estate/alpha");
  });
});

describe("AC5 — the default repo set is the Manifest minus source-only", () => {
  test("source-only is excluded; absent-role and explicit-target are included, in order", () => {
    const repos = loadManifest({ manifestPath: fixture(FULL_ESTATE) });
    expect(selectRepos(repos).map(repoName)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("the source-only entry still loads and carries the flag Story 2.4 reads", () => {
    const repos = loadManifest({ manifestPath: fixture(FULL_ESTATE) });
    expect(repos).toHaveLength(4);
    expect(repos[3]!.role).toBe("source-only");
  });

  test("an estate of only source-only entries yields an empty default set, not an error", () => {
    const path = fixture(
      `[[repos]]\npath = "/srv/estate/hq/delta"\nrole = "source-only"\nclaudeTracked = false\nhasUpstream = false\n`,
    );
    expect(selectRepos(loadManifest({ manifestPath: path }))).toEqual([]);
  });

  test("an omitted opts object behaves as no --repos", () => {
    const repos = loadManifest({ manifestPath: fixture(FULL_ESTATE) });
    expect(selectRepos(repos, {})).toEqual(selectRepos(repos));
  });
});

describe("AC6 — --repos restricts, preserves Manifest order, and errors on an unknown name", () => {
  const load = (): BmadRepo[] => loadManifest({ manifestPath: fixture(FULL_ESTATE) });

  test("restricts to the named repos", () => {
    expect(selectRepos(load(), { repos: ["alpha", "gamma"] }).map(repoName)).toEqual(["alpha", "gamma"]);
  });

  test("preserves MANIFEST declaration order, not the flag's order (BM-16)", () => {
    expect(selectRepos(load(), { repos: ["gamma", "alpha"] }).map(repoName)).toEqual(["alpha", "gamma"]);
  });

  test("an unknown name throws ManifestError containing the offending name", () => {
    expect(() => selectRepos(load(), { repos: ["alpha", "nope"] })).toThrow(ManifestError);
    expect(() => selectRepos(load(), { repos: ["alpha", "nope"] })).toThrow('unknown repo "nope"');
  });

  test("one unknown name fails the whole selection — nothing is silently dropped", () => {
    expect(() => selectRepos(load(), { repos: ["nope"] })).toThrow(ManifestError);
  });

  test("an explicit `name` field wins over basename(path) as the match key", () => {
    const path = fixture(
      `[[repos]]\npath = "/srv/estate/nested/pack"\nname = "labpack"\nclaudeTracked = true\nhasUpstream = true\n`,
    );
    const repos = loadManifest({ manifestPath: path });
    expect(repoName(repos[0]!)).toBe("labpack");
    expect(selectRepos(repos, { repos: ["labpack"] })).toHaveLength(1);
    expect(() => selectRepos(repos, { repos: ["pack"] })).toThrow('unknown repo "pack"');
  });

  test("an explicit --repos may name a source-only entry — the AC5 exclusion is about the DEFAULT set", () => {
    expect(selectRepos(load(), { repos: ["delta"] }).map(repoName)).toEqual(["delta"]);
  });
});

describe("AC7 — parseSelectors yields structured data (and consumes none of it)", () => {
  test("--repos and --tools comma-split", () => {
    const s = parseSelectors(["--repos", "alpha,beta", "--tools", "claude-code,antigravity-cli"]);
    expect(s.repos).toEqual(["alpha", "beta"]);
    expect(s.tools).toEqual(["claude-code", "antigravity-cli"]);
  });

  test("the --flag=value form parses too", () => {
    expect(parseSelectors(["--repos=alpha,beta"]).repos).toEqual(["alpha", "beta"]);
  });

  test("absent flags are absent, and `set` is always an array", () => {
    const s = parseSelectors([]);
    expect(s.repos).toBeUndefined();
    expect(s.tools).toBeUndefined();
    expect(s.set).toEqual([]);
  });

  test("EVERY repeated --set is collected — the second does not overwrite the first", () => {
    const s = parseSelectors(["--set", "bmm.a=1", "--set", "core.b=2", "--set=bmm.c=3"]);
    expect(s.set).toEqual([
      { module: "bmm", key: "a", value: "1" },
      { module: "core", key: "b", value: "2" },
      { module: "bmm", key: "c", value: "3" },
    ]);
  });

  test("a dotted key keeps the first segment as the module", () => {
    expect(parseSelectors(["--set", "bmm.a.b=1"]).set).toEqual([{ module: "bmm", key: "a.b", value: "1" }]);
  });

  test("a value containing = is preserved whole", () => {
    expect(parseSelectors(["--set", "bmm.a=x=y"]).set).toEqual([{ module: "bmm", key: "a", value: "x=y" }]);
  });

  test.each([["nodot=1"], ["bmm.nokey"], [".leading=1"], ["bmm.=1"], [""]])(
    "a malformed --set token %p throws ManifestError naming it",
    (token) => {
      expect(() => parseSelectors(["--set", token])).toThrow(ManifestError);
      expect(() => parseSelectors(["--set", token])).toThrow(`got "${token}"`);
    },
  );

  test("a trailing --set with no value fails loud", () => {
    expect(() => parseSelectors(["--set"])).toThrow(ManifestError);
  });

  test("empty comma segments are dropped, and an all-empty list reads as absent", () => {
    expect(parseSelectors(["--repos", "alpha,,beta"]).repos).toEqual(["alpha", "beta"]);
    expect(parseSelectors(["--repos", ","]).repos).toBeUndefined();
  });
});

describe("AC1 — the BmadRepo record is the shape later stories depend on", () => {
  test("required fields survive the round trip; optionals stay absent when omitted", () => {
    const [alpha] = loadManifest({ manifestPath: fixture(FULL_ESTATE) });
    const repo: BmadRepo = alpha!;
    expect(typeof repo.path).toBe("string");
    expect(typeof repo.claudeTracked).toBe("boolean");
    expect(typeof repo.hasUpstream).toBe("boolean");
    expect(Array.isArray(repo.tools)).toBe(true);
    expect(Object.keys(repo).sort()).toEqual(["claudeTracked", "hasUpstream", "path", "tools"]);
  });

  test("the git-safety booleans are carried verbatim, never defaulted", () => {
    const repos = loadManifest({ manifestPath: fixture(FULL_ESTATE) });
    expect(repos.map((r) => r.claudeTracked)).toEqual([true, false, true, false]);
    expect(repos.map((r) => r.hasUpstream)).toEqual([true, true, false, false]);
  });
});
