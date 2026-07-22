// plugin-contract tests — the role-keyed severity mapping, PROMOTED here with `verifyPlugins` at
// Story 8.4 (D-2). Every assertion below is byte-identical to the block that lived in
// `src/cn/plugins.test.ts` before the promotion; the only change is that the contract + edge label are
// now passed explicitly (`CN_PLUGIN_CONTRACT, "cn"`) rather than defaulted, because the comparator no
// longer knows any one edge's contract. A test file may import cn's data: `check:core-purity` and
// `check:dep-root` both skip `*.test.ts`, so this import forms no shipped core→cn edge.

import { describe, expect, test } from "bun:test";

import { CN_PLUGIN_CONTRACT } from "../cn/plugins";
import { type VaultPlugins, verifyPlugins } from "./plugin-contract";

/** The contract's own view of a healthy vault: every declared id enabled at its observed version. */
function healthyVault(): VaultPlugins {
  const enabled: string[] = [];
  const versions: Record<string, string> = {};
  for (const e of CN_PLUGIN_CONTRACT) {
    if (e.observedVersion === null) continue; // js-engine — declared absent ON PURPOSE
    enabled.push(e.id);
    versions[e.id] = e.observedVersion;
  }
  return { enabled, versions };
}

/** Severity for one id, or `undefined` if the comparator produced no finding for it at all. */
function sev(findings: ReturnType<typeof verifyPlugins>, id: string): string | undefined {
  return findings.find((f) => f.id === id)?.severity;
}

describe("verifyPlugins — the role-keyed severity mapping", () => {
  test("both foundations present and matching -> ok x2", () => {
    const findings = verifyPlugins(healthyVault(), CN_PLUGIN_CONTRACT, "cn");
    expect(findings.filter((f) => f.severity === "ok").map((f) => f.id)).toEqual([
      "fix-require-modules",
      "dataview",
    ]);
  });

  test("a foundation absent entirely -> error", () => {
    const v = healthyVault();
    const findings = verifyPlugins(
      {
        enabled: v.enabled.filter((id) => id !== "fix-require-modules"),
        versions: Object.fromEntries(
          Object.entries(v.versions).filter(([id]) => id !== "fix-require-modules"),
        ),
      },
      CN_PLUGIN_CONTRACT,
      "cn",
    );
    expect(sev(findings, "fix-require-modules")).toBe("error");
  });

  test("a foundation INSTALLED but disabled -> error (installed is not enabled)", () => {
    const v = healthyVault();
    const findings = verifyPlugins(
      {
        enabled: v.enabled.filter((id) => id !== "fix-require-modules"),
        versions: v.versions, // manifest still on disk — the plugin dir was never removed
      },
      CN_PLUGIN_CONTRACT,
      "cn",
    );
    expect(sev(findings, "fix-require-modules")).toBe("error");
  });

  test("a foundation at a different version -> warn, never error", () => {
    const v = healthyVault();
    const findings = verifyPlugins(
      {
        enabled: v.enabled,
        versions: { ...v.versions, dataview: "0.5.99" },
      },
      CN_PLUGIN_CONTRACT,
      "cn",
    );
    expect(sev(findings, "dataview")).toBe("warn");
    expect(findings.some((f) => f.severity === "error")).toBe(false);
    expect(findings.find((f) => f.id === "dataview")!.message).toContain("0.5.68");
  });

  test("an ambient entry is info, NEVER ok — even at its observed version", () => {
    const findings = verifyPlugins(healthyVault(), CN_PLUGIN_CONTRACT, "cn");
    expect(sev(findings, "table-editor-obsidian")).toBe("info");
    expect(sev(findings, "color-folders-files")).toBe("info");
  });

  test("an ambient entry at a DRIFTED version is still info — versions are never compared", () => {
    const v = healthyVault();
    const findings = verifyPlugins(
      {
        enabled: v.enabled,
        versions: { ...v.versions, "table-editor-obsidian": "9.9.9" },
      },
      CN_PLUGIN_CONTRACT,
      "cn",
    );
    expect(sev(findings, "table-editor-obsidian")).toBe("info");
  });

  test("an enabled id absent from the contract -> info", () => {
    const v = healthyVault();
    const findings = verifyPlugins(
      {
        enabled: [...v.enabled, "obsidian-git"],
        versions: { ...v.versions, "obsidian-git": "2.24.0" },
      },
      CN_PLUGIN_CONTRACT,
      "cn",
    );
    expect(sev(findings, "obsidian-git")).toBe("info");
    // …and it renders AFTER every contract row, so the report order is stable.
    expect(findings[findings.length - 1]!.id).toBe("obsidian-git");
  });

  test("js-engine (observedVersion null, not enabled) -> info, never error, never ok", () => {
    const findings = verifyPlugins(healthyVault(), CN_PLUGIN_CONTRACT, "cn");
    const js = findings.find((f) => f.id === "js-engine")!;
    expect(js.severity).toBe("info");
    expect(js.message).toContain("deliberately absent");
  });

  test("an enabled FOUNDATION with no manifest -> error (registered, not installed)", () => {
    const v = healthyVault();
    const findings = verifyPlugins(
      {
        enabled: v.enabled,
        versions: Object.fromEntries(Object.entries(v.versions).filter(([id]) => id !== "dataview")),
      },
      CN_PLUGIN_CONTRACT,
      "cn",
    );
    expect(sev(findings, "dataview")).toBe("error");
    expect(findings.find((f) => f.id === "dataview")!.message).toContain("no manifest.json");
  });

  test("an enabled AMBIENT with no manifest -> info", () => {
    const v = healthyVault();
    const findings = verifyPlugins(
      {
        enabled: v.enabled,
        versions: Object.fromEntries(
          Object.entries(v.versions).filter(([id]) => id !== "color-folders-files"),
        ),
      },
      CN_PLUGIN_CONTRACT,
      "cn",
    );
    expect(sev(findings, "color-folders-files")).toBe("info");
  });

  test("a DUPLICATE enabled id is reported once, not twice (7.3 review, MINOR 3)", () => {
    // A hand-edited or sync-conflicted community-plugins.json can list an id twice. Reporting it
    // twice also inflated the summary tally, so the printed `ℹ n` disagreed with the vault. This is
    // D-6 fix #2 (the extras loop iterates the Set): reverting it to `observed.enabled` fails HERE.
    const findings = verifyPlugins(
      { enabled: ["obsidian-git", "obsidian-git"], versions: {} },
      CN_PLUGIN_CONTRACT,
      "cn",
    );
    expect(findings.filter((f) => f.id === "obsidian-git")).toHaveLength(1);
  });

  test("an unversioned id absent from the contract -> info", () => {
    const findings = verifyPlugins({ enabled: ["obsidian-git"], versions: {} }, CN_PLUGIN_CONTRACT, "cn");
    expect(sev(findings, "obsidian-git")).toBe("info");
  });

  test("an empty vault -> both foundations error, ambients info, exit-worthy", () => {
    const findings = verifyPlugins({ enabled: [], versions: {} }, CN_PLUGIN_CONTRACT, "cn");
    expect(findings.filter((f) => f.severity === "error").map((f) => f.id)).toEqual([
      "fix-require-modules",
      "dataview",
    ]);
    expect(findings.filter((f) => f.severity === "info")).toHaveLength(3);
    expect(findings.some((f) => f.severity === "ok")).toBe(false);
  });

  test("takes an injected contract — the comparator holds no vault knowledge of its own", () => {
    const findings = verifyPlugins({ enabled: ["x"], versions: { x: "1.0.0" } }, [
      { id: "x", name: "X", role: "foundation", required: true, observedVersion: "1.0.0", why: "test" },
    ], "cn");
    expect(findings).toEqual([
      { id: "x", severity: "ok", message: "X 1.0.0 — foundation present" },
    ]);
  });

  test("is pure — the same input twice yields deeply equal output and mutates nothing", () => {
    const v = healthyVault();
    const before = JSON.stringify(v);
    expect(verifyPlugins(v, CN_PLUGIN_CONTRACT, "cn")).toEqual(verifyPlugins(v, CN_PLUGIN_CONTRACT, "cn"));
    expect(JSON.stringify(v)).toBe(before);
  });
});

