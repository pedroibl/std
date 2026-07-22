// edge-verify tests — the SHARED vault-read / render / dispatch module promoted at Story 8.4 (D-2). cn's
// and dashkit's own verify suites exercise it end-to-end through their thin wrappers; this file tests the
// generic surface directly with an arbitrary contract + edge label (proving it holds no edge's knowledge),
// and re-proves the two PR-#56 fixes that live in `readVaultPlugins` IN THEIR NEW HOME (D-6): each must go
// red when that fix ALONE is reverted (memory verify-review-patches-by-reverting-each).
//
// A green run here is not evidence the reader works against a real `.obsidian/` — that is each edge's
// contact check (AC5). Fixtures test your assertions; contact tests your assumptions.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginContractEntry } from "../core/plugin-contract";
import { EdgeVerifyError, readVaultPlugins, renderFindings, runVerify } from "./edge-verify";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "std-edge-verify-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeEnabled(dir: string, body: unknown): void {
  writeFileSync(
    join(dir, ".obsidian", "community-plugins.json"),
    typeof body === "string" ? body : JSON.stringify(body),
  );
}

function writeManifestRaw(dir: string, pluginDir: string, body: string): void {
  const d = join(dir, ".obsidian", "plugins", pluginDir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "manifest.json"), body);
}

/** A one-row generic contract — no cn/dashkit identity — to prove the module is edge-agnostic. */
const GENERIC_CONTRACT: readonly PluginContractEntry[] = [
  { id: "acme", name: "Acme", role: "foundation", required: true, observedVersion: "1.0.0", why: "test" },
];

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l: string) => out.push(l), logError: (l: string) => err.push(l) };
}

describe("readVaultPlugins — the fail-loud guards, edge-agnostic", () => {
  test("missing --vault throws EdgeVerifyError", () => {
    expect(() => readVaultPlugins(undefined)).toThrow(EdgeVerifyError);
    expect(() => readVaultPlugins(undefined)).toThrow(/--vault <dir> is required/);
  });

  test("a dir without .obsidian/ throws", () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    expect(() => readVaultPlugins(plain)).toThrow(/not an Obsidian vault/);
  });

  test("no community-plugins.json throws", () => {
    expect(() => readVaultPlugins(vault)).toThrow(/no community-plugins.json/);
  });

  test("a non-array community-plugins.json throws (never softens to an empty vault)", () => {
    writeEnabled(vault, { dataview: true });
    expect(() => readVaultPlugins(vault)).toThrow(/not a JSON array of plugin ids/);
  });
});

describe("readVaultPlugins — D-6 fix #1: a junk manifest is skipped, not dereferenced", () => {
  // REVERT-PROOF: this is the PR-#56 MINOR 2 fix, now living in edge-verify.ts. Removing the
  // `if (m === null || typeof m !== "object" || Array.isArray(m)) continue;` guard makes `m.id` throw a
  // raw TypeError on the `null` manifest below — this test goes red.
  test("a manifest that is exactly `null` / an array / a bare string is skipped, no TypeError", () => {
    writeEnabled(vault, ["a", "b", "c"]);
    writeManifestRaw(vault, "a", "null");
    writeManifestRaw(vault, "b", "[1,2]");
    writeManifestRaw(vault, "c", '"nope"');
    expect(readVaultPlugins(vault).versions).toEqual({});
  });
});

describe("readVaultPlugins — D-6 fix #3: depth-1 pruning, no phantom plugin", () => {
  // REVERT-PROOF: the PR-#56 depth-1 prune, now in edge-verify.ts. Dropping either the `prune` option or
  // the `.filter((p) => dirname(dirname(p)) === pluginsRoot)` lets the nested manifest register `phantom`
  // — this test goes red.
  test("a manifest.json nested inside a plugin does not register a phantom", () => {
    writeEnabled(vault, ["dataview"]);
    writeManifestRaw(vault, "dataview", JSON.stringify({ id: "dataview", version: "0.5.68" }));
    const nested = join(vault, ".obsidian", "plugins", "dataview", "node_modules", "dep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "manifest.json"), JSON.stringify({ id: "phantom", version: "9.9.9" }));
    expect(readVaultPlugins(vault).versions).toEqual({ dataview: "0.5.68" });
  });
});

describe("renderFindings — the fixed line format, edge-agnostic", () => {
  test("renders `<glyph> <id padded> <message>` and a summary after a blank line", () => {
    const lines = renderFindings([
      { id: "acme", severity: "ok", message: "Acme 1.0.0 — foundation present" },
      { id: "widget", severity: "info", message: "Widget — deliberately absent" },
    ]);
    expect(lines).toEqual([
      "✓ acme                     Acme 1.0.0 — foundation present",
      "ℹ widget                   Widget — deliberately absent",
      "",
      "ℹ 1  ✓ 1",
    ]);
  });

  test("an empty finding list prints NOTHING", () => {
    expect(renderFindings([])).toEqual([]);
  });
});

describe("runVerify — the 0/1/2 dispatch, parameterized by {edge, contract}", () => {
  test("missing --vault is a USAGE error: exit 2, nothing on stdout", () => {
    const s = sink();
    expect(runVerify({ edge: "acme", contract: GENERIC_CONTRACT }, [], s)).toBe(2);
    expect(s.err.join("\n")).toContain("--vault <dir> is required");
    expect(s.out).toEqual([]);
  });

  test("a healthy vault exits 0 and names the edge in its findings", () => {
    writeEnabled(vault, ["acme"]);
    writeManifestRaw(vault, "acme", JSON.stringify({ id: "acme", version: "1.0.0" }));
    const s = sink();
    expect(runVerify({ edge: "acme", contract: GENERIC_CONTRACT }, ["--vault", vault], s)).toBe(0);
    expect(s.out.join("\n")).toContain("Acme 1.0.0 — foundation present");
  });

  test("a missing foundation exits 1 and names the edge", () => {
    writeEnabled(vault, []);
    const s = sink();
    expect(runVerify({ edge: "acme", contract: GENERIC_CONTRACT }, ["--vault", vault], s)).toBe(1);
    expect(s.out.join("\n")).toContain("acme cannot run without it");
  });

  test("drift never fails the command — exit 0 with a warn", () => {
    writeEnabled(vault, ["acme"]);
    writeManifestRaw(vault, "acme", JSON.stringify({ id: "acme", version: "2.0.0" }));
    const s = sink();
    expect(runVerify({ edge: "acme", contract: GENERIC_CONTRACT }, ["--vault", vault], s)).toBe(0);
    expect(s.out.join("\n")).toContain("drift from the observed 1.0.0");
  });
});
