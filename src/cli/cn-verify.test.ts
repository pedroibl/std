// cn-verify tests (Story 7.3 AC9) — every fail-loud guard as its own case, the two cases that are
// deliberately NOT guard failures, and an end-to-end run against a temp dir shaped like a real vault
// asserting the EXACT printed lines, the summary and the exit code.
//
// A green run here is not evidence the reader works against a real `.obsidian/` — that is what AC10's
// contact check is for. Fixtures test your assertions; contact tests your assumptions.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CN_PLUGIN_CONTRACT } from "../cn/plugins";
import { CnVerifyError, readVaultPlugins, renderFindings, runCnVerify } from "./cn-verify";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "std-cn-verify-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Write `.obsidian/community-plugins.json` with an arbitrary body (a string stays unparsed). */
function writeEnabled(dir: string, body: unknown): void {
  writeFileSync(
    join(dir, ".obsidian", "community-plugins.json"),
    typeof body === "string" ? body : JSON.stringify(body),
  );
}

/** Write one `.obsidian/plugins/<dir>/manifest.json`. `version: null` writes a manifest without one. */
function writeManifest(dir: string, pluginDir: string, id: string, version: string | null): void {
  const d = join(dir, ".obsidian", "plugins", pluginDir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "manifest.json"), JSON.stringify(version === null ? { id } : { id, version }));
}

/** The contract's own idea of a healthy vault, written to disk. */
function makeHealthyVault(dir: string): void {
  const enabled: string[] = [];
  for (const e of CN_PLUGIN_CONTRACT) {
    if (e.observedVersion === null) continue;
    enabled.push(e.id);
    writeManifest(dir, e.id, e.id, e.observedVersion);
  }
  writeEnabled(dir, enabled);
}

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l: string) => out.push(l), logError: (l: string) => err.push(l) };
}

describe("readVaultPlugins — the fail-loud guards (mirrors cn deploy)", () => {
  test("missing --vault throws", () => {
    expect(() => readVaultPlugins(undefined)).toThrow(CnVerifyError);
    expect(() => readVaultPlugins(undefined)).toThrow(/--vault <dir> is required/);
  });

  test("empty --vault throws", () => {
    expect(() => readVaultPlugins("")).toThrow(/--vault <dir> is required/);
  });

  test("a vault dir that does not exist throws", () => {
    expect(() => readVaultPlugins(join(tmp, "nope"))).toThrow(/vault does not exist/);
  });

  test("a dir without .obsidian/ throws (not an Obsidian vault)", () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    expect(() => readVaultPlugins(plain)).toThrow(/not an Obsidian vault/);
  });

  test("a vault with no community-plugins.json throws", () => {
    expect(() => readVaultPlugins(vault)).toThrow(/no community-plugins.json/);
  });

  test("community-plugins.json that is not an array throws", () => {
    writeEnabled(vault, { dataview: true });
    expect(() => readVaultPlugins(vault)).toThrow(/not a JSON array of plugin ids/);
  });

  test("community-plugins.json with a non-string entry throws", () => {
    writeEnabled(vault, ["dataview", 7]);
    expect(() => readVaultPlugins(vault)).toThrow(/not a JSON array of plugin ids/);
  });

  test("UNPARSEABLE community-plugins.json throws — never softens to an empty vault", () => {
    // loadJson fail-softs a parse error to its fallback, and an empty vault reports "both foundations
    // missing" — a parse failure dressed up as a real finding. The sentinel + shape check is what
    // keeps it loud.
    writeEnabled(vault, "{ not json");
    expect(() => readVaultPlugins(vault)).toThrow(/not a JSON array of plugin ids/);
  });
});

describe("readVaultPlugins — the two cases that are NOT guard failures", () => {
  test("a MISSING .obsidian/plugins/ dir yields versions {} — not an error", () => {
    writeEnabled(vault, ["dataview", "fix-require-modules"]);
    const observed = readVaultPlugins(vault);
    expect(observed.enabled).toEqual(["dataview", "fix-require-modules"]);
    expect(observed.versions).toEqual({});
  });

  test("an enabled id with no manifest is simply absent from versions", () => {
    writeEnabled(vault, ["dataview", "fix-require-modules"]);
    writeManifest(vault, "dataview", "dataview", "0.5.68");
    expect(readVaultPlugins(vault).versions).toEqual({ dataview: "0.5.68" });
  });

  test("a manifest with no version is treated as no manifest at all", () => {
    writeEnabled(vault, ["dataview"]);
    writeManifest(vault, "dataview", "dataview", null);
    expect(readVaultPlugins(vault).versions).toEqual({});
  });
});