describe("verifyPlugins — the edge label is a parameter (Story 8.4 D-3)", () => {
  // The promotion's whole point: the messages that name the edge are threaded, so cn's rendered strings
  // stayed byte-identical AND a second edge gets its OWN name. Same inputs, two labels, two texts.
  const contract = CN_PLUGIN_CONTRACT;

  test("a missing foundation names the EDGE passed in, not a hard-coded 'cn'", () => {
    const empty = { enabled: [] as string[], versions: {} };
    const asCn = verifyPlugins(empty, contract, "cn").find((f) => f.severity === "error")!;
    const asDashkit = verifyPlugins(empty, contract, "dashkit").find((f) => f.severity === "error")!;
    expect(asCn.message).toContain("cn cannot run without it");
    expect(asDashkit.message).toContain("dashkit cannot run without it");
    expect(asDashkit.message).not.toContain("cn cannot run without it");
  });

  test("the ambient-envelope line names the edge passed in", () => {
    const v = healthyVault();
    const asDashkit = verifyPlugins(v, contract, "dashkit").find((f) => f.id === "table-editor-obsidian")!;
    expect(asDashkit.message).toContain("outside dashkit's envelope");
  });

  test("the not-in-contract extras line names the edge passed in", () => {
    const asDashkit = verifyPlugins(
      { enabled: ["obsidian-git"], versions: { "obsidian-git": "2.24.0" } },
      contract,
      "dashkit",
    ).find((f) => f.id === "obsidian-git")!;
    expect(asDashkit.message).toContain("not in dashkit's contract");
  });
});
