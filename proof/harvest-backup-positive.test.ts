import { expect, test, describe } from "bun:test";
import {
  classifyPraise,
  parseLearning,
  eventOf,
} from "./harvest-backup-positive";
import { dateFromLabel } from "./backup-harvest-common";
import { contentHash } from "std/core";

// Historical posHash implementation to verify stability
function historicalPosHash(text: string): string {
  const norm = text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 300);
  let h = 5381;
  for (let i = 0; i < norm.length; i++) h = (h * 33) ^ norm.charCodeAt(i);
  return (h >>> 0).toString(16);
}

describe("harvest-backup-positive Unit Tests", () => {
  test("classifyPraise — strong / rating / soft / negation / question", () => {
    expect(classifyPraise("that worked perfectly, thank you")?.tier).toBe(2);
    expect(classifyPraise("I'd rate this 9/10")?.tier).toBe(2);
    expect(classifyPraise("thanks, that helps")?.tier).toBe(3);
    expect(classifyPraise("that's not quite right")).toBeNull();
    expect(classifyPraise("is that perfect?")).toBeNull();
    expect(classifyPraise("the build is broken")).toBeNull();
  });

  test("Portuguese (PT-BR) + lang gating", () => {
    expect(classifyPraise("perfeito, é isso mesmo")?.tier).toBe(2);
    expect(classifyPraise("valeu, ajudou muito")?.tier).toBe(3);
    expect(classifyPraise("não ficou bom")).toBeNull();
    expect(classifyPraise("perfeito", "en")).toBeNull();
    expect(classifyPraise("perfect", "pt")).toBeNull();
  });

  test("parseLearning", () => {
    const lr = parseLearning("---\nrating: 9\n---\n**Feedback:** led with the answer, exactly right");
    expect(lr?.rating).toBe(9);
    expect(lr?.feedback).toContain("led with the answer");
    expect(parseLearning("no rating here")).toBeNull();
  });

  test("dateFromLabel", () => {
    expect(dateFromLabel(".claude_2026-06-20_16-17-07.tar.gz")).toBe("2026-06-20");
    expect(dateFromLabel(".claude.backup-2026-05-27-extracted")).toBe("2026-05-27");
    expect(dateFromLabel("no-date-here")).toBe("0000-00-00");
  });

  test("eventOf", () => {
    expect(eventOf({ type: "user", message: { role: "user", content: "thanks!" } })?.role).toBe("user");
    expect(eventOf({ type: "assistant", message: { role: "assistant", content: "done" } })?.role).toBe("assistant");
    expect(eventOf({ type: "user", message: { content: "<system-reminder> blah blah blah" } })?.role).toBe("other");
  });

  test("posHash stability", () => {
    const cases = [
      "Hello  World",
      "hello world",
      "exactly what I needed",
      "A".repeat(500),
    ];
    for (const text of cases) {
      const hist = historicalPosHash(text);
      const stdHash = contentHash(text, 300);
      expect(stdHash).toBe(hist);
    }
  });
});
