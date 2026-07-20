// Self-test for the skill/tool classifier (Epic 15, Story 15.3).
//
// Hermetic and disk-free by construction: every case builds a `MinedMemory`
// DIRECTLY. Nothing here routes text through `mineMemories` — the headline
// prompt-echo literal matches 0 of the 19 MINING_PATTERN_MAP regexes and is 99
// chars, so `matchCount === 0` short-circuits before the confidence floor is
// ever reached: the miner CANNOT produce it. Routing the fixture through the
// miner would therefore assert against a candidate that does not exist in the
// real queue (Story 15.3 §Testing standards).

import { describe, expect, test } from "bun:test";

import {
  bandOf,
  classifyArtifact,
  emptyStats,
  parseCatalog,
  recordClassification,
  renderClassificationReport,
  stripScaffoldingFrames,
  type Catalog,
} from "./skill-classifier";

import type { MinedMemory } from "./harvester";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATALOG: Catalog = [
  { name: "_CreateStdTool", kind: "skill" },
  { name: "bmad-agent-jhon-the-loop", kind: "skill" },
  { name: "Interceptor", kind: "skill" },
  { name: "SessionHarvester", kind: "tool" },
  { name: "std", kind: "tool" },
];

/** Build a MinedMemory directly — never via `mineMemories` (see header). */
function mem(over: Partial<MinedMemory> = {}): MinedMemory {
  return {
    sessionId: "0f3c1a22-1111-2222-3333-444455556666",
    project: "-Users-pibl-Dev-personal-std",
    timestamp: "2026-07-20T01:02:03.000Z",
    memoryType: "decision",
    content: "placeholder content long enough to be uninteresting",
    context: "placeholder context",
    confidence: 0.30000000000000004,
    sourcePattern: "decided to",
    sourceLine: 42,
    ...over,
  };
}

/** The literal observed prompt echo — 99 chars, the story's headline trap. */
const ECHO_LITERAL =
  "Base directory for this skill: /Users/pibl/Dev/personal/std/.claude/skills/bmad-agent-jhon-the-loop";

// ---------------------------------------------------------------------------
// AC3 — the scaffolding-frame deny-list (the chosen discriminator)
// ---------------------------------------------------------------------------

