import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNdjson } from "std/core";
import { classify, chunkSource, buildProposals, collectSources, main, RULES, type Target, type Proposal } from "./migrate-scan";

// ─── Parity oracle: the ORIGINAL classify (verbatim from ~/.claude/PAI/Tools/MigrateScan.ts) ───
// Kept here so the scoreRules-based rewrite is proven target- AND confidence-identical.

function classifyOriginal(body: string): { target: Target; confidence: number; reasons: string[]; alternatives: Target[] } {
  const scores: Record<string, { score: number; reasons: string[] }> = {};
  for (const rule of RULES) {
    let hits = 0;
    const matched: string[] = [];
    for (const p of rule.patterns) {
      const m = body.match(p);
      if (m) {
        hits += 1;
        matched.push(`matched /${p.source}/`);
      }
    }
    if (hits > 0) {
      scores[rule.target] = scores[rule.target] || { score: 0, reasons: [] };
      scores[rule.target].score += hits * rule.weight;
      scores[rule.target].reasons.push(...matched);
    }
  }
  const entries = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
  if (entries.length === 0) {
    return { target: "UNCLEAR" as Target, confidence: 0, reasons: ["no patterns matched"], alternatives: [] };
  }
  const top = entries[0];
  const runnerUp = entries[1];
  const totalScore = top[1].score;
  const runnerUpScore = runnerUp ? runnerUp[1].score : 0;
  const margin = totalScore - runnerUpScore;
  const confidence = Math.min(1, (margin + totalScore * 0.3) / 10);
  return {
    target: top[0] as Target,
    confidence,
    reasons: top[1].reasons.slice(0, 3),
    alternatives: entries.slice(1, 4).map(([t]) => t as Target),
  };
}

const FIXED_NOW = new Date("2026-07-12T00:00:00.000Z");

// Representative inputs exercising several targets, ties, multi-rule, and no-match.
const SAMPLES = [
  "My mission and north-star is my life's work — the why I build.",
  "The goal is to hit the milestone by end of 2026, we aim to target growth.",
  "I believe in the core belief; my conviction is that we solve every problem.",
  "I learned that hard-won insight is a rule of thumb worth an aphorism.",
  "Revenue is $50k MRR, net worth up, income and runway extended.",
  "My partner and family, my children and friends, tier-A relationships.",
  "Always never do use includes rule: from now on when you help me.",
  "the quick brown fox jumps lazily over nothing in particular here today",
  "I am experienced; my role and my background: I work as a builder.",
  "A mental model and framework, a heuristic — my way of thinking about strategy and approach.",
];

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "migrate-scan-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("classify — scoreRules parity with original", () => {
  it("yields the SAME target + confidence + reasons + alternatives on representative inputs", () => {
    for (const s of SAMPLES) {
      const got = classify(s);
      const want = classifyOriginal(s);
      expect(got.target).toBe(want.target);
      expect(got.confidence).toBe(want.confidence);
      expect(got.reasons).toEqual(want.reasons);
      expect(got.alternatives).toEqual(want.alternatives);
    }
  });

  it("returns UNCLEAR at 0 confidence when nothing matches", () => {
    const r = classify("zzz qqq vvv nnn");
    expect(r.target).toBe("UNCLEAR");
    expect(r.confidence).toBe(0);
    expect(r.reasons).toEqual(["no patterns matched"]);
    expect(r.alternatives).toEqual([]);
  });
});

describe("chunkSource — markdown chunking with basename:heading labels", () => {
  it("splits on H2/H3 with preamble + heading labels", () => {
    const content = "intro para long enough to survive\n\n## Alpha\nbody a here\n\n### Beta\nbody b here";
    const chunks = chunkSource("notes.md", content);
    expect(chunks.map((c) => c.section)).toEqual([
      "notes.md:preamble",
      "notes.md:Alpha",
      "notes.md:Beta",
    ]);
  });

  it("falls back to paragraph groups when no headings", () => {
    const content = "first paragraph that is definitely over thirty characters long here\n\nsecond paragraph also well over thirty characters in length here";
    const chunks = chunkSource("plain.txt", content);
    expect(chunks.map((c) => c.section)).toEqual(["plain.txt:p1", "plain.txt:p2"]);
  });
});

