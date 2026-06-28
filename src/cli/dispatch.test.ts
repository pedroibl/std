import { describe, expect, test } from "bun:test";

import {
  dispatchSteps,
  formatHelp,
  jsonResult,
  parseArgs,
  run,
  stepVerdict,
  verdictToExit,
} from "./index";
import type { Manifest, Step } from "./index";

/** Build exec steps whose `run` equals the label, so an injected exec can branch on it. */
const steps = (...labels: string[]): Step[] => labels.map((l) => ({ kind: "exec", label: l, run: l }));

/** Capture everything `run` writes to stdout while it executes, restoring console.log after. */
function captureStdout(fn: () => void): string {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

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

describe("parseArgs (Story 4.3 — flags stripped, first non-flag is the command)", () => {
  test("recognizes each flag and the command name in any order", () => {
    expect(parseArgs(["gates"])).toEqual({ command: "gates", keepGoing: false, help: false, json: false });
    expect(parseArgs(["--json", "gates", "--keep-going"])).toEqual({
      command: "gates",
      keepGoing: true,
      help: false,
      json: true,
    });
    expect(parseArgs(["gates", "--help"]).help).toBe(true);
  });

  test("only the FIRST non-flag token is the command; unknown --flags are ignored", () => {
    expect(parseArgs(["gates", "extra", "--unknown"]).command).toBe("gates");
    expect(parseArgs(["--unknown"]).command).toBe("");
  });
});

describe("formatHelp (AC2 — derived from manifest data, not hand-kept)", () => {
  const manifest: Manifest = {
    schemaVersion: 1,
    commands: [
      { name: "gates", steps: steps("lint", "test") },
      { name: "deploy", steps: steps("push") },
    ],
  };

  test("no command → lists every command name", () => {
    const help = formatHelp(manifest);
    expect(help).toContain("gates");
    expect(help).toContain("deploy");
    // names come straight from the manifest — adding a command would show up here, nothing is hand-kept
  });

  test("a known command → lists its name + ordered step labels", () => {
    const help = formatHelp(manifest, "gates");
    expect(help).toContain("gates");
    expect(help).toContain("lint");
    expect(help).toContain("test");
    expect(help.indexOf("lint")).toBeLessThan(help.indexOf("test")); // order preserved
  });

  test("an unknown command name falls back to the full menu", () => {
    expect(formatHelp(manifest, "bogus")).toContain("deploy");
  });
});

describe("run --help / --json (AC2)", () => {
  const manifest: Manifest = {
    schemaVersion: 1,
    commands: [
      { name: "gates", steps: steps("g1", "g2") },
      { name: "brief", steps: steps("b1") },
    ],
  };

  test("--help (no command) prints the menu and exits 0 without running steps", () => {
    let ran = false;
    let code = 0;
    const out = captureStdout(() => {
      code = run(["--help"], manifest, () => {
        ran = true;
        return 0;
      });
    });
    expect(code).toBe(0);
    expect(ran).toBe(false); // help never dispatches
    expect(out).toContain("gates");
    expect(out).toContain("brief");
  });

  test("<command> --help lists that command's steps and exits 0", () => {
    let code = 1;
    const out = captureStdout(() => {
      code = run(["gates", "--help"], manifest, () => 0);
    });
    expect(code).toBe(0);
    expect(out).toContain("g1");
    expect(out).toContain("g2");
  });

  test("--json emits {command, steps[], verdict, exit}; verdicts reflect injected exec codes", () => {
    let code = 0;
    const out = captureStdout(() => {
      code = run(["gates", "--json"], manifest, (r) => (r === "g2" ? 1 : 0));
    });
    expect(code).toBe(1);
    const payload = JSON.parse(out);
    expect(payload).toEqual({
      command: "gates",
      steps: [
        { label: "g1", verdict: "pass" },
        { label: "g2", verdict: "fail" },
      ],
      verdict: "fail",
      exit: 1,
    });
  });

  test("--json + --keep-going runs all steps; fail-fast (no --keep-going) stops early", () => {
    const ff = captureStdout(() => run(["gates", "--json"], manifest, () => 1));
    expect(JSON.parse(ff).steps).toEqual([{ label: "g1", verdict: "fail" }]); // stopped at g1

    const kg = captureStdout(() => run(["gates", "--json", "--keep-going"], manifest, () => 1));
    expect(JSON.parse(kg).steps.map((s: { label: string }) => s.label)).toEqual(["g1", "g2"]); // both ran
  });
});

describe("jsonResult (pure shape builder)", () => {
  test("maps a dispatch result to the json payload incl. exit code", () => {
    const result = dispatchSteps(steps("a"), () => 0);
    expect(jsonResult("x", result)).toEqual({
      command: "x",
      steps: [{ label: "a", verdict: "pass" }],
      verdict: "pass",
      exit: 0,
    });
  });
});

describe("canonical field interpretation (AC3 / AD-1 Rule 6 — no per-name special-casing)", () => {
  test("every exec step's `run` is interpreted identically — only the exec code decides the verdict", () => {
    // Three commands whose step `run` strings differ wildly (a path-like, a glab delegation, a bare word).
    // The engine must treat them the SAME: it shells `run` and reads the exit code. Here a single injected
    // exec returns 0 for all, proving cli core has no name/content-based branch.
    const manifest: Manifest = {
      schemaVersion: 1,
      commands: [
        { name: "deploy", steps: [{ kind: "exec", label: "deploy", run: "scripts/deploy.zsh" }] },
        { name: "mr-threads", steps: [{ kind: "exec", label: "mr-threads", run: "bun x std/glab mr-threads" }] },
        { name: "lint", steps: [{ kind: "exec", label: "lint", run: "lint" }] },
      ],
    };
    const seen: string[] = [];
    const exec = (r: string) => {
      seen.push(r);
      return 0; // identical handling regardless of what `run` contains
    };
    for (const c of manifest.commands) expect(run([c.name], manifest, exec)).toBe(0);
    expect(seen).toEqual(["scripts/deploy.zsh", "bun x std/glab mr-threads", "lint"]);
  });
});