describe("stripScaffoldingFrames", () => {
  test("removes a LEADING `Base directory for this skill:` line, keeping the payload", () => {
    const payload = "We decided the Interceptor skill must verify every deploy.";
    expect(stripScaffoldingFrames(`${ECHO_LITERAL}\n\n${payload}`)).toBe(payload);
  });

  test("a frame that is the ENTIRE content leaves nothing behind", () => {
    expect(stripScaffoldingFrames(ECHO_LITERAL)).toBe("");
  });

  test("strips stacked frames, and a truncated (unterminated) tag block eats the rest", () => {
    const stacked = `<command-message>bmad-agent-dev</command-message>\n${ECHO_LITERAL}\nreal payload`;
    expect(stripScaffoldingFrames(stacked)).toBe("real payload");
    // A 500-char slice can cut a frame open; refusing to guess past it is the
    // conservative direction AC2 mandates (never guess an artifact).
    expect(stripScaffoldingFrames("<system-reminder>truncated mid-frame about Interceptor")).toBe("");
  });

  test("strips a LEADING `ARGUMENTS:` echo — the args name what was CALLED, not what the learning is ABOUT", () => {
    expect(stripScaffoldingFrames("ARGUMENTS: Research the queue\nWe decided the floor admits noise.")).toBe(
      "We decided the floor admits noise.",
    );
  });

  test("strips a LEADING slash-command line, but NEVER a lower-cased absolute path", () => {
    expect(stripScaffoldingFrames("/code-review 15.3\nThe problem is Interceptor never ran.")).toBe(
      "The problem is Interceptor never ran.",
    );
    // 15.2 measured three real `/private/tmp/…` slugs; eating this line would
    // silently drop the payload of every candidate that opens with such a path.
    const path = "/private/tmp/std-bin/run.ts is where the problem was.";
    expect(stripScaffoldingFrames(path)).toBe(path);
  });

  test("the base-directory frame is case-INSENSITIVE (harness casing is not a contract)", () => {
    const payload = "We decided to measure first.";
    expect(stripScaffoldingFrames(`${ECHO_LITERAL.toLowerCase()}\n\n${payload}`)).toBe(payload);
  });

  test("does NOT strip a frame phrase that appears mid-payload", () => {
    const body = "The bug was that Base directory for this skill: was echoed into the queue.";
    expect(stripScaffoldingFrames(body)).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// AC1 / AC2 / AC3 / AC6 — the classifier
// ---------------------------------------------------------------------------

describe("classifyArtifact", () => {
  // AC6 case 1
  test("a catalogued skill named OUTSIDE a scaffolding frame is tagged", () => {
    const m = mem({ content: "We decided the Interceptor skill must verify every deploy before we claim done." });
    expect(classifyArtifact(m, CATALOG)).toEqual(["skill:Interceptor"]);
  });

  test("a catalogued TOOL is tagged with the tool: prefix", () => {
    const m = mem({ content: "The problem is SessionHarvester never wrote to the queue at all." });
    expect(classifyArtifact(m, CATALOG)).toEqual(["tool:SessionHarvester"]);
  });

  test("a path mention resolves to the same artifact", () => {
    const m = mem({ content: "Turns out ~/.claude/skills/_CreateStdTool/SKILL.md was the stale one." });
    expect(classifyArtifact(m, CATALOG)).toEqual(["skill:_CreateStdTool"]);
  });

  // AC6 case 2 — the headline regression, unit-tested on the pure classifier
  test("THE PROMPT-ECHO REGRESSION: the literal echo is NOT tagged with the skill it names", () => {
    const m = mem({ content: ECHO_LITERAL, context: ECHO_LITERAL.slice(0, 300) });
    const tags = classifyArtifact(m, CATALOG);
    expect(tags).toEqual(["unclassified"]);
    expect(tags).not.toContain("skill:bmad-agent-jhon-the-loop");
  });

  // AC6 case 3 — THE PRODUCTION-SHAPED ECHO: the one that actually occurs
  test("PRODUCTION-SHAPED ECHO: >200 chars beginning with the preamble is not tagged with the preamble's skill", () => {
    const later =
      "I decided to rewrite the promoter as a sibling tool because the routing map is lossy by construction, " +
      "and the issue was that the queue candidate carries only a cwd slug. We should always prefer the injected " +
      "catalog over anything baked into src.";
    const content = `${ECHO_LITERAL}\n\n${later}`;
    expect(content.length).toBeGreaterThan(200); // the miner's +0.1 length bonus band
    const m = mem({ content, context: content.slice(0, 300) });
    const tags = classifyArtifact(m, CATALOG);
    expect(tags).not.toContain("skill:bmad-agent-jhon-the-loop");
    expect(tags).toEqual(["unclassified"]);
  });

  test("a skill named in the PAYLOAD still wins even when a frame preceded it", () => {
    const content = `${ECHO_LITERAL}\n\nActually the real fix was in the Interceptor skill, not here.`;
    const tags = classifyArtifact(mem({ content }), CATALOG);
    expect(tags).toEqual(["skill:Interceptor"]);
    expect(tags).not.toContain("skill:bmad-agent-jhon-the-loop");
  });

  // AC6 case 4
  test("a `subagents`-slug candidate with no inferable artifact is unclassified, never guessed", () => {
    const m = mem({
      project: "subagents",
      content: "The approach was wrong; we should have measured the rate before shipping the heuristic.",
    });
    expect(classifyArtifact(m, CATALOG)).toEqual(["unclassified"]);
  });

  // AC6 case 4, the anti-slug property stated as its own assertion.
  // Case 4 above uses a `subagents` slug that names nothing catalogued, so it
  // stays green even if `m.project` were used as an artifact signal. This one
  // cannot: the slug IS a catalogued name and the body never mentions it, so a
  // regression that reads `m.project` mints `skill:Interceptor` and fails here.
  // The cwd slug is not an artifact identity — that is the whole premise of 15.3.
  test("the cwd slug is NEVER an artifact signal, even when it equals a catalogued name", () => {
    const m = mem({
      project: "Interceptor",
      content: "We decided to always measure the rate before shipping the heuristic.",
    });
    expect(classifyArtifact(m, CATALOG)).toEqual(["unclassified"]);
  });

  // AC6 case 5
  test("an UNCATALOGUED name mentioned in text is never invented", () => {
    const m = mem({ content: "We decided the ShinyNewSkill approach is better than the old one." });
    expect(classifyArtifact(m, CATALOG)).toEqual(["unclassified"]);
  });

  test("an empty catalog classifies nothing — no name is ever inferred from text alone", () => {
    const m = mem({ content: "We decided the Interceptor skill must verify every deploy." });
    expect(classifyArtifact(m, [])).toEqual(["unclassified"]);
  });

  test("matching is case-SENSITIVE and boundary-aware (no substring hits)", () => {
    expect(classifyArtifact(mem({ content: "we decided interceptor is fine" }), CATALOG)).toEqual(["unclassified"]);
    // `std` must not fire on `std-public` / `stdio` — the same prefix trap 15.2 hit on slugs.
    expect(classifyArtifact(mem({ content: "The problem is std-public and stdio disagree." }), CATALOG)).toEqual([
      "unclassified",
    ]);
    expect(classifyArtifact(mem({ content: "The problem is std broke the gate." }), CATALOG)).toEqual(["tool:std"]);
  });

  test("multiple distinct artifacts yield sorted, deduplicated tags", () => {
    const m = mem({
      content: "Interceptor and SessionHarvester disagree; SessionHarvester wins. Interceptor is the verifier.",
    });
    expect(classifyArtifact(m, CATALOG)).toEqual(["skill:Interceptor", "tool:SessionHarvester"]);
  });

  test("a truncated mention (cut by the 500-char slice) simply does not match — it is not half-guessed", () => {
    const m = mem({ content: "We decided the problem lives in Sessi" });
    expect(classifyArtifact(m, CATALOG)).toEqual(["unclassified"]);
  });
});

// ---------------------------------------------------------------------------
// AC2 — the classification-rate report (AC6 case 7)
// ---------------------------------------------------------------------------

describe("classification stats", () => {
  test("bandOf renders the IEEE754 30% band as `30%` (never assert === 0.3)", () => {
    expect(0.2 + 0.1).not.toBe(0.3); // the trap this guards
    expect(bandOf(0.30000000000000004)).toBe("30%");
    expect(bandOf(0.7)).toBe("70%");
  });

  test("counts total/classified/unclassified and breaks the rate down by confidence band", () => {
    const stats = emptyStats();
    recordClassification(stats, mem({ confidence: 0.30000000000000004 }), ["unclassified"]);
    recordClassification(stats, mem({ confidence: 0.30000000000000004 }), ["skill:Interceptor"]);
    recordClassification(stats, mem({ confidence: 0.7 }), ["tool:SessionHarvester"]);

    expect(stats.total).toBe(3);
    expect(stats.classified).toBe(2);
    expect(stats.unclassified).toBe(1);
    expect(stats.byBand["30%"]).toEqual({ total: 2, classified: 1 });
    expect(stats.byBand["70%"]).toEqual({ total: 1, classified: 1 });
  });

  test("the report is emitted, states the rate, and breaks it down by band", () => {
    const stats = emptyStats();
    recordClassification(stats, mem({ confidence: 0.30000000000000004 }), ["unclassified"]);
    recordClassification(stats, mem({ confidence: 0.7 }), ["skill:Interceptor"]);

    const out = renderClassificationReport(stats).join("\n");
    expect(out).toContain("classified 1/2");
    expect(out).toContain("unclassified 1");
    expect(out).toContain("50%"); // the rate
    expect(out).toContain("30%: 0/1");
    expect(out).toContain("70%: 1/1");
  });

  test("an empty pass reports 0/0 without dividing by zero", () => {
    const out = renderClassificationReport(emptyStats()).join("\n");
    expect(out).toContain("classified 0/0");
    expect(out).not.toContain("NaN");
  });
});

// ---------------------------------------------------------------------------
// Catalog injection — DATA, never baked (D4/NFR3)
// ---------------------------------------------------------------------------

describe("parseCatalog", () => {
  test("reads the `{skills:[],tools:[]}` shape into typed entries", () => {
    expect(parseCatalog({ skills: ["Interceptor"], tools: ["SessionHarvester"] })).toEqual([
      { name: "Interceptor", kind: "skill" },
      { name: "SessionHarvester", kind: "tool" },
    ]);
  });

  test("a missing key is simply empty, not an error", () => {
    expect(parseCatalog({ skills: ["Interceptor"] })).toEqual([{ name: "Interceptor", kind: "skill" }]);
    expect(parseCatalog({})).toEqual([]);
  });

  test("a MISNAMED key fails loud instead of faking a 0% rate", () => {
    // `skill`/`tool` singular reads as absent on both known keys, so without
    // this guard the run exits 0 having classified nothing — indistinguishable
    // from the genuine "the signal isn't there" finding this story measures.
    expect(() => parseCatalog({ skill: ["Interceptor"] })).toThrow(/skills.*tools|no `skills`/i);
    expect(() => parseCatalog({ tool: ["SessionHarvester"] })).toThrow(/no `skills`/i);
    // A known key present alongside an unknown one is still fine.
    expect(parseCatalog({ skills: ["Interceptor"], notes: "ignored" })).toEqual([
      { name: "Interceptor", kind: "skill" },
    ]);
  });

  test("fails LOUD on a wrong shape rather than silently classifying nothing (FR5)", () => {
    expect(() => parseCatalog(null)).toThrow(/catalog/i);
    expect(() => parseCatalog([])).toThrow(/catalog/i);
    expect(() => parseCatalog({ skills: "Interceptor" })).toThrow(/skills/i);
    expect(() => parseCatalog({ tools: [1] })).toThrow(/tools/i);
    expect(() => parseCatalog({ skills: ["  "] })).toThrow(/empty/i);
  });
});