describe("readVaultPlugins — how ids are resolved", () => {
  test("the manifest's own id wins over the directory name", () => {
    writeEnabled(vault, ["dataview"]);
    writeManifest(vault, "dataview-fork", "dataview", "0.5.68");
    expect(readVaultPlugins(vault).versions).toEqual({ dataview: "0.5.68" });
  });

  test("a manifest with no id falls back to the directory name", () => {
    writeEnabled(vault, ["dataview"]);
    const d = join(vault, ".obsidian", "plugins", "dataview");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ version: "0.5.68" }));
    expect(readVaultPlugins(vault).versions).toEqual({ dataview: "0.5.68" });
  });

  test("a manifest.json NESTED inside a plugin does not register a phantom plugin", () => {
    writeEnabled(vault, ["dataview"]);
    writeManifest(vault, "dataview", "dataview", "0.5.68");
    const nested = join(vault, ".obsidian", "plugins", "dataview", "node_modules", "dep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "manifest.json"), JSON.stringify({ id: "phantom", version: "9.9.9" }));
    expect(readVaultPlugins(vault).versions).toEqual({ dataview: "0.5.68" });
  });
});

describe("renderFindings — the fixed line format", () => {
  test("renders `<glyph> <id padded> <message>` and a summary after a blank line", () => {
    const lines = renderFindings([
      { id: "dataview", severity: "ok", message: "Dataview 0.5.68 — foundation present" },
      { id: "js-engine", severity: "info", message: "JS Engine — deliberately absent" },
    ]);
    expect(lines).toEqual([
      "✓ dataview                 Dataview 0.5.68 — foundation present",
      "ℹ js-engine                JS Engine — deliberately absent",
      "",
      "ℹ 1  ✓ 1",
    ]);
  });

  test("an empty finding list prints NOTHING — no blank line, no empty summary", () => {
    expect(renderFindings([])).toEqual([]);
  });
});

describe("runCnVerify — exit codes and printed output", () => {
  test("missing --vault is a USAGE error: exit 2, mirroring cn deploy", () => {
    const s = sink();
    expect(runCnVerify([], s)).toBe(2);
    expect(s.err.join("\n")).toContain("--vault <dir> is required");
    expect(s.out).toEqual([]);
  });

  test("a real guard failure is exit 1, not 2", () => {
    const s = sink();
    expect(runCnVerify(["--vault", join(tmp, "nope")], s)).toBe(1);
    expect(s.err.join("\n")).toContain("vault does not exist");
  });

  test("a healthy vault prints ok x2 + info x3 and exits 0", () => {
    makeHealthyVault(vault);
    const s = sink();
    expect(runCnVerify(["--vault", vault], s)).toBe(0);
    expect(s.out).toEqual([
      "✓ fix-require-modules      CodeScript Toolkit 13.3.2 — foundation present",
      "✓ dataview                 Dataview 0.5.68 — foundation present",
      "ℹ table-editor-obsidian    Advanced Tables 0.23.2 — ambient, outside cn's envelope",
      "ℹ color-folders-files      Color Folders and Files 1.4.1 — ambient, outside cn's envelope",
      "ℹ js-engine                JS Engine — deliberately absent from this vault (the other Obsidian edge's foundation; deliberately not installed in this edge's vault)",
      "",
      "ℹ 3  ✓ 2",
    ]);
  });

  test("a vault missing the loader exits 1 and says cn cannot run", () => {
    makeHealthyVault(vault);
    writeEnabled(vault, ["dataview", "table-editor-obsidian", "color-folders-files"]);
    const s = sink();
    expect(runCnVerify(["--vault", vault], s)).toBe(1);
    expect(s.out.join("\n")).toContain("✗ fix-require-modules");
    expect(s.out.join("\n")).toContain("cn cannot run without it");
    expect(s.out.at(-1)).toContain("✗ 1");
  });

  test("DRIFT never fails the command — exit 0 with a warn (AD-6: no hard version-pins)", () => {
    makeHealthyVault(vault);
    writeManifest(vault, "dataview", "dataview", "0.5.99");
    const s = sink();
    expect(runCnVerify(["--vault", vault], s)).toBe(0);
    expect(s.out.join("\n")).toContain("⚠ dataview");
    expect(s.out.join("\n")).toContain("drift from the observed 0.5.68");
  });

  test("an enabled foundation with no plugins/ dir at all exits 1 (registered, not installed)", () => {
    writeEnabled(vault, ["dataview", "fix-require-modules"]);
    const s = sink();
    expect(runCnVerify(["--vault", vault], s)).toBe(1);
    expect(s.out.join("\n")).toContain("no manifest.json");
  });

  test("an unknown enabled plugin is info and never changes the exit code", () => {
    makeHealthyVault(vault);
    writeEnabled(vault, [...CN_PLUGIN_CONTRACT.filter((e) => e.observedVersion !== null).map((e) => e.id), "obsidian-git"]);
    const s = sink();
    expect(runCnVerify(["--vault", vault], s)).toBe(0);
    expect(s.out.join("\n")).toContain("ℹ obsidian-git");
    expect(s.out.join("\n")).toContain("not in cn's contract");
  });
});
