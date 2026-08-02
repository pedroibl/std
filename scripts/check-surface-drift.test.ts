import { describe, expect, test } from "bun:test";

import { scanFlagReads, surfaceFlagNames, unknownReads } from "./check-surface-drift";

describe("scanFlagReads — the three readers, matched on their string literal (AC8)", () => {
  test("finds all three reader shapes", () => {
    const src = `
      const a = hasFlag(argv, "apply");
      const b = flagValue(rest, "vault");
      const c = collectFlagValues(argv, "set");
    `;
    expect(scanFlagReads(src).map((r) => r.name)).toEqual(["apply", "vault", "set"]);
  });

  // The non-read that would break a naive gate #1: prose. `src/bmad/opts.ts` genuinely carries one.
  test("a reader named inside a `//` comment is masked away, not flagged", () => {
    const src = `// Do NOT rewrite this as hasFlag(argv,"totally-made-up") || apply\nconst x = 1;`;
    expect(scanFlagReads(src)).toEqual([]);
  });

  test("a reader inside a block comment is masked away too", () => {
    expect(scanFlagReads(`/* hasFlag(argv, "totally-made-up") */`)).toEqual([]);
  });

  // The non-read that would break a naive gate #2: the reader's own DEFINITION. `manifest.ts:311` reads
  // `function collectFlagValues(argv: string[], name: string)` — it matches the pattern by its own name,
  // and its second argument is the identifier `name`. A gate scraping "the second argument" as text
  // would print `✗ manifest.ts:311  name` and fail the build on correct code. Matching a quoted literal
  // skips it for free.
  test("the collectFlagValues DEFINITION line is not a read", () => {
    const src = `function collectFlagValues(argv: string[], name: string): string[] { return []; }`;
    expect(scanFlagReads(src)).toEqual([]);
  });

  test("reports the line number of each read", () => {
    const src = `const x = 1;\nconst y = 2;\nconst z = hasFlag(argv, "json");\n`;
    expect(scanFlagReads(src)).toEqual([{ name: "json", line: 3 }]);
  });
});

describe("surfaceFlagNames — the union the gate asserts against (AC8)", () => {
  const known = surfaceFlagNames();

  // All 11 names the shipped census reads: 7 bmad, 3 edge, plus `set` via collectFlagValues.
  test("covers every name the real code reads today", () => {
    for (const name of [
      "apply",
      "push",
      "force-track",
      "skills",
      "repos",
      "tools",
      "json",
      "vault",
      "format",
      "watch",
      "set",
    ]) {
      expect(known.has(name), name).toBe(true);
    }
  });

  // GLOBAL, never per-subcommand. `deploy.ts` reads `"repos"` in order to REFUSE it (BM-19), so the
  // union must carry a name that `bmad deploy`'s own entry deliberately omits — the exact case a
  // per-subcommand gate would fail the build on.
  test("is a UNION: it carries --repos even though bmad deploy refuses it", () => {
    expect(known.has("repos")).toBe(true);
  });

  test("stores names without the leading dashes, matching the readers' argument", () => {
    for (const n of known) expect(n.startsWith("-")).toBe(false);
  });
});

describe("unknownReads — the red-turning input (AC8)", () => {
  // 🔴 The non-vacuity fixture. Without this the gate could pass every input and nobody would know.
  test("a made-up flag is flagged, with its file line", () => {
    const src = `const bad = hasFlag(argv, "totally-made-up");`;
    expect(unknownReads(src)).toEqual([{ name: "totally-made-up", line: 1 }]);
  });

  test("the SAME literal inside a comment is NOT flagged — the masker is what separates them", () => {
    expect(unknownReads(`// const bad = hasFlag(argv, "totally-made-up");`)).toEqual([]);
  });

  test("a declared flag is not flagged", () => {
    expect(unknownReads(`const ok = hasFlag(argv, "apply");`)).toEqual([]);
  });

  test("mixed source reports only the undeclared read", () => {
    const src = `hasFlag(argv, "apply");\nflagValue(argv, "not-a-real-flag");\nhasFlag(argv, "json");`;
    expect(unknownReads(src).map((r) => r.name)).toEqual(["not-a-real-flag"]);
  });
});
