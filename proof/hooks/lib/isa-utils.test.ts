import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as isa from "./isa-utils";
import {
  countCriteria,
  diagnoseCriteria,
  extractCriteriaSection,
  parseCapabilities,
  parseCriteriaList,
  parseFrontmatter,
  writeFrontmatterField,
} from "./isa-utils";

// ── Task-5 FACADE-STABILITY ASSERTION (AD-9.4 Rule 3 — the story's signature test) ───────────────────
// Every VALUE export the 10 importers across 5 stories pin must exist with its expected runtime kind. The
// internal collapse touched only bodies; a dropped/renamed export is a review-blocker. (Type-only exports —
// interfaces/aliases — have no runtime presence, so they are validated by `typecheck:proof`, not here. The
// byte-exact `^export`-line diff vs the LIVE module is verified at deploy time by the dispatcher.)
describe("frozen facade — every pinned export present with its runtime kind", () => {
  const CONST_STRINGS = [
    "WORK_DIR",
    "WORK_JSON",
    "ARTIFACT_FILENAME",
    "LEGACY_ARTIFACT_FILENAME",
    "CANONICAL_CRITERIA_HEADING",
  ] as const;
  const FUNCTIONS = [
    "findArtifactPath",
    "findLatestISA",
    "findLatestPRD", // deprecated alias
    "parseFrontmatter",
    "writeFrontmatterField",
    "extractCriteriaSection",
    "countCriteria",
    "parseCriteriaList",
    "extractIntentSnippet",
    "diagnoseCriteria",
    "parseCapabilities",
    "getSessionAgents",
    "readRegistry",
    "writeRegistry",
    "appendPhase",
    "syncToWorkJson",
    "bumpLastToolActivity",
    "updateSessionNameInWorkJson",
    "upsertSession",
    "upsertNativeSession", // deprecated alias
    "addRatingPulse",
  ] as const;

  test("string consts exported", () => {
    for (const name of CONST_STRINGS) {
      expect(typeof (isa as Record<string, unknown>)[name]).toBe("string");
    }
  });

  test("ARTIFACT_FILENAME / LEGACY_ARTIFACT_FILENAME hold their frozen values", () => {
    expect(isa.ARTIFACT_FILENAME).toBe("ISA.md");
    expect(isa.LEGACY_ARTIFACT_FILENAME).toBe("PRD.md");
    expect(isa.CANONICAL_CRITERIA_HEADING).toBe("## ISC Criteria");
  });

  test("CRITERIA_HEADING_RE is a RegExp", () => {
    expect(isa.CRITERIA_HEADING_RE).toBeInstanceOf(RegExp);
  });

  test("every function export is callable", () => {
    for (const name of FUNCTIONS) {
      expect(typeof (isa as Record<string, unknown>)[name]).toBe("function");
    }
  });

  test("deprecated aliases point at their canonical target", () => {
    expect(isa.findLatestPRD).toBe(isa.findLatestISA);
    expect(isa.upsertNativeSession).toBe(isa.upsertSession);
  });
});