describe("NDJSON queue append round-trips via parseNdjson", () => {
  it("writes proposals to the queue then reads them back with identical wire fields", () => {
    const src = tmp();
    const srcFile = join(src, "input.md");
    writeFileSync(
      srcFile,
      "## Mission\nMy mission and north-star, my life's work and why I build.\n\n## Money\nRevenue is $80k MRR and net worth climbing with income.\n",
    );
    const queueDir = tmp();
    const queueFile = join(queueDir, "nested", "migration-proposals.jsonl");

    const built = buildProposals(collectSources(srcFile, false), FIXED_NOW);
    expect(built.length).toBeGreaterThan(0);

    const code = main(["--source", srcFile], { queueFile, now: FIXED_NOW });
    expect(code).toBe(0);

    const raw = readFileSync(queueFile, "utf-8");
    // one-object-per-line NDJSON framing with trailing newline per record
    expect(raw.endsWith("\n")).toBe(true);
    const readBack = parseNdjson<Proposal>(raw);
    expect(readBack.length).toBe(built.length);
    for (let i = 0; i < built.length; i++) {
      expect(readBack[i]!.proposed_target).toBe(built[i]!.proposed_target);
      expect(readBack[i]!.classification_confidence).toBe(built[i]!.classification_confidence);
      expect(readBack[i]!.content_full).toBe(built[i]!.content_full);
      expect(readBack[i]!.status).toBe("pending");
      expect(readBack[i]!.source_section).toBe(built[i]!.source_section);
    }
  });

  it("appends (never overwrites) across two scans", () => {
    const src = tmp();
    const f1 = join(src, "a.md");
    const f2 = join(src, "b.md");
    writeFileSync(f1, "## Goals\nThe goal is to hit the milestone by end of 2026, aim to target it.\n");
    writeFileSync(f2, "## Beliefs\nI believe my core belief and conviction is real, we solve problems.\n");
    const queueFile = join(tmp(), "q.jsonl");

    expect(main(["--source", f1], { queueFile, now: FIXED_NOW })).toBe(0);
    const afterFirst = parseNdjson<Proposal>(readFileSync(queueFile, "utf-8")).length;
    expect(main(["--source", f2], { queueFile, now: FIXED_NOW })).toBe(0);
    const afterSecond = parseNdjson<Proposal>(readFileSync(queueFile, "utf-8")).length;

    expect(afterSecond).toBeGreaterThan(afterFirst);
  });
});

describe("main — envelope, exits, dry-run", () => {
  it("--json emits { proposals, by_target, avg_confidence } to stdout with frozen keys", () => {
    const src = tmp();
    const srcFile = join(src, "in.md");
    writeFileSync(srcFile, "## Mission\nMy mission and north-star, my life's work, why I build things.\n");
    const queueFile = join(tmp(), "q.jsonl");

    const orig = console.log;
    let captured = "";
    const writeOrig = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      captured += s;
      return true;
    };
    try {
      const code = main(["--source", srcFile, "--json"], { queueFile, now: FIXED_NOW });
      expect(code).toBe(0);
    } finally {
      (process.stdout as unknown as { write: typeof writeOrig }).write = writeOrig;
      console.log = orig;
    }
    const env = JSON.parse(captured);
    expect(Object.keys(env).sort()).toEqual(["avg_confidence", "by_target", "proposals"]);
    expect(Array.isArray(env.proposals)).toBe(true);
    expect(typeof env.avg_confidence).toBe("number");
  });

  it("errors (exit 1) when neither --source nor --stdin is given", () => {
    const errOrig = console.error;
    console.error = () => {};
    try {
      expect(main([], {})).toBe(1);
    } finally {
      console.error = errOrig;
    }
  });

  it("errors (exit 1) on a non-existent source", () => {
    const errOrig = console.error;
    console.error = () => {};
    try {
      expect(main(["--source", join(tmp(), "nope.md")], { queueFile: join(tmp(), "q.jsonl"), now: FIXED_NOW })).toBe(1);
    } finally {
      console.error = errOrig;
    }
  });

  it("--dry-run does not write the queue", () => {
    const src = tmp();
    const srcFile = join(src, "in.md");
    writeFileSync(srcFile, "## Mission\nMy mission and north-star, my life's work, why I build things.\n");
    const queueFile = join(tmp(), "q.jsonl");
    const logOrig = console.log;
    console.log = () => {};
    try {
      expect(main(["--source", srcFile, "--dry-run"], { queueFile, now: FIXED_NOW })).toBe(0);
    } finally {
      console.log = logOrig;
    }
    expect(() => readFileSync(queueFile, "utf-8")).toThrow();
  });

  it("scans a directory recursively (.md/.txt/.markdown)", () => {
    const src = tmp();
    mkdirSync(join(src, "sub"), { recursive: true });
    writeFileSync(join(src, "a.md"), "## Mission\nMy mission and north-star, life's work, why I build.\n");
    writeFileSync(join(src, "sub", "b.txt"), "The goal is a milestone by end of 2026, aim to target growth here.\n");
    writeFileSync(join(src, "ignore.json"), "{}");
    const queueFile = join(tmp(), "q.jsonl");
    const logOrig = console.log;
    console.log = () => {};
    try {
      expect(main(["--source", src], { queueFile, now: FIXED_NOW })).toBe(0);
    } finally {
      console.log = logOrig;
    }
    const props = parseNdjson<Proposal>(readFileSync(queueFile, "utf-8"));
    const files = new Set(props.map((p) => p.source_file));
    expect([...files].some((f) => f.endsWith("a.md"))).toBe(true);
    expect([...files].some((f) => f.endsWith("b.txt"))).toBe(true);
    expect([...files].some((f) => f.endsWith("ignore.json"))).toBe(false);
  });
});

