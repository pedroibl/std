import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  loadFailurePatterns,
  loadLearningDigest,
  loadSignalTrends,
  loadSynthesisPatterns,
  loadWisdomFrames,
} from "./learning-readback";

// Story 13.4 — learning-readback swapped its 5 readFileSync sites to std/fsx readIfExists (two of them
// FOLDING an existsSync+readFileSync pair). These fixtures exercise BOTH the present-file happy path
// (readIfExists returns content) AND the missing-file path (readIfExists → null → the reader skips /
// returns null), which is exactly the behavior the fold must preserve. The frozen export surface (consumed
// by LoadContext=13.8 + ContextLoadReport.ts) is unchanged.

let base: string; // stands in for paiDir
const MONTH = "2099-01"; // any newest-sorting month; readers take the newest dir regardless of value

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "lrb-"));

  // ALGORITHM digest fixture (getRecentLearnings :60 — bare readFileSync → readIfExists + null-skip)
  const algDir = join(base, "MEMORY", "LEARNING", "ALGORITHM", MONTH);
  mkdirSync(algDir, { recursive: true });
  writeFileSync(join(algDir, "2099-01-01-120000_LEARNING_x.md"), "rating: 8\n**Feedback:** did the thing well\n");

  // WISDOM/FRAMES fixture (loadWisdomFrames :147 — bare readFileSync → readIfExists + null-skip)
  const framesDir = join(base, "MEMORY", "WISDOM", "FRAMES");
  mkdirSync(framesDir, { recursive: true });
  writeFileSync(join(framesDir, "collaboration.md"), "### Look before fixing [CRYSTAL: 90%]\nbody\n");
  writeFileSync(join(framesDir, "low.md"), "### Too green [CRYSTAL: 50%]\nbody\n"); // below 85 → excluded

  // FAILURES fixture (loadFailurePatterns :204 — FOLDED existsSync+readFileSync pair). One dir HAS
  // CONTEXT.md (kept), one is MISSING it (readIfExists → null → skipped, proving the fold).
  const failMonth = join(base, "MEMORY", "LEARNING", "FAILURES", MONTH);
  mkdirSync(join(failMonth, "2099-01-02-130000_real-failure"), { recursive: true });
  writeFileSync(join(failMonth, "2099-01-02-130000_real-failure", "CONTEXT.md"), "what went wrong\n");
  mkdirSync(join(failMonth, "2099-01-03-140000_no-context-dir"), { recursive: true }); // no CONTEXT.md

  // SYNTHESIS fixture (loadSynthesisPatterns :251 — bare readFileSync → readIfExists + null-skip)
  const synMonth = join(base, "MEMORY", "LEARNING", "SYNTHESIS", MONTH);
  mkdirSync(synMonth, { recursive: true });
  writeFileSync(
    join(synMonth, "2099-01-04_weekly-patterns.md"),
    "**Average Rating:** 5.0/10\n\n## Top Issues\n1. Incomplete Work\n2. Repetitive Issues\n\n## Next\n",
  );

  // STATE/learning-cache.sh fixture (loadSignalTrends :289 — FOLDED existsSync+readFileSync pair)
  const stateDir = join(base, "MEMORY", "STATE");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "learning-cache.sh"), "today_avg='7'\nweek_avg='6'\ntrend='up'\ntotal_count='42'\n");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("present-file reads (readIfExists returns content)", () => {
  test("loadLearningDigest surfaces the ALGORITHM feedback", () => {
    const out = loadLearningDigest(base);
    expect(out).toContain("Recent Learning Signals");
    expect(out).toContain("[8/10] did the thing well");
  });

  test("loadWisdomFrames keeps ≥85% frames, drops the 50% one", () => {
    const out = loadWisdomFrames(base);
    expect(out).toContain("Look before fixing (90%)");
    expect(out).not.toContain("Too green");
  });

  test("loadFailurePatterns lists the dir WITH CONTEXT.md and skips the one WITHOUT (fold behavior)", () => {
    const out = loadFailurePatterns(base);
    expect(out).toContain("real failure");
    expect(out).not.toContain("no context dir");
  });

  test("loadSynthesisPatterns extracts the average + top issues", () => {
    const out = loadSynthesisPatterns(base);
    expect(out).toContain("Avg rating 5.0/10");
    expect(out).toContain("1. Incomplete Work");
  });

  test("loadSignalTrends parses the shell cache vars", () => {
    const out = loadSignalTrends(base);
    expect(out).toContain("Today: 7/10");
    expect(out).toContain("trending up");
    expect(out).toContain("Total signals: 42");
  });
});

describe("missing-file reads (readIfExists → null → the fold's null branch)", () => {
  test("loadSignalTrends → null when learning-cache.sh is absent (folded existsSync guard)", () => {
    const empty = mkdtempSync(join(tmpdir(), "lrb-empty-"));
    expect(loadSignalTrends(empty)).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });

  test("loadLearningDigest → null when no LEARNING dirs exist", () => {
    const empty = mkdtempSync(join(tmpdir(), "lrb-empty-"));
    expect(loadLearningDigest(empty)).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });
});
