import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Roots, defaultRoots, loadCandidates, main, rank } from "./recommend";

// ── Hermetic TELOS fixture: 6 rankable restaurants + 1 blocklisted, one with a tracked visit. ──
// A fixed `now` is injected everywhere so days_since is deterministic (no wall-clock reads).
const NOW = new Date("2026-06-11T00:00:00Z");

const RESTAURANTS_MD = [
  "# Restaurants",
  "",
  '- name: "Thai Palace"',
  "  cuisine: thai",
  "  location: Melbourne",
  "  rating: 9",
  '- name: "Sushi Zen"',
  "  cuisine: japanese",
  "  rating: 8",
  '- name: "Pasta Bar"',
  "  cuisine: italian",
  "  rating: 7",
  '- name: "Taco Loco"',
  "  cuisine: mexican",
  "  rating: 6",
  '- name: "Curry House"',
  "  cuisine: indian",
  "  rating: 5",
  '- name: "Green Bowl"',
  "  cuisine: vegan",
  "  rating: 4",
  "",
  "## Blocklist",
  '- name: "Bad Diner"',
  "  cuisine: thai",
  "  rating: 10",
].join("\n");

const CONSUMPTION_MD = [
  '- name: "Thai Palace"',
  "  category: restaurant",
  "  visited: 2026-06-01",
].join("\n");

