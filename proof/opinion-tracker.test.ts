import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Ctx,
  addEvidence,
  addOpinion,
  confidenceBar,
  defaultCtx,
  main,
  parseOpinions,
} from "./opinion-tracker";
import { getMetaField } from "std/core";

// ── hermetic fixture ───────────────────────────────────────────────────────────────────────────────

let dir: string;
let ctx: Ctx;
const FIXED_NOW = new Date("2026-07-12T09:30:00.000Z"); // UTC → month 2026-07, day 2026-07-12

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opinion-tracker-"));
  ctx = {
    opinionsFile: join(dir, "OPINIONS.md"),
    relationshipLog: join(dir, "RELATIONSHIP"),
    now: FIXED_NOW,
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── bar byte-parity (the load-bearing conversion) ────────────────────────────────────────────────────

describe("confidenceBar — byte-parity with the original inline track", () => {
  // The original: `"█".repeat(round(c*10)) + "░".repeat(10 - round(c*10))`.
  const original = (c: number) =>
    "█".repeat(Math.round(c * 10)) + "░".repeat(10 - Math.round(c * 10));

  const cases = [0.01, 0.05, 0.1, 0.24, 0.25, 0.5, 0.55, 0.85, 0.94, 0.95, 0.99];

  for (const c of cases) {
    test(`c=${c} matches the original glyph run`, () => {
      expect(confidenceBar(c)).toBe(original(c));
    });
  }

  test("track is exactly 10 glyphs and unbracketed (caller wraps with `[…]`)", () => {
    const b = confidenceBar(0.5);
    expect([...b].length).toBe(10);
    expect(b.startsWith("[")).toBe(false);
    expect(b).toBe("█████░░░░░");
  });

  test("boundary values clamp like the original (0.01→empty-ish, 0.99→full)", () => {
    expect(confidenceBar(0.01)).toBe("░░░░░░░░░░"); // round(0.1) = 0
    expect(confidenceBar(0.99)).toBe("██████████"); // round(9.9) = 10
  });
});

// ── arg dispatch for the main commands ───────────────────────────────────────────────────────────────

describe("main — arg dispatch (positional/dispatch/flagValue/hasFlag)", () => {
  test("unknown/empty command → help, exit 0", () => {
    expect(main([], ctx)).toBe(0);
    expect(main(["bogus"], ctx)).toBe(0);
  });

  test("add without a statement → usage, exit 1", () => {
    expect(main(["add"], ctx)).toBe(1);
    expect(existsSync(ctx.opinionsFile)).toBe(false);
  });

  test("add writes a structured block with the default confidence + category flag", () => {
    expect(main(["add", "Pedro prefers concise", "--category", "communication"], ctx)).toBe(0);
    const md = readFileSync(ctx.opinionsFile, "utf-8");
    expect(md).toContain("### Pedro prefers concise");
    expect(md).toContain("**Confidence:** 0.50");
  });

  test("add supports the --category=value form (flagValue superset of the origin's indexOf)", () => {
    // `flagValue` accepts BOTH `--category technical` and `--category=technical`; the origin's
    // `indexOf('--category')` only handled the space form. We prove the `=`-form flows through to
    // addOpinion via the stdout confirmation line — NOT via a parseOpinions round-trip: the origin
    // (faithfully preserved here) does not persist category in a parseable way (parseOpinions reads a
    // `## <Cat> Opinions` heading that appendOpinionToFile never writes), so a round-trip always
    // reports the "relationship" default regardless of the flag.
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    try {
      expect(main(["add", "Uses tabs", "--category=technical"], ctx)).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(logs.join("\n")).toContain('✅ Added opinion: "Uses tabs" (technical, confidence: 50%)');
    // And the faithful round-trip still yields the un-persisted default:
    expect(parseOpinions(ctx).get("uses tabs")?.category).toBe("relationship");
  });

  test("evidence with no type flag → usage, exit 1", () => {
    main(["add", "X"], ctx);
    expect(main(["evidence", "X"], ctx)).toBe(1);
  });

  test("evidence on a missing opinion → caught error, exit 1", () => {
    expect(main(["evidence", "nope", "--supporting", "because"], ctx)).toBe(1);
  });

  test("supporting evidence bumps confidence 0.50 → 0.52 and persists", () => {
    main(["add", "X"], ctx);
    expect(main(["evidence", "X", "--supporting", "went well"], ctx)).toBe(0);
    const parsed = parseOpinions(ctx).get("x");
    expect(parsed?.confidence).toBeCloseTo(0.52, 5);
    const md = readFileSync(ctx.opinionsFile, "utf-8");
    expect(md).toContain("| Supporting | went well |");
  });

  test("show found → 0, missing → 1", () => {
    main(["add", "X"], ctx);
    expect(main(["show", "X"], ctx)).toBe(0);
    expect(main(["show", "does not exist"], ctx)).toBe(1);
  });

  test("list → 0", () => {
    main(["add", "X"], ctx);
    expect(main(["list"], ctx)).toBe(0);
  });
});

// ── Confidence round-trip via getMetaField ───────────────────────────────────────────────────────────

describe("Confidence round-trip (getMetaField-backed parse)", () => {
  test("added confidence reads back through parseOpinions", () => {
    addOpinion(ctx, "Round trips cleanly", "technical");
    const parsed = parseOpinions(ctx).get("round trips cleanly");
    expect(parsed?.confidence).toBe(0.5);
  });

  test("getMetaField reads the raw **Confidence:** value the writer emits", () => {
    addOpinion(ctx, "S", "relationship");
    const block = readFileSync(ctx.opinionsFile, "utf-8");
    // The exact getMetaField primitive the tool uses for the read half:
    expect(getMetaField(block, "Confidence")).toBe("0.50");
    expect(Number(getMetaField(block, "Confidence"))).toBe(0.5);
  });

  test("evidence bump is reflected in the getMetaField-read confidence", () => {
    addOpinion(ctx, "S", "relationship");
    addEvidence(ctx, "S", "counter", "did not land");
    const block = readFileSync(ctx.opinionsFile, "utf-8");
    expect(getMetaField(block, "Confidence")).toBe("0.45"); // 0.50 - 0.05
    expect(parseOpinions(ctx).get("s")?.confidence).toBeCloseTo(0.45, 5);
  });
});

// ── relationship audit log (appendAudit, UTC month dir) ──────────────────────────────────────────────

describe("logRelationshipEvent → appendAudit under the UTC month dir", () => {
  test("add drops a JSONL audit line at RELATIONSHIP/<utc-month>/<utc-day>.jsonl", () => {
    addOpinion(ctx, "Logs an event", "work_style");
    const logFile = join(ctx.relationshipLog, "2026-07", "2026-07-12.jsonl");
    expect(existsSync(logFile)).toBe(true);
    const line = readFileSync(logFile, "utf-8").trim();
    const rec = JSON.parse(line);
    expect(rec.event_type).toBe("opinion_created");
    expect(rec.timestamp).toBe(FIXED_NOW.toISOString());
    expect(rec.statement).toBe("Logs an event");
  });
});

// ── RT-2 framework-dir resolution (AD-9.3) ───────────────────────────────────────────────────────────

describe("RT-2 framework-dir resolution (AD-9.3)", () => {
  // ambient shell may export a real PAI_DIR — control LIFEOS_DIR+PAI_DIR+HOME explicitly and restore.
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

  test("LIFEOS_DIR wins over PAI_DIR — BOTH opinionsFile and relationshipLog hang off the framework dir", () => {
    process.env.LIFEOS_DIR = "/life";
    process.env.PAI_DIR = "/pai";
    const c = defaultCtx();
    expect(c.opinionsFile).toBe(join("/life", "USER/OPINIONS.md"));
    // Deliberate RT-2 behavior shift: relationshipLog now hangs off the framework dir, not the old
    // <home>/.claude/MEMORY/RELATIONSHIP. This documents that shift.
    expect(c.relationshipLog).toBe(join("/life", "MEMORY/RELATIONSHIP"));
  });

  test("PAI_DIR honored when LIFEOS_DIR unset", () => {
    delete process.env.LIFEOS_DIR;
    process.env.PAI_DIR = "/pai";
    expect(defaultCtx().opinionsFile).toBe(join("/pai", "USER/OPINIONS.md"));
  });

  test("neither env set → resolver falls back to LIFEOS under a fresh temp home", () => {
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    const home = mkdtempSync(join(tmpdir(), "rt2-"));
    process.env.HOME = home;
    try {
      const c = defaultCtx();
      expect(c.opinionsFile).toBe(join(home, ".claude", "LIFEOS", "USER/OPINIONS.md"));
      expect(c.relationshipLog).toBe(join(home, ".claude", "LIFEOS", "MEMORY/RELATIONSHIP"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("legacy PAI tree present → resolver picks PAI", () => {
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    const home = mkdtempSync(join(tmpdir(), "rt2-"));
    mkdirSync(join(home, ".claude", "PAI"), { recursive: true });
    process.env.HOME = home;
    try {
      expect(defaultCtx().opinionsFile).toBe(join(home, ".claude", "PAI", "USER/OPINIONS.md"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