// ── parseFrontmatter shape-adapt (AC2 — the sharpest defect trap) ────────────────────────────────────
describe("parseFrontmatter — core.parseFrontmatter with the null/array shape-adapt", () => {
  test("no `---` block → null (the load-bearing adapt; both hooks guard `if (!fm) return`)", () => {
    expect(parseFrontmatter("# Just a heading\n\nno frontmatter here")).toBeNull();
    expect(parseFrontmatter("")).toBeNull();
  });

  test("real ISA frontmatter fields are SCALAR strings (the E6 unreachability assertion)", () => {
    const content = `---
isa: true
slug: my-session
phase: build
progress: 3/8
title: "Do the thing"
---

# Do the thing`;
    const fm = parseFrontmatter(content);
    expect(fm).not.toBeNull();
    // Every value is a plain string — no live ISA field is an array, so the defensive array-coercion
    // branch below is never reached in practice.
    for (const v of Object.values(fm!)) {
      expect(typeof v).toBe("string");
    }
    expect(fm!.slug).toBe("my-session");
    expect(fm!.phase).toBe("build");
    expect(fm!.title).toBe("Do the thing"); // quotes stripped, colon-free scalar
  });

  test("a value containing a colon is preserved (split on FIRST colon only)", () => {
    const fm = parseFrontmatter(`---\ntitle: Foo: bar baz\n---\n`);
    expect(fm!.title).toBe("Foo: bar baz");
  });

  test("DEFENSIVE-ONLY (unreachable) array value → bracket-literal string, never a raw array", () => {
    const fm = parseFrontmatter(`---\ntags: [a, b, c]\n---\n`);
    expect(fm).not.toBeNull();
    expect(Array.isArray(fm!.tags)).toBe(false);
    expect(typeof fm!.tags).toBe("string");
    expect(fm!.tags).toBe("[a, b, c]"); // reconstructed literal — closest to the old facade's byte shape
  });
});

// ── writeFrontmatterField (DEFER — kept verbatim; 0 live callers) ─────────────────────────────────────
describe("writeFrontmatterField — kept caller-local verbatim (DEFER)", () => {
  test("updates an existing field in place", () => {
    const out = writeFrontmatterField(`---\nphase: observe\nslug: x\n---\nbody`, "phase", "build");
    expect(out).toContain("phase: build");
    expect(out).toContain("slug: x");
    expect(out).toContain("\nbody");
  });
  test("appends a missing field", () => {
    const out = writeFrontmatterField(`---\nslug: x\n---\nbody`, "phase", "plan");
    expect(out).toContain("phase: plan");
  });
  test("no frontmatter → returned unchanged", () => {
    expect(writeFrontmatterField(`no fm`, "phase", "plan")).toBe("no fm");
  });
});

// ── extractCriteriaSection / parseCriteriaList / countCriteria (KEEP CALLER-LOCAL VERBATIM — ENH-1) ───
describe("extractCriteriaSection — multi-variant heading + `\\n##`/`\\n---` boundary (verbatim)", () => {
  test("`## ISC Criteria` heading, ends at next H2", () => {
    const c = `## ISC Criteria\n- [ ] ISC-1: a\n- [x] ISC-2: b\n\n## Next\nunrelated`;
    const body = extractCriteriaSection(c);
    expect(body).toContain("ISC-1: a");
    expect(body).toContain("ISC-2: b");
    expect(body).not.toContain("unrelated");
  });

  test("`## IDEAL STATE CRITERIA` variant + `### Criteria` sub-heading both recognized", () => {
    expect(extractCriteriaSection(`## IDEAL STATE CRITERIA (Verification)\n- [ ] ISC-1: x`)).toContain("ISC-1: x");
    expect(extractCriteriaSection(`### Criteria\n- [ ] ISC-1: y`)).toContain("ISC-1: y");
  });

  test("boundary stops at a `---` doc terminator (core.findSection could not reproduce this)", () => {
    const body = extractCriteriaSection(`## Criteria\n- [x] ISC-1: kept\n---\n- [ ] ISC-2: dropped`);
    expect(body).toContain("ISC-1: kept");
    expect(body).not.toContain("ISC-2: dropped");
  });

  test("no recognized heading → null", () => {
    expect(extractCriteriaSection(`## Something Else\n- [ ] ISC-1: x`)).toBeNull();
  });
});

