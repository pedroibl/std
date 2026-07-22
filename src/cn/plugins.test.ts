import { describe, expect, test } from "bun:test";

import { CN_PLUGIN_CONTRACT } from "./plugins";

// The COMPARATOR tests (`verifyPlugins — the role-keyed severity mapping`) moved to
// `src/core/plugin-contract.test.ts` when `verifyPlugins` was promoted to core (Story 8.4 D-2), each
// assertion byte-identical. This file keeps the CONTRACT-SHAPE tests: they belong with cn's data.

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

  test("ids are UNIQUE — the invariant is mechanical, not implied by the id snapshot", () => {
    // `scripts/STD_CONSUMERS.ts` is the shape this contract mirrors: data PLUS a test that makes its
    // invariant mechanical. Without this, a duplicate row (say a second `dataview` marked ambient)
    // produces BOTH `ok` and `info` for one id — and the only thing that noticed was a hard-coded
    // five-id snapshot, which states an inventory, not a rule.
    const ids = CN_PLUGIN_CONTRACT.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("js-engine is declared absent, never omitted", () => {
    const js = CN_PLUGIN_CONTRACT.find((e) => e.id === "js-engine")!;
    expect(js.role).toBe("ambient");
    expect(js.required).toBe(false);
    expect(js.observedVersion).toBeNull();
  });
});
