import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generate, telosDir } from "./generate-telos-summary";

// ── A hermetic synthetic ~/.claude/PAI/USER/TELOS tree. Never touches the real estate. ──
const NOW = new Date("2026-07-12T09:08:07.006Z"); // pinned clock — the staleness timestamp line

function makeTelosDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "telos-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe("generate — full-document byte contract", () => {
  test("assembles every section in order with the injected timestamp", () => {
    const dir = makeTelosDir({
      "MISSION.md": "- **M0**: Build AI-native systems that work autonomously.\n- **M1**: Geographic freedom.\n",
      "GOALS.md": "- **G1**: Ship the thing — with a second clause. Extra.\n- **G9**: Grow visitors.\n- **G3**: A deferred older goal that runs quite long indeed here.\n",
      "PROBLEMS.md": "## P1: Employment is fragile (a parenthetical that gets stripped)\n## P2: Platforms are fragile\n",
      "STRATEGIES.md": "## S1: Stack revenue streams\n### S2: Automate everything (aside)\n",
      "NARRATIVES.md": "- **N0**: I am a builder.\n- **N2**: I run two businesses.\n- **N7**: AI is the OS.\n",
      "CHALLENGES.md": "- **C1**: Time fragmentation across many competing streams.\n",
      "WRONG.md": "- Underestimated brand-trust build time.\n- Started more than I finished.\n",
      "TRAUMAS.md": "- **TR0**: A formative experience.\n",
      "MODELS.md": "- **MOD1**: Decision then execute then measure. Second sentence dropped.\n- **MOD2**: Second model here.\n- **MOD3**: Third model here.\n- **MOD4**: Fourth is sliced off.\n",
    });
    try {
      const out = generate(dir, NOW);
      expect(out).toBe(
        [
          "# Principal TELOS — {{PRINCIPAL_FULL_NAME}}",
          "",
          "> Auto-generated from TELOS source files. Do not edit manually.",
          "> Generated: 2026-07-12T09:08:07.006Z | Sources: MISSION, GOALS, PROBLEMS, STRATEGIES, NARRATIVES, CHALLENGES, WRONG, TRAUMAS, MODELS",
          "",
          "## Missions",
          "",
          "- **M0**: Build AI-native systems that work autonomously.",
          "- **M1**: Geographic freedom.",
          "",
          "## Active Goals (2026)",
          "",
          "- **G1**: Ship the thing",
          "- **G9**: Grow visitors.",
          "",
          "_Deferred (full text in TELOS/GOALS.md): G3_",
          "",
          "## Problems Being Solved",
          "",
          "- **P1**: Employment is fragile",
          "- **P2**: Platforms are fragile",
          "",
          "## Strategies",
          "",
          "- **S1**: Stack revenue streams",
          "- **S2**: Automate everything",
          "",
          "## Active Narratives",
          "",
          "- **N0**: I am a builder.",
          "- **N7**: AI is the OS.",
          "- N2: I run two businesses.",
          "",
          "## Personal Challenges",
          "",
          "- **C1**: Time fragmentation across many competing streams.",
          "",
          "## Formative Experiences (Traumas)",
          "",
          "- **TR0**: A formative experience.",
          "",
          "## Things I've Been Wrong About (Mistakes)",
          "",
          "- Underestimated brand-trust build time.",
          "- Started more than I finished.",
          "",
          "## Core Models",
          "",
          "- Decision then execute then measure",
          "- Second model here.",
          "- Third model here.",
          "",
          "## Context Filter",
          "",
          "When steering work, bias toward: human flourishing, Human 3.0 transition, AI augmentation strategies, becoming one's full self, correct framing.",
        ].join("\n") + "\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing source files are treated as empty; optional sections are omitted", () => {
    // Only MISSION present → no deferred line, no Traumas/Wrong sections, empty Goals/Problems/etc.
    const dir = makeTelosDir({ "MISSION.md": "- **M0**: Only a mission here.\n" });
    try {
      const out = generate(dir, NOW);
      expect(out).toContain("- **M0**: Only a mission here.");
      expect(out).not.toContain("_Deferred");
      expect(out).not.toContain("## Formative Experiences");
      expect(out).not.toContain("## Things I've Been Wrong About");
      // Still emits the fixed skeleton sections + epilogue.
      expect(out).toContain("## Problems Being Solved");
      expect(out).toContain("## Context Filter");
      expect(out.endsWith("correct framing.\n")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("timestamp — full ISO 8601, not date-only (isoDate would break the bytes)", () => {
  test("Generated line carries the full toISOString() with ms + Z", () => {
    const dir = makeTelosDir({ "MISSION.md": "- **M0**: x\n" });
    try {
      const out = generate(dir, NOW);
      expect(out).toContain("> Generated: 2026-07-12T09:08:07.006Z |");
      expect(out).not.toContain("> Generated: 2026-07-12 |");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("truncate width mapping — fixed-width variants ≡ core.truncate(x, 60)", () => {
  test("PROBLEMS/STRATEGIES titles > 60 chars cut to 57 + ellipsis (char boundary)", () => {
    const longP = "Employment dependence is fragile and this title is definitely well over sixty characters long";
    const longS = "Stack revenue streams that Pedro controls and this one is also way over the sixty char threshold";
    const dir = makeTelosDir({
      "PROBLEMS.md": `## P1: ${longP}\n`,
      "STRATEGIES.md": `## S1: ${longS}\n`,
    });
    try {
      const out = generate(dir, NOW);
      // First 57 chars of the title + "..." (parenthetical-strip is a no-op here → whole title is the match).
      expect(out).toContain(`- **P1**: ${longP.substring(0, 57)}...`);
      expect(out).toContain(`- **S1**: ${longS.substring(0, 57)}...`);
      // 57 visible chars + 3 ellipsis = 60 total.
      const pLine = out.split("\n").find((l) => l.startsWith("- **P1**:"))!;
      expect(pLine.slice("- **P1**: ".length).length).toBe(60);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("titles ≤ 60 chars are left untouched (no ellipsis)", () => {
    const dir = makeTelosDir({ "PROBLEMS.md": "## P1: Short title\n" });
    try {
      const out = generate(dir, NOW);
      expect(out).toContain("- **P1**: Short title");
      expect(out).not.toContain("Short title...");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("truncate width mapping — word-boundary helper preserved (NOT core.truncate)", () => {
  test("mission text > 75 chars trims back to a whole word before the ellipsis", () => {
    // 90-char text; char 75 lands mid-word. Word-boundary truncate drops the partial word.
    const text = "Build AI native systems that remember everything and act on my behalf across every surface";
    const dir = makeTelosDir({ "MISSION.md": `- **M0**: ${text}\n` });
    try {
      const out = generate(dir, NOW);
      const line = out.split("\n").find((l) => l.startsWith("- **M0**:"))!;
      const shown = line.slice("- **M0**: ".length);
      expect(shown.endsWith("...")).toBe(true);
      const body = shown.slice(0, -3);
      // Word-boundary: no trailing partial word — the shown body is a prefix ending on a full word.
      expect(text.startsWith(body)).toBe(true);
      expect(text[body.length]).toBe(" "); // cut fell exactly on a space boundary
      // And it differs from the char-boundary core.truncate result (proves the local helper is load-bearing).
      expect(shown).not.toBe(text.slice(0, 72) + "...");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parse edge cases (caller-local domain parse preserved)", () => {
  test("goals: G0/G1 and G9+ are active; G2..G8 defer; em-dash/period split takes first sentence", () => {
    const dir = makeTelosDir({
      "GOALS.md": [
        "- **G0**: Zero goal — with trailing clause",
        "- **G1**: One goal. Second sentence dropped",
        "- **G5**: Deferred five.",
        "- **G12**: Active twelve.",
      ].join("\n") + "\n",
    });
    try {
      const out = generate(dir, NOW);
      expect(out).toContain("- **G0**: Zero goal");
      expect(out).toContain("- **G1**: One goal");
      expect(out).toContain("- **G12**: Active twelve.");
      expect(out).toContain("_Deferred (full text in TELOS/GOALS.md): G5_");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("problems: header scan strips trailing parenthetical; falls back to list items when no ## headers", () => {
    const headerDir = makeTelosDir({ "PROBLEMS.md": "## P1: Title here (strip me)\n" });
    const listDir = makeTelosDir({ "PROBLEMS.md": "- **P1**: Fragile income — because platforms\n" });
    try {
      expect(generate(headerDir, NOW)).toContain("- **P1**: Title here");
      expect(generate(headerDir, NOW)).not.toContain("(strip me)");
      // Fallback list path: splits on em/hyphen, strips bold markers.
      expect(generate(listDir, NOW)).toContain("- **P1**: Fragile income");
    } finally {
      rmSync(headerDir, { recursive: true, force: true });
      rmSync(listDir, { recursive: true, force: true });
    }
  });

  test("narratives: N0/N1/N7 are primary bullets; others render as secondary `- id: text` lines", () => {
    const dir = makeTelosDir({
      "NARRATIVES.md": "- **N1**: Primary one.\n- **N3**: Secondary three.\n",
    });
    try {
      const out = generate(dir, NOW);
      expect(out).toContain("- **N1**: Primary one.");
      expect(out).toContain("- N3: Secondary three.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("telosDir — resolves the framework dir under the injected HOME (RT-2, AD-9.3)", () => {
  // Category 4: no framework-root env — telosDir resolves purely via resolveFrameworkDir(home).
  test("fresh tree → LIFEOS default (the new name)", () => {
    const dir = mkdtempSync(join(tmpdir(), "telos-rt2-"));
    try {
      expect(telosDir(dir)).toBe(join(dir, ".claude", "LIFEOS", "USER", "TELOS"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("legacy PAI tree present → resolves under PAI (transition window)", () => {
    const dir = mkdtempSync(join(tmpdir(), "telos-rt2-"));
    mkdirSync(join(dir, ".claude", "PAI"), { recursive: true });
    try {
      expect(telosDir(dir)).toBe(join(dir, ".claude", "PAI", "USER", "TELOS"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("LIFEOS tree present → resolves under LIFEOS", () => {
    const dir = mkdtempSync(join(tmpdir(), "telos-rt2-"));
    mkdirSync(join(dir, ".claude", "LIFEOS"), { recursive: true });
    try {
      expect(telosDir(dir)).toBe(join(dir, ".claude", "LIFEOS", "USER", "TELOS"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
