import { describe, expect, test } from "bun:test";

import { extractTurns, stripLoneSurrogates } from "./SatisfactionCapture.hook";

const HOOK = `${import.meta.dir}/SatisfactionCapture.hook.ts`;

/** Fire the hook as the harness would — `bun SatisfactionCapture.hook.ts` with `input` on stdin. */
async function fire(input: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

// Story 13.4 — extractTurns is the std/core parseNdjson consumer (the manual split('\n')+per-line
// JSON.parse try/catch swap). These lock the skip-blank / skip-malformed contract + the caller-local
// user/assistant filtering, 200/150 caps, and SUMMARY extraction.

describe("extractTurns — parseNdjson swap (skip blank / skip malformed preserved)", () => {
  const ndjson = [
    JSON.stringify({ type: "user", message: { content: "please refactor the memory cluster hooks" } }),
    "", // blank line — parseNdjson skips
    "{ not json", // malformed — parseNdjson skips
    JSON.stringify({ type: "assistant", message: { content: "SUMMARY: rewrote the three hooks onto std" } }),
  ].join("\n");

  test("extracts user + assistant turns, applies SUMMARY extraction", () => {
    const out = extractTurns(ndjson);
    expect(out).toContain("User: please refactor the memory cluster hooks");
    expect(out).toContain("Assistant: rewrote the three hooks onto std");
  });

  test("array-shaped message content is joined from text blocks", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "hello" }, { type: "image" }, { type: "text", text: "world" }] },
    });
    expect(extractTurns(line)).toBe("User: hello world");
  });

  test("caps: user text at 200, assistant (non-SUMMARY) at 150", () => {
    const u = JSON.stringify({ type: "user", message: { content: "u".repeat(300) } });
    const a = JSON.stringify({ type: "assistant", message: { content: "a".repeat(300) } });
    const out = extractTurns([u, a].join("\n"));
    const [userLine, asstLine] = out.split("\n");
    expect(userLine).toBe("User: " + "u".repeat(200));
    expect(asstLine).toBe("Assistant: " + "a".repeat(150));
  });

  test("maxTurns keeps only the last N turns", () => {
    const lines = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({ type: "user", message: { content: `message number ${i}` } }),
    ).join("\n");
    const out = extractTurns(lines, 2);
    expect(out.split("\n").length).toBe(2);
    expect(out).toContain("message number 5");
    expect(out).not.toContain("message number 0");
  });

  test("empty / all-malformed input → '' ", () => {
    expect(extractTurns("")).toBe("");
    expect(extractTurns("{bad\n{also bad")).toBe("");
  });
});

// The DEFER: appendJsonlEvent is NOT adopted for writeRating because the surrogate-strip must run on the
// POST-JSON.stringify escaped string. These prove the strip operates on escape text (which appendAudit's
// own internal stringify would re-introduce), justifying the hand-rolled writeRating.
describe("stripLoneSurrogates — the DEFER-honoring escape strip", () => {
  test("a lone high-surrogate escape is stripped", () => {
    // JSON.stringify of a lone surrogate emits the `\udXXX` escape (well-formed JSON.stringify).
    const escaped = JSON.stringify({ m: "\ud83d" });
    expect(escaped).toContain("\\ud83d");
    expect(stripLoneSurrogates(escaped)).not.toContain("\\ud83d");
  });

  test("a well-formed emoji round-trips untouched (no lone-surrogate escapes to strip)", () => {
    const escaped = JSON.stringify({ m: "😀" });
    expect(stripLoneSurrogates(escaped)).toBe(escaped);
    expect(JSON.parse(stripLoneSurrogates(escaped)).m).toBe("😀");
  });

  test("the real bug scenario: an emoji truncated at a slice boundary → lone surrogate → stripped to valid JSON", () => {
    // "😀" is the pair 😀; slicing one code UNIT leaves the lone high surrogate \ud83d — the
    // exact "truncated emoji at slice boundary" the strip fixes. JSON.stringify escapes it; the strip
    // removes it, leaving jq-parseable JSON. (In production JSON.stringify NEVER escapes a VALID pair — it
    // emits the literal char — so the regex only ever meets lone-surrogate escapes.)
    const truncated = "😀".slice(0, 1); // lone high surrogate
    const escaped = JSON.stringify({ m: truncated });
    const cleaned = stripLoneSurrogates(escaped);
    expect(cleaned).not.toContain("\\ud");
    expect(() => JSON.parse(cleaned)).not.toThrow(); // valid JSON — the jq-break is fixed
    expect(JSON.parse(cleaned).m).toBe("");
  });
});

describe("fail-OPEN posture (AD-9.4 Rule 2) — NET-NEW null → exit 0", () => {
  test("empty stdin → exit 0, std imports resolved (no 'Cannot find module')", async () => {
    const { code, stderr } = await fire("");
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
  });

  test("malformed JSON stdin → null → exit 0 (visible guard, not a thrown JSON.parse)", async () => {
    const { code, stderr } = await fire("{not json");
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
  });
});