function makeRoots(): { roots: Roots; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "recommend-"));
  const telosDir = join(dir, "TELOS");
  const currentDir = join(telosDir, "CURRENT_STATE");
  mkdirSync(currentDir, { recursive: true });
  writeFileSync(join(telosDir, "RESTAURANTS.md"), RESTAURANTS_MD);
  writeFileSync(join(currentDir, "CONSUMPTION.md"), CONSUMPTION_MD);
  return { roots: { telosDir, currentDir }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function captureStdout(fn: () => void): string {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  // test shim: intercept the write stream (loosened cast — overloaded signature)
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

describe("loadCandidates — daysSince(injected now) + blocklist filtering", () => {
  test("blocklist entry is filtered out; 6 candidates remain", () => {
    const { roots, cleanup } = makeRoots();
    try {
      const cands = loadCandidates("restaurant", roots, NOW);
      expect(cands.map((c) => c.name)).not.toContain("Bad Diner");
      expect(cands).toHaveLength(6);
    } finally {
      cleanup();
    }
  });

  test("days_since is computed off the injected `now`, not the wall clock", () => {
    const { roots, cleanup } = makeRoots();
    try {
      const cands = loadCandidates("restaurant", roots, NOW);
      const thai = cands.find((c) => c.name === "Thai Palace");
      // visited 2026-06-01, now 2026-06-11 → 10 whole days
      expect(thai?.days_since).toBe(10);
      expect(thai?.last_consumed).toBe("2026-06-01");
      // untracked restaurant → undefined recency
      expect(cands.find((c) => c.name === "Sushi Zen")?.days_since).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("a different injected now shifts days_since deterministically", () => {
    const { roots, cleanup } = makeRoots();
    try {
      const later = new Date("2026-07-01T00:00:00Z"); // 30 days after 2026-06-01
      const thai = loadCandidates("restaurant", roots, later).find((c) => c.name === "Thai Palace");
      expect(thai?.days_since).toBe(30);
    } finally {
      cleanup();
    }
  });
});

describe("--json envelope — FROZEN contract (top-5, field names, 2-space indent)", () => {
  test("emits exactly 5 candidates with the frozen field set", () => {
    const PAI_DIR = process.env.PAI_DIR;
    // main() resolves roots via defaultRoots() → PAI_DIR/USER/TELOS. Build a matching layout so
    // the CLI path is hermetic (never touches the real ~/.claude).
    const paiDir = mkdtempSync(join(tmpdir(), "recommend-pai-"));
    const telos = join(paiDir, "USER", "TELOS");
    const current = join(telos, "CURRENT_STATE");
    mkdirSync(current, { recursive: true });
    writeFileSync(join(telos, "RESTAURANTS.md"), RESTAURANTS_MD);
    writeFileSync(join(current, "CONSUMPTION.md"), CONSUMPTION_MD);
    process.env.PAI_DIR = paiDir;
    try {
      const out = captureStdout(() => {
        const code = main(["--category", "restaurant", "--json"], NOW);
        expect(code).toBe(0);
      });

      const parsed = JSON.parse(out);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(5); // 6 candidates → slice(0, 5)

      // Frozen field names on the top entry (highest rating = Thai Palace, the visited one).
      const top = parsed[0];
      expect(top.name).toBe("Thai Palace");
      for (const key of [
        "name",
        "attrs",
        "last_consumed",
        "days_since",
        "rating",
        "source_file",
        "confidence",
      ]) {
        expect(Object.keys(top)).toContain(key);
      }
      expect(top.days_since).toBe(10);
      expect(top.source_file).toBe("TELOS/RESTAURANTS.md");

      // 2-space indent + trailing newline (byte-parity with the original console.log(JSON…,null,2)).
      expect(out).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
      // 2-space structural indent: array items at 2, their fields at 4.
      expect(out.startsWith("[\n  {\n")).toBe(true);
      expect(out).toContain('\n    "name": "Thai Palace"');
    } finally {
      rmSync(paiDir, { recursive: true, force: true });
      if (PAI_DIR === undefined) delete process.env.PAI_DIR;
      else process.env.PAI_DIR = PAI_DIR;
    }
  });
});

describe("rank — filters + ordering (caller-local rules preserved)", () => {
  test("cuisine filter narrows the pool and drops confidence", () => {
    const { roots, cleanup } = makeRoots();
    try {
      const cands = loadCandidates("restaurant", roots, NOW);
      const ranked = rank(cands, { cuisine: "thai" });
      expect(ranked.map((c) => c.name)).toEqual(["Thai Palace"]);
      // single match → narrow-pool note + confidence knocked down (0.8 - 0.05 cuisine, floored 0.3)
      expect(ranked[0].confidence_note).toBe("Narrow candidate pool — low confidence");
      expect(ranked[0].confidence).toBeCloseTo(0.75, 5);
    } finally {
      cleanup();
    }
  });

  test("not-visited window filters out recently-consumed picks", () => {
    const { roots, cleanup } = makeRoots();
    try {
      const cands = loadCandidates("restaurant", roots, NOW);
      // Thai Palace was 10 days ago; require >=30 days → excluded.
      const ranked = rank(cands, { notVisitedDays: 30 });
      expect(ranked.map((c) => c.name)).not.toContain("Thai Palace");
    } finally {
      cleanup();
    }
  });

  test("default ordering is rating desc", () => {
    const { roots, cleanup } = makeRoots();
    try {
      const ranked = rank(loadCandidates("restaurant", roots, NOW), {});
      expect(ranked.map((c) => c.rating)).toEqual([9, 8, 7, 6, 5, 4]);
    } finally {
      cleanup();
    }
  });
});

describe("main — argument guards", () => {
  test("missing --category returns exit 1", () => {
    expect(main([], NOW)).toBe(1);
  });

  test("invalid category returns exit 1", () => {
    expect(main(["--category", "wine"], NOW)).toBe(1);
  });
});

describe("RT-2 framework-dir resolution (AD-9.3)", () => {
  // NOTE: the ambient shell may export a real PAI_DIR (live PAI). Every test MUST control
  // LIFEOS_DIR + PAI_DIR + HOME explicitly and restore them, or the ambient env leaks in.
  const KEYS = ["LIFEOS_DIR", "PAI_DIR", "HOME"] as const;
  const SUB = ["USER", "TELOS"] as const;
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

  test("LIFEOS_DIR wins over PAI_DIR", () => {
    process.env.LIFEOS_DIR = "/life";
    process.env.PAI_DIR = "/pai";
    expect(defaultRoots().telosDir).toBe(join("/life", ...SUB));
  });

  test("PAI_DIR honored when LIFEOS_DIR unset (transition window)", () => {
    delete process.env.LIFEOS_DIR;
    process.env.PAI_DIR = "/pai";
    expect(defaultRoots().telosDir).toBe(join("/pai", ...SUB));
  });

  test("neither env set → resolver falls back to LIFEOS under a fresh temp home", () => {
    delete process.env.LIFEOS_DIR;
    delete process.env.PAI_DIR;
    const home = mkdtempSync(join(tmpdir(), "rt2-"));
    process.env.HOME = home;
    try {
      expect(defaultRoots().telosDir).toBe(join(home, ".claude", "LIFEOS", ...SUB));
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
      expect(defaultRoots().telosDir).toBe(join(home, ".claude", "PAI", ...SUB));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
