import { describe, expect, test } from "bun:test";

import { dispatchSteps, run, type Manifest, type Step } from "./index";

/** Build steps whose `run` equals the label, so an injected exec can branch on it. */
const steps = (...labels: string[]): Step[] => labels.map((l) => ({ label: l, run: l }));

describe("dispatchSteps (Story 4.1 — ordered, fail-fast, SKIP-as-green)", () => {
  test("runs every step in order when all pass → 0", () => {
    const seen: string[] = [];
    const code = dispatchSteps(steps("a", "b", "c"), (r) => {
      seen.push(r);
      return 0;
    });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(code).toBe(0);
  });

  test("fail-fast: stops at the first non-zero step and returns 1", () => {
    const seen: string[] = [];
    const code = dispatchSteps(steps("a", "b", "c"), (r) => {
      seen.push(r);
      return r === "b" ? 1 : 0;
    });
    expect(seen).toEqual(["a", "b"]); // "c" never runs
    expect(code).toBe(1);
  });

  test("SKIP-as-green: a step exiting 0 (skipped or did work) counts as pass", () => {
    expect(dispatchSteps(steps("skipme", "didwork"), () => 0)).toBe(0);
  });

  test("any non-zero normalizes the verdict to 1 (NFR8 — codes are 0/1)", () => {
    expect(dispatchSteps(steps("boom"), () => 127)).toBe(1);
  });

  test("an empty command is vacuously green", () => {
    expect(dispatchSteps([], () => 1)).toBe(0);
  });
});

describe("run (command lookup)", () => {
  const manifest: Manifest = {
    commands: [
      { name: "gates", steps: steps("g1", "g2") },
      { name: "brief", steps: steps("b1") },
    ],
  };

  test("dispatches a known command and returns its 0/1 verdict", () => {
    expect(run(["gates"], manifest, () => 0)).toBe(0);
    expect(run(["gates"], manifest, (r) => (r === "g2" ? 1 : 0))).toBe(1);
  });

  test("unknown command (or empty argv) → exit 2", () => {
    expect(run(["nope"], manifest, () => 0)).toBe(2);
    expect(run([], manifest, () => 0)).toBe(2);
  });
});
