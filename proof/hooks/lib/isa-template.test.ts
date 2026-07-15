import { describe, expect, test } from "bun:test";
import { dateParts, isoDate } from "std/core";

import {
  curateTitle,
  generateISAFilename,
  generateISAId,
  generateISATemplate,
  generatePRDFilename,
  generatePRDId,
  generatePRDTemplate,
} from "./isa-template";

const TZ = "Australia/Melbourne";

describe("curateTitle — collapse swap + caller-local word-boundary truncate (E2)", () => {
  test("strips leading filler and capitalizes", () => {
    expect(curateTitle("please build the dashboard")).toBe("Build the dashboard");
    expect(curateTitle("can you fix the parser")).toBe("Fix the parser");
  });

  test("strips profanity", () => {
    expect(curateTitle("fucking fix the parser")).toBe("Fix the parser");
  });

  test("collapses internal whitespace (core.collapse ≡ old `\\s+`→` ` + trim)", () => {
    expect(curateTitle("build    the\t\tthing")).toBe("Build the thing");
  });

  test("empty → 'Untitled Task'", () => {
    expect(curateTitle("   ")).toBe("Untitled Task");
  });

  test("truncates at a WORD boundary with NO ellipsis (not core.truncate)", () => {
    const long =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau";
    const out = curateTitle(long);
    expect(long.length).toBeGreaterThan(80); // precondition — the truncate branch actually runs
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.length).toBeGreaterThan(40); // word-boundary path taken (lastSpace > 40)
    expect(out).not.toContain("..."); // word-boundary cut, never an ellipsis
    expect(out.endsWith(" ")).toBe(false);
    // Cut lands on a word boundary — the result is a prefix of the capitalized input ending on a whole word.
    const capital = long.charAt(0).toUpperCase() + long.slice(1);
    expect(capital.startsWith(out)).toBe(true);
    expect(capital[out.length]).toBe(" "); // the char immediately after the cut is the boundary space
  });
});

describe("generateISAFilename / generateISAId — dateParts(Melbourne) stamp (validator)", () => {
  test("filename shape ISA-YYYYMMDD-slug.md with Pedro's-tz date", () => {
    const stamp = dateParts(new Date(), TZ).iso.replace(/-/g, "");
    expect(generateISAFilename("my-slug")).toBe(`ISA-${stamp}-my-slug.md`);
    expect(generateISAId("my-slug")).toBe(`ISA-${stamp}-my-slug`);
  });

  test("8-digit compact stamp (no dashes)", () => {
    expect(generateISAFilename("x")).toMatch(/^ISA-\d{8}-x\.md$/);
    expect(generateISAId("x")).toMatch(/^ISA-\d{8}-x$/);
  });

  test("deprecated PRD aliases are the same function", () => {
    expect(generatePRDFilename).toBe(generateISAFilename);
    expect(generatePRDId).toBe(generateISAId);
    expect(generatePRDTemplate).toBe(generateISATemplate);
  });
});

describe("generateISATemplate — body preserved (D4), UTC `today` via core.isoDate", () => {
  const out = generateISATemplate({
    title: "fallback title",
    slug: "sess-1",
    effortLevel: "Standard",
    prompt: "please build the widget",
  });

  test("frontmatter: id + curated title + UTC created/updated date", () => {
    const stamp = dateParts(new Date(), TZ).iso.replace(/-/g, "");
    const today = isoDate(new Date());
    expect(out).toContain(`id: ISA-${stamp}-sess-1`);
    expect(out).toContain(`title: "Build the widget"`); // curateTitle applied to the prompt
    expect(out).toContain(`created: ${today}`);
    expect(out).toContain(`updated: ${today}`);
  });

  test("template body (caller identity — D4) preserved verbatim", () => {
    expect(out).toContain("## ISC Criteria");
    expect(out).toContain("## APPETITE");
    expect(out).toContain("8-16 criteria"); // STANDARD ISC target from ISC_MINIMUMS
    expect(out).toContain("<2min"); // STANDARD budget from APPETITE_MAP
    expect(out).toContain("### Problem Space\nplease build the widget");
  });

  test("unknown effort falls back to STANDARD guides", () => {
    const o = generateISATemplate({ title: "t", slug: "s", effortLevel: "BOGUS" });
    expect(o).toContain("8-16 criteria");
  });
});
