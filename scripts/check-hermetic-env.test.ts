import { test, expect } from "bun:test";
import { scanSource, ROOT_KEYS } from "./check-hermetic-env";

// The gate this exercises is a tripwire for a bug that shipped: tests pinned PAI_DIR alone, an
// ambient LIFEOS_DIR outranked it, and `main()` — a WRITER — appended to the caller's real estate.
// Every case below is either a shape that must stay red or a shape from the live corpus that must
// stay green. The gate had no test file when it was written; that is how its first draft shipped
// unable to fail at all, and how its second draft reported 12 false positives.

test("the shipped bug shape is flagged: PAI_DIR pinned, LIFEOS_DIR never mentioned", () => {
  const findings = scanSource(`
    const prev = process.env.PAI_DIR;
    process.env.PAI_DIR = dir;
    try { main([]); } finally { process.env.PAI_DIR = prev; }
  `);
  expect(findings).toHaveLength(1);
  expect(findings[0]!.key).toBe("PAI_DIR");
  expect(findings[0]!.missing).toEqual(["LIFEOS_DIR"]);
});

test("the fix shape is clean: both keys pinned and both restored", () => {
  expect(
    scanSource(`
      const prev = process.env.PAI_DIR;
      const prevLifeos = process.env.LIFEOS_DIR;
      process.env.PAI_DIR = dir;
      process.env.LIFEOS_DIR = dir;
      try { main([]); } finally {
        if (prev === undefined) delete process.env.PAI_DIR;
        else process.env.PAI_DIR = prev;
        if (prevLifeos === undefined) delete process.env.LIFEOS_DIR;
        else process.env.LIFEOS_DIR = prevLifeos;
      }
    `),
  ).toEqual([]);
});

test("a bare `delete` of the higher key IS a pin — the precedence-test idiom is clean", () => {
  // `test("PAI_DIR honored when LIFEOS_DIR unset")` cannot assign LIFEOS_DIR; unsetting it IS how it
  // makes PAI_DIR authoritative, and it is hermetic. Counting assignments only, the gate flagged all
  // 12 such blocks in the corpus as exposures.
  expect(
    scanSource(`
      delete process.env.LIFEOS_DIR;
      process.env.PAI_DIR = "/pai";
      expect(resolve()).toBe("/pai");
    `),
  ).toEqual([]);
});

test("a restore-only higher key is still flagged — `delete` in a restore is NOT a pin", () => {
  // The regression the delete-counting fix could have introduced: LIFEOS_DIR appears twice, but only
  // ever to hand the caller's value back. It is never removed while the test runs, so an ambient
  // value outranks the pinned PAI_DIR for the whole body.
  const findings = scanSource(`
    const prevLifeos = process.env.LIFEOS_DIR;
    process.env.PAI_DIR = dir;
    try { main([]); } finally {
      process.env.PAI_DIR = prevPai;
      if (prevLifeos === undefined) delete process.env.LIFEOS_DIR;
      else process.env.LIFEOS_DIR = prevLifeos;
    }
  `);
  expect(findings).toHaveLength(1);
  expect(findings[0]!.missing).toEqual(["LIFEOS_DIR"]);
});

test("two PAI_DIR pins against one LIFEOS_DIR pin is flagged — counts, not presence", () => {
  const findings = scanSource(`
    process.env.LIFEOS_DIR = a;
    process.env.PAI_DIR = a;
    process.env.PAI_DIR = b;
  `);
  expect(findings).toHaveLength(1);
  expect(findings[0]!.key).toBe("PAI_DIR");
});

test("prose naming a key is not a finding — comments and strings are masked", () => {
  expect(
    scanSource(`
      // an ambient process.env.PAI_DIR = x would outrank the tmp dir
      const KEYS = ["LIFEOS_DIR", "PAI_DIR"] as const;
      /* process.env.PAI_DIR = "/pai" */
    `),
  ).toEqual([]);
});

test("a file that touches neither key is clean", () => {
  expect(scanSource(`const x = 1; process.env.HOME = home;`)).toEqual([]);
});

test("the finding points at the first pin of the offending key", () => {
  const findings = scanSource(["const a = 1;", "const b = 2;", "process.env.PAI_DIR = dir;"].join("\n"));
  expect(findings[0]!.line).toBe(3);
});

test("precedence order is highest-first — the top key outranks nothing", () => {
  expect(ROOT_KEYS[0]).toBe("LIFEOS_DIR");
  expect(scanSource(`process.env.LIFEOS_DIR = dir;`)).toEqual([]);
});
