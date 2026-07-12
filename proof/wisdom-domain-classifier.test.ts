import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyDomains,
  loadRelevantFrames,
  listFrames,
  main,
  defaultFramesDir,
  DOMAIN_MAP,
  type DomainKeywords,
} from "./wisdom-domain-classifier";

// A tiny hermetic domain map so weighting math is exact and readable.
const TEST_MAP: DomainKeywords[] = [
  {
    domain: "development",
    primary: [/\bbug\b/i, /\bfix\b/i],
    secondary: [/\bfile\b/i],
  },
  {
    domain: "deployment",
    primary: [/\bdeploy\b/i],
    secondary: [/\bbuild\b/i, /\burl\b/i],
  },
];

function makeFrames(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "wdc-frames-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe("classifyDomains — occurrence weighting stays local (NOT scoreRules)", () => {
  test("a keyword repeated N times contributes N × weight", () => {
    const dir = makeFrames({});
    // "bug" appears 3× → primary weight 2 each → score 6 → relevance 0.6.
    const single = classifyDomains("bug", dir, TEST_MAP);
    const triple = classifyDomains("bug bug bug", dir, TEST_MAP);

    const dev1 = single.find((r) => r.domain === "development")!;
    const dev3 = triple.find((r) => r.domain === "development")!;

    expect(dev1.relevance).toBeCloseTo(0.2, 10); // 1×2 /10
    expect(dev3.relevance).toBeCloseTo(0.6, 10); // 3×2 /10
    // The whole point: occurrence count scales the score. A boolean-per-pattern
    // engine (scoreRules) would give BOTH the same score — this proves it doesn't.
    expect(dev3.relevance).toBeGreaterThan(dev1.relevance);
  });

  test("secondary keywords weight ×1 and repeated occurrences accumulate", () => {
    const dir = makeFrames({});
    // "build" ×2 → secondary weight 1 each → 2 secondaryHits → gate opens, score 2 → 0.2
    const res = classifyDomains("build build", dir, TEST_MAP);
    const dep = res.find((r) => r.domain === "deployment")!;
    expect(dep.relevance).toBeCloseTo(0.2, 10);
  });

  test("two-tier gate: 1 secondary hit alone does NOT trigger", () => {
    const dir = makeFrames({});
    // one "build" → secondaryHits=1, primaryHits=0 → excluded
    const res = classifyDomains("build", dir, TEST_MAP);
    expect(res.find((r) => r.domain === "deployment")).toBeUndefined();
  });

  test("two-tier gate: 2 distinct secondary hits DO trigger without a primary", () => {
    const dir = makeFrames({});
    // "build" + "url" → secondaryHits=2 → gate opens, score 2 → 0.2
    const res = classifyDomains("build url", dir, TEST_MAP);
    const dep = res.find((r) => r.domain === "deployment")!;
    expect(dep.relevance).toBeCloseTo(0.2, 10);
  });

  test("one primary hit alone triggers (primaryHits >= 1)", () => {
    const dir = makeFrames({});
    const res = classifyDomains("deploy", dir, TEST_MAP);
    const dep = res.find((r) => r.domain === "deployment")!;
    expect(dep.relevance).toBeCloseTo(0.2, 10);
  });

  test("mixed primary + secondary sums, and relevance clamps at 1", () => {
    const dir = makeFrames({});
    // bug ×5 (5×2=10) + fix ×1 (2) + file ×1 (1) = 13 → min(1.3,1) = 1
    const res = classifyDomains("bug bug bug bug bug fix file", dir, TEST_MAP);
    const dev = res.find((r) => r.domain === "development")!;
    expect(dev.relevance).toBe(1);
  });

  test("results sort by relevance descending", () => {
    const dir = makeFrames({});
    // development: bug ×2 = 4 → 0.4 ; deployment: deploy ×1 = 2 → 0.2
    const res = classifyDomains("bug bug deploy", dir, TEST_MAP);
    expect(res.map((r) => r.domain)).toEqual(["development", "deployment"]);
    expect(res[0].relevance).toBeGreaterThan(res[1].relevance);
  });

  test("path is the frame file when it exists, else empty string", () => {
    const dir = makeFrames({ "development.md": "# dev frame\n" });
    const res = classifyDomains("bug deploy", dir, TEST_MAP);
    const dev = res.find((r) => r.domain === "development")!;
    const dep = res.find((r) => r.domain === "deployment")!;
    expect(dev.path).toBe(join(dir, "development.md"));
    expect(dep.path).toBe(""); // no deployment.md on disk
  });

  test("no match → empty result set", () => {
    const dir = makeFrames({});
    expect(classifyDomains("nothing here matches", dir, TEST_MAP)).toEqual([]);
  });
});

describe("classifyDomains — real DOMAIN_MAP smoke", () => {
  test("routes a development request", () => {
    const dir = makeFrames({});
    const res = classifyDomains("fix the login bug in the typescript module", dir);
    expect(res[0].domain).toBe("development");
    expect(res[0].relevance).toBeGreaterThan(0);
    expect(res[0].relevance).toBeLessThanOrEqual(1);
  });
});