describe("parseCriteriaList / countCriteria — ISC-domain parse (verbatim)", () => {
  const content = `## ISC Criteria
- [ ] ISC-1: build the thing
- [x] ISC-2: Anti: never crash
- [x] ISC-3 [F]: legacy bracket cat
- [ ] ISC-4 [COMPLETE] no-colon fallback`;

  test("counts checked/total over checkbox lines", () => {
    expect(countCriteria(content)).toEqual({ checked: 2, total: 4 });
  });

  test("parses ids, anti-criterion, legacy category, and the no-colon fallback", () => {
    const list = parseCriteriaList(content);
    expect(list.map((c) => c.id)).toEqual(["ISC-1", "ISC-2", "ISC-3", "ISC-4"]);
    expect(list[1].type).toBe("anti-criterion"); // `Anti:` prose prefix
    expect(list[1].status).toBe("completed");
    expect(list[2].category).toBe("F"); // legacy bracket category retained
    expect(list[3].description).toBe("no-colon fallback"); // `[COMPLETE]` stripped
  });

  test("no criteria section → empty list / zero counts", () => {
    expect(parseCriteriaList("# no criteria")).toEqual([]);
    expect(countCriteria("# no criteria")).toEqual({ checked: 0, total: 0 });
  });
});

describe("diagnoseCriteria — loud-fail warning classification (verbatim)", () => {
  test("missing / empty / all-dropped / healthy", () => {
    expect(diagnoseCriteria("# nothing")).toBe("missing-section");
    expect(diagnoseCriteria("## ISC Criteria\n\n(no checkboxes)")).toBe("empty-section");
    expect(diagnoseCriteria("## ISC Criteria\n- [ ] not-an-isc line")).toBe("all-dropped");
    expect(diagnoseCriteria("## ISC Criteria\n- [ ] ISC-1: ok")).toBeNull();
  });
});

describe("parseCapabilities — 🏹 block parse (verbatim)", () => {
  test("extracts capability names, strips reasoning after | / — / :", () => {
    const c = `🏹 CAPABILITIES SELECTED:\n 🏹 Research | for the facts\n 🏹 Forge — code\n\nnext section`;
    expect(parseCapabilities(c)).toEqual(["Research", "Forge"]);
  });
});

// ── readRegistry sessions-guard (validator E5) — hermetic via a subprocess with a temp PAI_DIR ────────
// readRegistry bakes WORK_JSON from paiPath at import, so it can only be redirected by a fresh process with
// PAI_DIR set. A subprocess guarantees Pedro's real ~/.claude work.json is NEVER touched. Proves:
// fsx.loadJson returns the RAW parsed value, so a sessionless JSON must still normalize to {sessions:{}}.
describe("readRegistry — `.sessions` guard re-applied after fsx.loadJson (E5)", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  async function readRegistryUnder(workJsonContent: string | null): Promise<any> {
    const root = mkdtempSync(join(tmpdir(), "isa-utils-e5-"));
    roots.push(root);
    const paiDir = join(root, "PAI");
    if (workJsonContent !== null) {
      const stateDir = join(paiDir, "MEMORY", "STATE");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "work.json"), workJsonContent);
    }
    const probe = join(root, "probe.ts");
    writeFileSync(
      probe,
      `import { readRegistry } from ${JSON.stringify(join(import.meta.dir, "isa-utils.ts"))};\n` +
        `console.log(JSON.stringify(readRegistry()));\n`,
    );
    const proc = Bun.spawn(["bun", "run", probe], {
      env: { ...process.env, PAI_DIR: paiDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(err).not.toContain("Cannot find module"); // door resolves std/* under the subprocess too
    return JSON.parse(out.trim());
  }

  test("missing work.json → {sessions:{}}", async () => {
    expect(await readRegistryUnder(null)).toEqual({ sessions: {} });
  });

  test("sessionless JSON (`{\"foo\":1}`) normalizes to {sessions:{}} (the E5 guard)", async () => {
    expect(await readRegistryUnder(`{"foo":1}`)).toEqual({ sessions: {} });
  });

  test("a JSON WITH `.sessions` passes through unchanged", async () => {
    const withSessions = { sessions: { s1: { task: "t", phase: "build" } } };
    expect(await readRegistryUnder(JSON.stringify(withSessions))).toEqual(withSessions);
  });
});
