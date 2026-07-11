import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFeature,
  calculateSummary,
  type Feature,
  generateId,
  getRegistryPath,
  initRegistry,
  loadRegistry,
  main,
  saveRegistry,
} from "./feature-registry";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "feat-reg-"));
}

function feat(id: string, status: Feature["status"], priority: Feature["priority"] = "P2"): Feature {
  return {
    id,
    name: id,
    description: "",
    priority,
    status,
    test_steps: [],
    acceptance_criteria: [],
    blocked_by: [],
    started_at: null,
    completed_at: null,
    notes: [],
  };
}

describe("feature-registry — caller-local logic (kept, not converged)", () => {
  test("calculateSummary — 4-bucket record; in_progress is SILENTLY UNCOUNTED (faithful finding)", () => {
    const features = [
      feat("feat-1", "passing"),
      feat("feat-2", "failing"),
      feat("feat-3", "pending"),
      feat("feat-4", "blocked"),
      feat("feat-5", "in_progress"), // in the 5-state type but tallied nowhere
    ];
    const s = calculateSummary(features);
    expect(s).toEqual({ total: 5, passing: 1, failing: 1, pending: 1, blocked: 1 });
    // total counts all 5, but passing+failing+pending+blocked = 4 — in_progress is the gap.
    expect(s.passing + s.failing + s.pending + s.blocked).toBe(4);
    expect(s.total).toBe(5);
  });

  test("generateId — max feat-N + 1, from a mixed set", () => {
    expect(generateId([])).toBe("feat-1");
    expect(generateId([feat("feat-1", "pending"), feat("feat-7", "pending")])).toBe("feat-8");
  });

  test("getRegistryPath — ${project}-features.json filename convention", () => {
    expect(getRegistryPath("my-app", "/tmp/x")).toBe("/tmp/x/my-app-features.json");
  });
});

describe("feature-registry — std substrate swaps (loadJson/saveJson/ensureDir)", () => {
  test("saveRegistry → loadRegistry round-trip through fsx (injected temp dir)", () => {
    const dir = tmp();
    const reg = {
      project: "demo",
      created: "2026-01-01T00:00:00.000Z",
      updated: "",
      version: "1.0.0",
      features: [feat("feat-1", "passing")],
      completion_summary: { total: 0, passing: 0, failing: 0, pending: 0, blocked: 0 },
    };
    saveRegistry(reg, dir);
    const loaded = loadRegistry("demo", dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.features[0].id).toBe("feat-1");
    // saveRegistry recomputed the summary on write.
    expect(loaded!.completion_summary.passing).toBe(1);
  });

  test("saveJson writes atomically with the documented trailing newline (1-byte delta class)", () => {
    const dir = tmp();
    saveRegistry(
      {
        project: "nl",
        created: "x",
        updated: "",
        version: "1.0.0",
        features: [],
        completion_summary: { total: 0, passing: 0, failing: 0, pending: 0, blocked: 0 },
      },
      dir,
    );
    const raw = readFileSync(getRegistryPath("nl", dir), "utf-8");
    expect(raw.endsWith("}\n")).toBe(true); // fsx.saveJson trailing "\n"
    expect(JSON.parse(raw).project).toBe("nl"); // still valid JSON
  });

  test("loadRegistry — missing file → null (fsx.loadJson fallback)", () => {
    expect(loadRegistry("nope", tmp())).toBeNull();
  });

  test("loadRegistry — corrupt file → null (graceful-degrade convergence)", () => {
    const dir = tmp();
    // saveRegistry then clobber with junk to simulate corruption.
    saveRegistry(
      {
        project: "c",
        created: "x",
        updated: "",
        version: "1.0.0",
        features: [],
        completion_summary: { total: 0, passing: 0, failing: 0, pending: 0, blocked: 0 },
      },
      dir,
    );
    Bun.write(getRegistryPath("c", dir), "{ not json");
    expect(loadRegistry("c", dir)).toBeNull();
  });

  test("init → add → load integration (injected temp dir; ensureDir creates the tree)", () => {
    const dir = join(tmp(), "nested", "progress"); // ensureDir must create parents
    initRegistry("app", dir);
    addFeature("app", "Auth", "login", "P1", [], [], dir);
    const reg = loadRegistry("app", dir);
    expect(reg!.features).toHaveLength(1);
    expect(reg!.features[0]).toMatchObject({ id: "feat-1", name: "Auth", priority: "P1", status: "pending" });
    expect(reg!.completion_summary.pending).toBe(1);
  });

  test("initRegistry is idempotent-safe — second init leaves the registry intact", () => {
    const dir = tmp();
    initRegistry("dup", dir);
    addFeature("dup", "One", "", "P2", [], [], dir);
    initRegistry("dup", dir); // "already exists" branch — must NOT wipe
    expect(loadRegistry("dup", dir)!.features).toHaveLength(1);
  });
});

describe("feature-registry — args/dispatch wiring (no default-dir side effects)", () => {
  test("unknown / empty command → help, exit 0", () => {
    expect(main([])).toBe(0);
    expect(main(["bogus"])).toBe(0);
  });

  test("missing required positional → usage, exit 1", () => {
    expect(main(["init"])).toBe(1);
    expect(main(["add", "onlyproject"])).toBe(1);
    expect(main(["update", "onlyproject"])).toBe(1);
    expect(main(["list"])).toBe(1);
  });
});
