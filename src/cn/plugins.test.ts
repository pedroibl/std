import { describe, expect, test } from "bun:test";

import { CN_PLUGIN_CONTRACT, type VaultPlugins, verifyPlugins } from "./plugins";

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

describe("CN_PLUGIN_CONTRACT", () => {
  test("declares all five rows, two of them cn's required foundations", () => {
    expect(CN_PLUGIN_CONTRACT.map((e) => e.id)).toEqual([
      "fix-require-modules",
      "dataview",
      "table-editor-obsidian",
      "color-folders-files",
      "js-engine",
    ]);
    const foundations = CN_PLUGIN_CONTRACT.filter((e) => e.role === "foundation");
    expect(foundations.map((e) => e.id)).toEqual(["fix-require-modules", "dataview"]);
    // `required` and `role: "foundation"` must not drift apart — the severity mapping keys on role,
    // and a required-but-ambient row would be silently un-enforced.
    for (const e of CN_PLUGIN_CONTRACT) expect(e.required).toBe(e.role === "foundation");
  });

  test("names no vault anywhere — a vault literal here is a SILENT D4/NFR3 violation", () => {
    // 7.1 closed the gate hole by adding both vault names to CONSUMER_NAMES, so a bare `zDrafts`
    // WOULD now redden the build. This asserts the half the gate still cannot see: a home-relative or
    // iCloud-shaped path fragment smuggled into prose. (`/Scripts/cn.js` is deliberately allowed — it
    // is vault-RELATIVE, the same string CST resolves, and names no particular vault.)
    // Test files are exempt from the gate (fixtures plant identifiers deliberately), so naming the two
    // vaults here is safe and is exactly what makes this assertion able to fail.
    for (const e of CN_PLUGIN_CONTRACT) {
      const blob = `${e.id} ${e.name} ${e.why}`;
      expect(blob).not.toMatch(/~|\.obsidian|CloudDocs|Mobile Documents|zDrafts|note-report/);
    }
  });

  test("js-engine is declared absent, never omitted", () => {
    const js = CN_PLUGIN_CONTRACT.find((e) => e.id === "js-engine")!;
    expect(js.role).toBe("ambient");
    expect(js.required).toBe(false);
    expect(js.observedVersion).toBeNull();
  });
});

describe("verifyPlugins — the role-keyed severity mapping", () => {
  test("both foundations present and matching -> ok x2", () => {
    const findings = verifyPlugins(healthyVault());
    expect(findings.filter((f) => f.severity === "ok").map((f) => f.id)).toEqual([
      "fix-require-modules",
      "dataview",
    ]);
  });

  test("a foundation absent entirely -> error", () => {
    const v = healthyVault();
    const findings = verifyPlugins({
      enabled: v.enabled.filter((id) => id !== "fix-require-modules"),
      versions: Object.fromEntries(
        Object.entries(v.versions).filter(([id]) => id !== "fix-require-modules"),
      ),
    });
    expect(sev(findings, "fix-require-modules")).toBe("error");
  });

  test("a foundation INSTALLED but disabled -> error (installed is not enabled)", () => {
    const v = healthyVault();
    const findings = verifyPlugins({
      enabled: v.enabled.filter((id) => id !== "fix-require-modules"),
      versions: v.versions, // manifest still on disk — the plugin dir was never removed
    });
    expect(sev(findings, "fix-require-modules")).toBe("error");
  });

  test("a foundation at a different version -> warn, never error", () => {
    const v = healthyVault();
    const findings = verifyPlugins({
      enabled: v.enabled,
      versions: { ...v.versions, dataview: "0.5.99" },
    });
    expect(sev(findings, "dataview")).toBe("warn");
    expect(findings.some((f) => f.severity === "error")).toBe(false);
    expect(findings.find((f) => f.id === "dataview")!.message).toContain("0.5.68");
  });

  test("an ambient entry is info, NEVER ok — even at its observed version", () => {
    const findings = verifyPlugins(healthyVault());
    expect(sev(findings, "table-editor-obsidian")).toBe("info");
    expect(sev(findings, "color-folders-files")).toBe("info");
  });

  test("an ambient entry at a DRIFTED version is still info — versions are never compared", () => {
    const v = healthyVault();
    const findings = verifyPlugins({
      enabled: v.enabled,
      versions: { ...v.versions, "table-editor-obsidian": "9.9.9" },
    });
    expect(sev(findings, "table-editor-obsidian")).toBe("info");
  });

  test("an enabled id absent from the contract -> info", () => {
    const v = healthyVault();
    const findings = verifyPlugins({
      enabled: [...v.enabled, "obsidian-git"],
      versions: { ...v.versions, "obsidian-git": "2.24.0" },
    });
    expect(sev(findings, "obsidian-git")).toBe("info");
    // …and it renders AFTER every contract row, so the report order is stable.
    expect(findings[findings.length - 1]!.id).toBe("obsidian-git");
  });

  test("js-engine (observedVersion null, not enabled) -> info, never error, never ok", () => {
    const findings = verifyPlugins(healthyVault());
    const js = findings.find((f) => f.id === "js-engine")!;
    expect(js.severity).toBe("info");
    expect(js.message).toContain("deliberately absent");
  });

  test("an enabled FOUNDATION with no manifest -> error (registered, not installed)", () => {
    const v = healthyVault();
    const findings = verifyPlugins({
      enabled: v.enabled,
      versions: Object.fromEntries(Object.entries(v.versions).filter(([id]) => id !== "dataview")),
    });
    expect(sev(findings, "dataview")).toBe("error");
    expect(findings.find((f) => f.id === "dataview")!.message).toContain("no manifest.json");
  });

  test("an enabled AMBIENT with no manifest -> info", () => {
    const v = healthyVault();
    const findings = verifyPlugins({
      enabled: v.enabled,
      versions: Object.fromEntries(
        Object.entries(v.versions).filter(([id]) => id !== "color-folders-files"),
      ),
    });
    expect(sev(findings, "color-folders-files")).toBe("info");
  });

  test("an unversioned id absent from the contract -> info", () => {
    const findings = verifyPlugins({ enabled: ["obsidian-git"], versions: {} });
    expect(sev(findings, "obsidian-git")).toBe("info");
  });

  test("an empty vault -> both foundations error, ambients info, exit-worthy", () => {
    const findings = verifyPlugins({ enabled: [], versions: {} });
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
    ]);
    expect(findings).toEqual([
      { id: "x", severity: "ok", message: "X 1.0.0 — foundation present" },
    ]);
  });

  test("is pure — the same input twice yields deeply equal output and mutates nothing", () => {
    const v = healthyVault();
    const before = JSON.stringify(v);
    expect(verifyPlugins(v)).toEqual(verifyPlugins(v));
    expect(JSON.stringify(v)).toBe(before);
  });
});
