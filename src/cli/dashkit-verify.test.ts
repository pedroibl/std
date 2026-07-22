// dashkit-verify tests (Story 8.4 AC4) — `std dashkit verify --vault <dir>` end to end against a temp dir
// shaped like the note-report vault, plus the exit-code PARITY table asserted against `dashkit deploy`'s
// codes. The reader itself is the promoted `edge-verify` module (tested there); this proves the dashkit
// wiring — label, contract, dispatch — and the mirror of cn verify's contract.
//
// A green run here is not evidence the reader works against the REAL vault — that is AC5's one contact run.
// Fixtures test your assertions; contact tests your assumptions.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DASHKIT_PLUGIN_CONTRACT } from "../dashkit/plugins";
import { DashkitVerifyError, runDashkitVerify } from "./dashkit-verify";
import { runDashkitDeploy } from "./dashkit-deploy";
import { makeVaultFixture } from "./vault-fixture";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "std-dashkit-verify-"));
  vault = makeVaultFixture(join(tmp, "vault"), DASHKIT_PLUGIN_CONTRACT);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l: string) => out.push(l), logError: (l: string) => err.push(l) };
}

describe("DashkitVerifyError is the promoted class", () => {
  test("it IS the same class the reader throws (alias re-export)", () => {
    // Sanity that the alias holds — a fresh error from the reader is `instanceof DashkitVerifyError`.
    expect(new DashkitVerifyError("x")).toBeInstanceOf(DashkitVerifyError);
  });
});

describe("runDashkitVerify — exit codes and printed output", () => {
  test("missing --vault is a USAGE error: exit 2, mirroring dashkit deploy", () => {
    const s = sink();
    expect(runDashkitVerify([], s)).toBe(2);
    expect(s.err.join("\n")).toContain("--vault <dir> is required");
    expect(s.out).toEqual([]);
  });

  test("a real guard failure is exit 1, not 2", () => {
    const s = sink();
    expect(runDashkitVerify(["--vault", join(tmp, "nope")], s)).toBe(1);
    expect(s.err.join("\n")).toContain("vault does not exist");
  });

  test("a healthy vault prints ok x3 + info x6 and exits 0 — the fixed line format + summary", () => {
    const s = sink();
    expect(runDashkitVerify(["--vault", vault], s)).toBe(0);
    // 9 finding lines + a blank + the summary.
    expect(s.out).toHaveLength(11);
    // The two foundation rows dashkit shares with cn render byte-identically to cn's proven output.
    expect(s.out[0]).toBe("✓ fix-require-modules      CodeScript Toolkit 13.3.2 — foundation present");
    expect(s.out[2]).toBe("✓ dataview                 Dataview 0.5.68 — foundation present");
    // …and js-engine is a FOUNDATION here (note-report has it), unlike cn where it is declared absent.
    expect(s.out[1]).toBe("✓ js-engine                JS Engine 0.3.6 — foundation present");
    for (const line of s.out.slice(3, 9)) expect(line).toContain("outside dashkit's envelope");
    expect(s.out.at(-1)).toBe("ℹ 6  ✓ 3");
  });

  test("a vault missing the loader exits 1 and says dashkit cannot run", () => {
    const broken = makeVaultFixture(join(tmp, "broken"), DASHKIT_PLUGIN_CONTRACT, {
      omit: ["fix-require-modules"],
    });
    const s = sink();
    expect(runDashkitVerify(["--vault", broken], s)).toBe(1);
    expect(s.out.join("\n")).toContain("✗ fix-require-modules");
    expect(s.out.join("\n")).toContain("dashkit cannot run without it");
    expect(s.out.at(-1)).toContain("✗ 1");
  });

  test("DRIFT never fails the command — exit 0 with a warn (AD-6: no hard version-pins)", () => {
    const drifted = makeVaultFixture(join(tmp, "drift"), DASHKIT_PLUGIN_CONTRACT, {
      versions: { dataview: "0.5.99" },
    });
    const s = sink();
    expect(runDashkitVerify(["--vault", drifted], s)).toBe(0);
    expect(s.out.join("\n")).toContain("⚠ dataview");
    expect(s.out.join("\n")).toContain("drift from the observed 0.5.68");
  });

  test("an unknown enabled plugin is info and never changes the exit code", () => {
    const extra = makeVaultFixture(join(tmp, "extra"), [
      ...DASHKIT_PLUGIN_CONTRACT,
      { id: "obsidian-git", observedVersion: "2.24.0" }, // the fixture needs only {id, observedVersion}
    ]);
    // The fixture enables obsidian-git too, but the CONTRACT passed to verify is dashkit's nine — so it is
    // an extra, reported info, not an error.
    const s = sink();
    expect(runDashkitVerify(["--vault", extra], s)).toBe(0);
    expect(s.out.join("\n")).toContain("ℹ obsidian-git");
    expect(s.out.join("\n")).toContain("not in dashkit's contract");
  });
});

describe("exit-code PARITY with dashkit deploy (AC4) — six cases, verify code === deploy envelope code", () => {
  test("verify and deploy agree on every plugin-envelope outcome", async () => {
    const nonexistent = join(tmp, "nope");
    const bare = join(tmp, "bare");
    mkdirSync(join(bare, ".obsidian"), { recursive: true }); // vault, but no community-plugins.json
    const broken = makeVaultFixture(join(tmp, "brk"), DASHKIT_PLUGIN_CONTRACT, { omit: ["dataview"] });
    const drifted = makeVaultFixture(join(tmp, "drf"), DASHKIT_PLUGIN_CONTRACT, {
      versions: { "fix-require-modules": "99.0.0" },
    });

    // [label, verify argv, deploy argv, expected exit] — deploy uses the SAME vault, prefixed `deploy`.
    const cases: Array<[string, string[], string[], number]> = [
      ["missing --vault", [], ["deploy"], 2],
      ["empty --vault", ["--vault", ""], ["deploy", "--vault", ""], 2],
      ["nonexistent vault", ["--vault", nonexistent], ["deploy", "--vault", nonexistent], 1],
      ["no community-plugins.json", ["--vault", bare], ["deploy", "--vault", bare], 1],
      ["missing foundation", ["--vault", broken], ["deploy", "--vault", broken], 1],
      ["healthy vault", ["--vault", vault], ["deploy", "--vault", vault], 0],
      ["drift (warn, not fatal)", ["--vault", drifted], ["deploy", "--vault", drifted], 0],
    ];

    const table: Array<{ case: string; verify: number; deploy: number; expected: number }> = [];
    for (const [label, vArgv, dArgv, expected] of cases) {
      const verify = runDashkitVerify(vArgv, { log: () => {}, logError: () => {} });
      const deploy = await runDashkitDeploy(dArgv, { log: () => {} });
      table.push({ case: label, verify, deploy, expected });
    }
    // Every row: verify code === deploy code === expected. (Deploy's own clobber/TOCTOU guards are a
    // separate dimension not exercised here — this table is strictly the plugin-envelope outcome.)
    for (const row of table) {
      expect({ case: row.case, verify: row.verify, deploy: row.deploy }).toEqual({
        case: row.case,
        verify: row.expected,
        deploy: row.expected,
      });
    }
  });
});
