import { expect, test, describe } from "bun:test";
import {
  extractEventText,
  themesFor,
  isNoise,
  isPersonal,
  isDisclosure,
  extractSegments,
  pickBestPerUuid,
  type Role,
} from "./backup-harvester";
import { contentHash } from "std/core";

// Historical passageHash implementation to verify stability
function historicalPassageHash(text: string): string {
  const norm = text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 400);
  let h = 5381;
  for (let i = 0; i < norm.length; i++) h = (h * 33) ^ norm.charCodeAt(i);
  return (h >>> 0).toString(16);
}

describe("BackupHarvester Unit Tests", () => {
  test("extractEventText — assistant", () => {
    const a = extractEventText({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "When I was a kid in Brazil my father worked nights." }] },
      timestamp: "2026-01-02T03:04:05Z",
    });
    expect(a?.role).toBe("tome");
    expect(a?.text).toContain("Brazil");
  });

  test("extractEventText — plain user", () => {
    const u = extractEventText({
      type: "user",
      message: { role: "user", content: "My partner Leo and I met at Mardi Gras." },
    });
    expect(u?.role).toBe("pedro");
  });

  test("extractEventText — context blob attributed to context", () => {
    const c = extractEventText({
      type: "user",
      message: { role: "user", content: "PREVIOUS AI RESPONSE: blah\nRECENT CONVERSATION: more" },
    });
    expect(c?.role).toBe("context");
  });

  test("extractEventText — top-level content (queue-operation)", () => {
    const q = extractEventText({
      type: "queue-operation",
      content: "Some enqueued prompt about my mother.",
    });
    expect(q?.role).toBe("context");
  });

  test("tool_result-only user turn → null", () => {
    const tr = extractEventText({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "x" }] },
    });
    expect(tr).toBeNull();
  });

  test("themesFor", () => {
    expect(themesFor("my mother and father")).toContain("family");
    expect(themesFor("I grew up in Fortaleza, Brazil")).toContain("places");
    expect(themesFor("Leo Tan is my partner")).toContain("relationships");
    expect(themesFor("refactor the typescript build pipeline").length).toBe(0);
  });

  test("precision gates", () => {
    expect(isNoise("# TELOS RECONCILIATION REPORT")).toBe(true);
    expect(isNoise("| 0 | Threshold view |")).toBe(true);
    expect(isNoise("Base directory for this skill: /Users/pibl/.claude/skills/Knowledge")).toBe(true);
    expect(isNoise("relationship-memory-worker at ~/.claude/PAI")).toBe(true);
    expect(isNoise("My father worked nights when I was a kid in Brazil.")).toBe(false);
    expect(isPersonal("my mother passed away in 2019")).toBe(true);
    expect(isPersonal("the mph pricing worker was deployed")).toBe(false);
    expect(extractSegments("line one\nline two").length).toBe(2);
  });

  test("end-to-end regressions", () => {
    const fp1 = "relationship-memory-worker";
    expect(isNoise(fp1) || !isPersonal(fp1)).toBe(true);

    const fp2 = "| BMAD-METHOD v6.6.0 cloned |";
    expect(isNoise(fp2)).toBe(true);

    const tp1 = "you grew up in Fortaleza and moved to Australia in 2017";
    expect(!isNoise(tp1) && isPersonal(tp1) && themesFor(tp1).length > 0).toBe(true);

    const tp2 = "Pedro is restating a deeply personal account of his family losing their income.";
    expect(!isPersonal(tp2) && isDisclosure(tp2) && themesFor(tp2).length > 0).toBe(true);
    expect(isDisclosure("a vulnerable response about family dynamics")).toBe(true);
  });

  test("life thread", () => {
    expect(themesFor("My role? receptionist and cleaner at the sauna")).toContain("life");
    expect(themesFor("I taught myself IT off YouTube, no mentor")).toContain("life");
    expect(themesFor("I moved to Australia in 2017")).toContain("life");
    expect(themesFor("eu trabalhava na Oi quando eu era novo")).toContain("life");
    expect(themesFor("doppler_project.mph: Importing [id=mph]")).not.toContain("life");
    expect(themesFor("uber tesla mph goal news")).not.toContain("life");
  });

  test("passageHash stability", () => {
    const cases = [
      "Hello  World",
      "hello world",
      "my mother and father passed away",
      "Leo is my partner",
      "A".repeat(500),
    ];
    for (const text of cases) {
      const hist = historicalPassageHash(text);
      const stdHash = contentHash(text);
      expect(stdHash).toBe(hist);
    }
  });

  test("pickBestPerUuid keeps largest", () => {
    const best = pickBestPerUuid([
      { uuid: "x", filePath: "/a", size: 10, sourceLabel: "s1", isSubagent: false },
      { uuid: "x", filePath: "/b", size: 99, sourceLabel: "s2", isSubagent: false },
      { uuid: "x", filePath: "/c", size: 5, sourceLabel: "s3", isSubagent: true },
    ]);
    expect(best.get("x")?.size).toBe(99);
    expect(best.get("x::sub")?.size).toBe(5);
  });
});
