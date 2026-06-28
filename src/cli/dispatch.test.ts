import { describe, expect, test } from "bun:test";

import { dispatchSteps, run, stepVerdict, verdictToExit } from "./index";
import type { Manifest, Step } from "./index";

/** Build exec steps whose `run` equals the label, so an injected exec can branch on it. */
const steps = (...labels: string[]): Step[] => labels.map((l) => ({ kind: "exec", label: l, run: l }));

describe("dispatchSteps (Story 4.2 — ordered, fail-fast, verdict-aware)", () => {
  test("runs every step in order when all pass → verdict pass", () => {
    const seen: string[] = [];
    const result = dispatchSteps(steps("a", "b", "c"), (r) => {
      seen.push(r);
      return 0;
    });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(result.verdict).toBe("pass");
    expect(result.steps.map((s) => s.verdict)).toEqual(["pass", "pass", "pass"]);
  });

  test("fail-fast: stops at the first failing step → verdict fail", () => {
    const seen: string[] = [];
    const result = dispatchSteps(steps("a", "b", "c"), (r) => {
      seen.push(r);
      return r === "b" ? 1 : 0;
    });
    expect(seen).toEqual(["a", "b"]); // "c" never runs
    expect(result.verdict).toBe("fail");
  });

  test("--keep-going: runs ALL steps and aggregates to fail", () => {
    const seen: string[] = [];
    const result = dispatchSteps(
      steps("a", "b", "c"),
      (r) => {
        seen.push(r);
        return r === "b" ? 1 : 0;
      },
      { keepGoing: true },
    );
    expect(seen).toEqual(["a", "b", "c"]); // all ran despite "b" failing
    expect(result.verdict).toBe("fail");
    expect(result.steps.map((s) => s.verdict)).toEqual(["pass", "fail", "pass"]);
  });

  test("SKIP-as-green: a step exiting 0 counts as pass", () => {
    expect(dispatchSteps(steps("skipme", "didwork"), () => 0).verdict).toBe("pass");
  });

  test("any non-zero exit normalizes to a fail verdict (NFR8)", () => {
    expect(dispatchSteps(steps("boom"), () => 127).verdict).toBe("fail");
  });

  test("an empty command is vacuously pass", () => {
    expect(dispatchSteps([], () => 1).verdict).toBe("pass");
  });
});

describe("stepVerdict (NFR3 assertion 3 — branch ONLY on kind, never on content)", () => {
  test("two steps with identical content but different exec codes → different verdicts", () => {
    const a: Step = { kind: "exec", label: "x", run: "same" };
    const b: Step = { kind: "exec", label: "y", run: "same" };
    // identical `run`, yet the verdict tracks the exec code — not the content
    expect(stepVerdict(a, () => 0)).toBe("pass");
    expect(stepVerdict(b, () => 1)).toBe("fail");
  });
});

describe("verdictToExit (NFR8 — 0/1 codes)", () => {
  test("pass and skip → 0, fail → 1", () => {
    expect(verdictToExit("pass")).toBe(0);
    expect(verdictToExit("skip")).toBe(0);
    expect(verdictToExit("fail")).toBe(1);
  });
});

describe("run (command lookup + flags)", () => {
  const manifest: Manifest = {
    schemaVersion: 1,
    commands: [
      { name: "gates", steps: steps("g1", "g2") },
      { name: "brief", steps: steps("b1") },
    ],
  };

  test("dispatches a known command and returns its 0/1 exit", () => {
    expect(run(["gates"], manifest, () => 0)).toBe(0);
    expect(run(["gates"], manifest, (r) => (r === "g2" ? 1 : 0))).toBe(1);
  });

  test("--keep-going is not mistaken for a command; it overrides fail-fast", () => {
    const seen: string[] = [];
    const code = run(["gates", "--keep-going"], manifest, (r) => {
      seen.push(r);
      return r === "g1" ? 1 : 0;
    });
    expect(seen).toEqual(["g1", "g2"]); // both ran
    expect(code).toBe(1);
  });

  test("unknown command (or empty argv) → exit 2", () => {
    expect(run(["nope"], manifest, () => 0)).toBe(2);
    expect(run([], manifest, () => 0)).toBe(2);
  });
});
