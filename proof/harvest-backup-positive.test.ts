import { expect, test, describe } from "bun:test";
import {
  classifyPraise,
  parseLearning,
  eventOf,
} from "./harvest-backup-positive";
import { dateFromLabel, discoverBackupSources } from "./backup-harvest-common";
import { contentHash } from "std/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// Category 6 (RT-2, AD-9.3, AC7): a backup archive taken AFTER the LifeOS rename carries a `LIFEOS/…`
// (or `.claude/LIFEOS/…`) LEARNING layout. The dual-root walk gained LIFEOS branches so those archives are
// still discovered — a half-rename of the backup path would silently skip LifeOS backups. Assert all four
// layouts (LIFEOS + legacy PAI, each at the two claude-home depths) are discovered.
describe("RT-2 backup layout — LifeOS archives are discovered (AC7)", () => {
  for (const layout of ["LIFEOS", join(".claude", "LIFEOS"), "PAI", join(".claude", "PAI")]) {
    test(`discovers a ${layout}/MEMORY/LEARNING archive`, () => {
      const backupsDir = mkdtempSync(join(tmpdir(), "bk-rt2-"));
      const learningDir = join(backupsDir, "Backup-2026-07-12", layout, "MEMORY", "LEARNING");
      mkdirSync(learningDir, { recursive: true });
      writeFileSync(join(learningDir, "note.md"), "# a learning\n");
      try {
        const { sources } = discoverBackupSources(backupsDir, false, join(backupsDir, "_out"), true);
        expect(sources.map((s) => s.label)).toContain("Backup-2026-07-12");
      } finally {
        rmSync(backupsDir, { recursive: true, force: true });
      }
    });
  }
});