describe("RT-2 framework-dir resolution (AD-9.3)", () => {
  // The resolution seam (`defaultQueueFile`) is NOT exported, so we drive `main()` WITHOUT
  // opts.queueFile — that forces the internal `process.env.LIFEOS_DIR || PAI_DIR ||
  // resolveFrameworkDir(HOME)` path — and observe WHERE the queue file lands. The framework dir must
  // therefore be writable, so LIFEOS_DIR/PAI_DIR are real mkdtemp roots (not "/life"/"/pai" literals).
  // NOTE: the ambient shell may export a real PAI_DIR (live PAI). Every test controls
  // LIFEOS_DIR + PAI_DIR + HOME explicitly and restores them, or the ambient env leaks in.
  const KEYS = ["LIFEOS_DIR", "PAI_DIR", "HOME"] as const;
  const QUEUE_SUB = ["MEMORY", "MIGRATION", "migration-proposals.jsonl"] as const;
  let savedEnv: Record<string, string | undefined>;
  beforeEach(() => {
    savedEnv = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  // Run a scan that yields ≥1 proposal, using the env-resolved default queue file (no queueFile opt).
  function scanWithResolvedQueue(): void {
    const src = tmp();
    const srcFile = join(src, "in.md");
    writeFileSync(srcFile, "## Mission\nMy mission and north-star, my life's work, why I build things.\n");
    const logOrig = console.log;
    const errOrig = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      expect(main(["--source", srcFile], { now: FIXED_NOW })).toBe(0);
    } finally {
      console.log = logOrig;
      console.error = errOrig;
    }
  }

  it("LIFEOS_DIR wins over PAI_DIR", () => {
    const life = tmp();
    const pai = tmp();
    process.env.LIFEOS_DIR = life;
    process.env.PAI_DIR = pai;
    scanWithResolvedQueue();
    expect(existsSync(join(life, ...QUEUE_SUB))).toBe(true);
    expect(existsSync(join(pai, ...QUEUE_SUB))).toBe(false);
  });

  it("PAI_DIR honored when LIFEOS_DIR unset (transition window)", () => {
    delete process.env.LIFEOS_DIR;
    const pai = tmp();
    process.env.PAI_DIR = pai;
    scanWithResolvedQueue();
    expect(existsSync(join(pai, ...QUEUE_SUB))).toBe(true);
  });

  it("neither env set → resolver falls back to LIFEOS under a fresh temp home", () => {
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    const home = tmp();
    process.env.HOME = home;
    scanWithResolvedQueue();
    expect(existsSync(join(home, ".claude", "LIFEOS", ...QUEUE_SUB))).toBe(true);
  });

  it("legacy PAI tree present → resolver picks PAI", () => {
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    const home = tmp();
    mkdirSync(join(home, ".claude", "PAI"), { recursive: true });
    process.env.HOME = home;
    scanWithResolvedQueue();
    expect(existsSync(join(home, ".claude", "PAI", ...QUEUE_SUB))).toBe(true);
  });
});