describe("loadRelevantFrames", () => {
  test("loads content of the top frames that exist, capped at maxFrames", () => {
    const dir = makeFrames({
      "development.md": "DEV CONTENT",
      "deployment.md": "DEPLOY CONTENT",
    });
    // both classify; both files exist
    const loaded = loadRelevantFrames("bug bug deploy", dir, 3, TEST_MAP);
    const domains = loaded.map((l) => l.domain);
    expect(domains).toContain("development");
    expect(loaded.find((l) => l.domain === "development")!.content).toBe("DEV CONTENT");
  });

  test("skips classified domains whose frame file is missing", () => {
    const dir = makeFrames({ "development.md": "DEV" });
    const loaded = loadRelevantFrames("bug deploy", dir, 3, TEST_MAP);
    expect(loaded.map((l) => l.domain)).toEqual(["development"]);
  });

  test("respects maxFrames cap", () => {
    const dir = makeFrames({
      "development.md": "DEV",
      "deployment.md": "DEP",
    });
    const loaded = loadRelevantFrames("bug bug build url", dir, 1, TEST_MAP);
    expect(loaded.length).toBe(1);
  });
});

describe("listFrames — walkFiles discovery + getMetaField confidence", () => {
  test("lists .md frames with parsed confidence", () => {
    const dir = makeFrames({
      "communication.md": "# Communication\n\n**Confidence:** 85%\n",
      "development.md": "# Development\n\n**Confidence:** 92%\n",
    });
    const listed = listFrames(dir).sort((a, b) => a.domain.localeCompare(b.domain));
    expect(listed).toEqual([
      { domain: "communication", path: join(dir, "communication.md"), confidence: "85%" },
      { domain: "development", path: join(dir, "development.md"), confidence: "92%" },
    ]);
  });

  test("confidence falls back to 'unknown' when absent", () => {
    const dir = makeFrames({ "x.md": "# no confidence field here\n" });
    expect(listFrames(dir)[0].confidence).toBe("unknown");
  });

  test("ignores non-.md files", () => {
    const dir = makeFrames({
      "keep.md": "**Confidence:** 50%\n",
      "skip.txt": "ignore me",
      "notes.json": "{}",
    });
    const listed = listFrames(dir);
    expect(listed.map((l) => l.domain)).toEqual(["keep"]);
  });

  test("missing frames dir → empty list", () => {
    const missing = join(tmpdir(), "wdc-does-not-exist-" + Date.now());
    expect(listFrames(missing)).toEqual([]);
  });
});

describe("main — CLI surface + exit codes", () => {
  test("--help returns 0", () => {
    expect(main(["--help"], { framesDir: makeFrames({}), readStdin: () => "" })).toBe(0);
  });

  test("-h short alias returns 0", () => {
    expect(main(["-h"], { framesDir: makeFrames({}), readStdin: () => "" })).toBe(0);
  });

  test("--list returns 0", () => {
    const dir = makeFrames({ "development.md": "**Confidence:** 90%\n" });
    expect(main(["--list"], { framesDir: dir, readStdin: () => "" })).toBe(0);
  });

  test("--text classifies and returns 0", () => {
    expect(main(["--text", "fix the bug"], { framesDir: makeFrames({}), readStdin: () => "" })).toBe(0);
  });

  test("-t short alias classifies and returns 0", () => {
    expect(main(["-t", "fix the bug"], { framesDir: makeFrames({}), readStdin: () => "" })).toBe(0);
  });

  test("empty stdin + no --text → error exit 1", () => {
    expect(main([], { framesDir: makeFrames({}), readStdin: () => "   " })).toBe(1);
  });

  test("stdin fallback is used when no --text", () => {
    // whitespace-only stdin → 1; real content → 0 (proves the injected reader is consulted)
    expect(main([], { framesDir: makeFrames({}), readStdin: () => "deploy the worker" })).toBe(0);
  });
});

describe("defaultFramesDir — root injection (RT-2 precedence, AD-9.3)", () => {
  test("LIFEOS_DIR wins over PAI_DIR", () => {
    expect(
      defaultFramesDir({ LIFEOS_DIR: "/life", PAI_DIR: "/opt/pai" } as NodeJS.ProcessEnv),
    ).toBe(join("/life", "MEMORY", "WISDOM", "FRAMES"));
  });

  test("PAI_DIR honored when LIFEOS_DIR unset (transition window)", () => {
    expect(defaultFramesDir({ PAI_DIR: "/opt/pai" } as NodeJS.ProcessEnv)).toBe(
      join("/opt/pai", "MEMORY", "WISDOM", "FRAMES"),
    );
  });

  test("neither env set → resolver falls back to LIFEOS under HOME/.claude (the new name)", () => {
    expect(defaultFramesDir({ HOME: "/home/x" } as NodeJS.ProcessEnv)).toBe(
      join("/home/x", ".claude", "LIFEOS", "MEMORY", "WISDOM", "FRAMES"),
    );
  });
});

describe("DOMAIN_MAP sanity", () => {
  test("ships the five documented domains", () => {
    expect(DOMAIN_MAP.map((d) => d.domain)).toEqual([
      "communication",
      "development",
      "deployment",
      "content-creation",
      "system-architecture",
    ]);
  });
});
