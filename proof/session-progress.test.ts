import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addBlocker,
  addDecision,
  addWork,
  completeProgress,
  createProgress,
  getProgressPath,
  listActive,
  loadProgress,
  main,
  saveProgress,
  type SessionProgress,
} from "./session-progress";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "sess-prog-"));
}

// Console capture for the print-only listActive.
let captured: string[] = [];
const realLog = console.log;
function startCapture(): void {
  captured = [];
  console.log = (...a: unknown[]) => {
    captured.push(a.join(" "));
  };
}
afterEach(() => {
  console.log = realLog;
});

describe("session-progress — std substrate swaps (loadJson/saveJson)", () => {
  test("save → load round-trip through fsx (injected temp dir)", () => {
    const dir = tmp();
    createProgress("auth", ["ship login"], dir);
    const p = loadProgress("auth", dir);
    expect(p).not.toBeNull();
    expect(p!.status).toBe("active");
    expect(p!.objectives).toEqual(["ship login"]);
  });

  test("saveJson writes atomically with the documented trailing newline", () => {
    const dir = tmp();
    createProgress("nl", [], dir);
    const raw = readFileSync(getProgressPath("nl", dir), "utf-8");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(JSON.parse(raw).project).toBe("nl");
  });

  test("mutators append + flip status; blocker sets status=blocked", () => {
    const dir = tmp();
    createProgress("feat", ["do a thing"], dir);
    addDecision("feat", "use JWT", "simpler", dir);
    addWork("feat", "model added", ["src/user.ts"], dir);
    addBlocker("feat", "waiting on API key", undefined, dir);
    const p = loadProgress("feat", dir)!;
    expect(p.decisions[0].decision).toBe("use JWT");
    expect(p.work_completed[0].artifacts).toEqual(["src/user.ts"]);
    expect(p.blockers[0].resolution).toBeNull();
    expect(p.status).toBe("blocked");
  });

  test("completeProgress → status completed + handoff stamp", () => {
    const dir = tmp();
    createProgress("done", [], dir);
    completeProgress("done", dir);
    const p = loadProgress("done", dir)!;
    expect(p.status).toBe("completed");
    expect(p.handoff_notes).toContain("Completed at ");
  });

  test("createProgress is safe on re-create — existing file is not clobbered", () => {
    const dir = tmp();
    createProgress("x", ["first"], dir);
    createProgress("x", ["second"], dir); // "already exists" branch
    expect(loadProgress("x", dir)!.objectives).toEqual(["first"]);
  });
});

describe("session-progress — listActive walkFiles convergence", () => {
  test("lists only *-progress.json, skips corrupt, ignores sibling *-features.json", () => {
    const dir = tmp();
    createProgress("alpha", ["a"], dir);
    createProgress("beta", ["b"], dir);
    // A sibling features file (FeatureRegistry's convention) must NOT be listed.
    writeFileSync(join(dir, "gamma-features.json"), JSON.stringify({ project: "gamma" }));
    // A corrupt progress file must be skipped, not throw.
    writeFileSync(join(dir, "broken-progress.json"), "{ not json");

    startCapture();
    listActive(dir);
    const out = captured.join("\n");

    expect(out).toContain("alpha (active)");
    expect(out).toContain("beta (active)");
    expect(out).not.toContain("gamma"); // features file excluded by the predicate
    expect(out).not.toContain("broken"); // corrupt file skipped by loadJson
  });

  test("empty dir → 'No active progress files'", () => {
    const dir = tmp();
    startCapture();
    listActive(dir);
    expect(captured.join("\n")).toContain("No active progress files");
  });
});

describe("session-progress — args/dispatch wiring", () => {
  test("unknown / empty command → help, exit 0", () => {
    startCapture();
    expect(main([])).toBe(0);
    expect(main(["bogus"])).toBe(0);
  });

  test("missing required positional → usage, exit 1", () => {
    expect(main(["create"])).toBe(1);
    expect(main(["decision", "p"])).toBe(1);
    expect(main(["work", "p"])).toBe(1);
    expect(main(["resume"])).toBe(1);
    expect(main(["complete"])).toBe(1);
  });

  test("saveProgress recomputes updated stamp on write", () => {
    const dir = tmp();
    const p: SessionProgress = {
      project: "stamp",
      created: "2026-01-01T00:00:00.000Z",
      updated: "",
      status: "active",
      objectives: [],
      decisions: [],
      work_completed: [],
      blockers: [],
      handoff_notes: "",
      next_steps: [],
    };
    saveProgress(p, dir);
    expect(loadProgress("stamp", dir)!.updated).not.toBe("");
  });
});

// Category 4 (RT-2, AD-9.3): PROGRESS_DIR is captured at import from resolveFrameworkDir(process.env.HOME).
// Re-import under a controlled env (unique query busts Bun's module cache) so we can observe the default.
let rt2Seq = 0;
describe("RT-2 framework-dir resolution — PROGRESS_DIR default", () => {
  const KEYS = ["LIFEOS_DIR", "PAI_DIR", "HOME"] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function progressPathUnder(home: string, seed?: "PAI" | "LIFEOS"): Promise<string> {
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    if (seed) mkdirSync(join(home, ".claude", seed), { recursive: true });
    process.env.HOME = home;
    const mod = await import(`./session-progress?rt2=${rt2Seq++}`);
    return mod.getProgressPath("proj"); // no dir arg → resolves via the module's PROGRESS_DIR default
  }

  test("fresh tree → PROGRESS_DIR under .claude/LIFEOS (the new name)", async () => {
    const home = mkdtempSync(join(tmpdir(), "sess-rt2-"));
    try {
      expect(await progressPathUnder(home)).toBe(
        join(home, ".claude", "LIFEOS", "MEMORY", "STATE", "progress", "proj-progress.json"),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("legacy PAI tree present → PROGRESS_DIR under .claude/PAI (transition window)", async () => {
    const home = mkdtempSync(join(tmpdir(), "sess-rt2-"));
    try {
      expect(await progressPathUnder(home, "PAI")).toBe(
        join(home, ".claude", "PAI", "MEMORY", "STATE", "progress", "proj-progress.json"),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
