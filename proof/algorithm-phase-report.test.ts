import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFrameworkDir } from "std/fsx";
import { main, readState, stateFile, writeState } from "./algorithm-phase-report";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "algo-phase-"));
}

describe("algorithm-phase-report — readState (the one loadJson) + degenerate reset", () => {
  test("missing file → DEFAULT_STATE (IDLE)", () => {
    const s = readState(tmp());
    expect(s.currentPhase).toBe("IDLE");
    expect(s.active).toBe(false);
    expect(s.criteria).toEqual([]);
  });

  test("empty file → default (loadJson: JSON.parse('') throws → fallback)", () => {
    const dir = tmp();
    writeFileSync(stateFile(dir), "");
    expect(readState(dir).currentPhase).toBe("IDLE");
  });

  test("literal '{}' → default (caller-local degenerate guard, faithful to raw==='{}')", () => {
    const dir = tmp();
    writeFileSync(stateFile(dir), "{}");
    expect(readState(dir).currentPhase).toBe("IDLE");
  });

  test("corrupt JSON → default (loadJson fallback)", () => {
    const dir = tmp();
    writeFileSync(stateFile(dir), "{ not json");
    expect(readState(dir).currentPhase).toBe("IDLE");
  });

  test("valid state → loaded verbatim", () => {
    const dir = tmp();
    const s = readState(dir);
    s.currentPhase = "OBSERVE";
    s.taskDescription = "auth";
    writeState(s, dir);
    const back = readState(dir);
    expect(back.currentPhase).toBe("OBSERVE");
    expect(back.taskDescription).toBe("auth");
  });
});

describe("algorithm-phase-report — writeState via fsx", () => {
  test("saveJson writes atomically with a trailing newline; still valid JSON", () => {
    const dir = tmp();
    writeState(readState(dir), dir);
    const raw = readFileSync(stateFile(dir), "utf-8");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(JSON.parse(raw).currentPhase).toBe("IDLE");
  });
});

describe("algorithm-phase-report — dispatch + flagValue command wiring", () => {
  test("phase command writes state + appends phaseHistory", () => {
    const dir = tmp();
    expect(main(["phase", "--phase", "OBSERVE", "--task", "Auth rebuild", "--sla", "Standard"], dir)).toBe(0);
    const s = readState(dir);
    expect(s.currentPhase).toBe("OBSERVE");
    expect(s.taskDescription).toBe("Auth rebuild");
    expect(s.active).toBe(true);
    expect(s.phaseHistory.at(-1)?.phase).toBe("OBSERVE");
  });

  test("--k=v equals form works (flagValue superset over the old getArg)", () => {
    const dir = tmp();
    expect(main(["phase", "--phase=DESIGN"], dir)).toBe(0);
    expect(readState(dir).currentPhase).toBe("DESIGN");
  });

  test("criterion add + update by id", () => {
    const dir = tmp();
    main(["criterion", "--id", "1", "--desc", "JWT rejects expired", "--status", "pending"], dir);
    main(["criterion", "--id", "1", "--status", "completed", "--evidence", "tests pass"], dir);
    const c = readState(dir).criteria.find((x) => x.id === "1");
    expect(c?.status).toBe("completed");
    expect(c?.evidence).toBe("tests pass");
  });

  test("config --params merges parsed JSON (extractJson)", () => {
    const dir = tmp();
    expect(main(["config", "--params", '{"selectionPressure":0.3,"stepSize":0.5}'], dir)).toBe(0);
    expect(readState(dir).algorithmConfig?.params).toEqual({ selectionPressure: 0.3, stepSize: 0.5 });
  });

  test("config --params invalid JSON → exit 1, state NOT written", () => {
    const dir = tmp();
    expect(main(["config", "--params", "not json at all"], dir)).toBe(1);
    // no write happened → file absent → readState still default
    expect(readState(dir).algorithmConfig).toBeUndefined();
  });

  test("no command → usage, exit 0", () => {
    expect(main([], tmp())).toBe(0);
  });

  test("unknown command → exit 1, no write", () => {
    const dir = tmp();
    expect(main(["bogus"], dir)).toBe(1);
    expect(readState(dir).currentPhase).toBe("IDLE"); // nothing written
  });

  test("phase without --phase → exit 1, no write", () => {
    const dir = tmp();
    expect(main(["phase"], dir)).toBe(1);
    expect(readState(dir).currentPhase).toBe("IDLE");
  });

  test("meta-adjust requires --param/--from/--to/--cycle", () => {
    const dir = tmp();
    expect(main(["meta-adjust", "--param", "x", "--from", "0.3"], dir)).toBe(1);
    expect(
      main(["meta-adjust", "--param", "x", "--from", "0.3", "--to", "0.45", "--cycle", "2"], dir),
    ).toBe(0);
    const adj = readState(dir).metaLearnerAdjustments?.[0];
    expect(adj).toMatchObject({ parameter: "x", previousValue: 0.3, newValue: 0.45, cycle: 2 });
  });
});

// Category 4 (RT-2, AD-9.3): STATE_DIR is `join(resolveFrameworkDir(homedir()), "MEMORY", "STATE")`.
// homedir() is fixed (Bun ignores $HOME), so we prove the WIRING: the default resolves via the resolver,
// never a bare `.claude/PAI` literal. The resolver's own LIFEOS>PAI>fallback precedence is covered
// exhaustively in src/fsx/index.test.ts.
describe("RT-2 framework-dir resolution — STATE_DIR wired to resolveFrameworkDir", () => {
  test("stateFile() default resolves under resolveFrameworkDir(homedir()), not a bare .claude/PAI literal", () => {
    expect(stateFile()).toBe(join(resolveFrameworkDir(homedir()), "MEMORY", "STATE", "algorithm-phase.json"));
  });
});
