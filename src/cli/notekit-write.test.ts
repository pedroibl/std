import { test, expect, describe } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  composeBody,
  deriveFenceFields,
  runNotekitApply,
  type NotekitApplyDeps,
} from "./notekit-write";
import { errorText, runNotekitRead } from "./notekit-read";
import {
  createFence,
  locateFence,
  noteToRenderSpec,
  parseFenceBody,
  serializeFenceBody,
  validate,
  type FenceFields,
} from "../notekit/index";
import { parseFrontmatter } from "../core/index";
import { statMtime } from "../fsx";
import { stripStringsAndComments } from "../../scripts/lib/specifiers";

const AT = "2026-01-01T00:00:00.000Z";

const REGISTRY = {
  noteTypes: { card: "catalog-card" },
  templates: {
    "catalog-card": {
      renderer: "nk-card" as const,
      rubric: {
        kind: "card" as const,
        titleField: "title",
        fields: [{ key: "summary", label: "SUMMARY" }, { key: "status" }],
      },
    },
  },
};

/** A CANONICAL note — `serialize(parse(body))` already equals its body, so an apply is a byte no-op. */
const CANONICAL = ["---", "nk-type: card", "---", "", "```nk-card", "title: Primer", "summary: A thing", "status: live", "```", "", "prose after"].join("\n");

/** A NON-canonical note — ragged spacing plus a duplicate key, so an apply has real work to do. */
const MESSY = ["---", "nk-type: card", "---", "", "# Heading", "", "```nk-card", "  title :   Primer  ", "", "just prose, no colon", "summary: A thing", "status: draft", "status: live", "```", "", "trailing prose"].join("\n");

/** …and the bytes MESSY must become. Hand-written (oracle (d)): a human wrote these, not the offsets. */
const MESSY_APPLIED = ["---", "nk-type: card", "---", "", "# Heading", "", "```nk-card", "title: Primer", "summary: A thing", "status: live", "```", "", "trailing prose"].join("\n");

const CONFIG = ["--config", "cfg.ts"];

/** A capture harness: every effect injected, so these tests touch no real fs, stdin or clock. */
function harness(over: Partial<NotekitApplyDeps> = {}): {
  deps: NotekitApplyDeps;
  out: string[];
  err: string[];
  writes: Array<[string, string]>;
} {
  const out: string[] = [];
  const err: string[] = [];
  const writes: Array<[string, string]> = [];
  return {
    out,
    err,
    writes,
    deps: {
      log: (l) => out.push(l),
      err: (l) => err.push(l),
      now: () => AT,
      loadRegistry: async () => REGISTRY,
      readNote: () => MESSY,
      writeNote: (p, c) => writes.push([p, c]),
      ...over,
    },
  };
}

/** A reader that answers each successive call from a script — plan, re-read, read-back. */
function scriptedReads(...answers: Array<string | null>): () => string | null {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)] ?? null;
}

/** The envelope on stdout, for a `--json` run. */
function envelope(out: string[]): { ok: boolean; value?: Record<string, unknown>; error?: Record<string, unknown> } {
  expect(out).toHaveLength(1); // NK-7 rule 2 — the envelope is the ONLY thing on stdout
  return JSON.parse(out[0]!) as ReturnType<typeof envelope>;
}

// ── AC #5 — the ten outcomes, each with its byte-identity claim ───────────────────────────────────

describe("AC #5 row 1 — usage (2), no JSON on stdout, nothing written", () => {
  test("no <note> positional", async () => {
    const h = harness();
    expect(await runNotekitApply(["render", ...CONFIG, "--json"], h.deps)).toBe(2);
    expect(h.out).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.err.join("\n")).toContain("<note> path is required");
  });

  test("a missing --config", async () => {
    const h = harness();
    expect(await runNotekitApply(["render", "n.md", "--json"], h.deps)).toBe(2);
    expect(h.out).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  test("an UNLOADABLE --config", async () => {
    const h = harness({
      loadRegistry: () => {
        throw new Error("top-level throw at import");
      },
    });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG], h.deps)).toBe(2);
    expect(h.writes).toEqual([]);
  });

  test("a value flag with no value (--at trailing)", async () => {
    const h = harness();
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--at"], h.deps)).toBe(2);
    expect(h.out).toEqual([]);
    expect(h.writes).toEqual([]);
  });
});

describe("AC #5 rows 2–6 — Story 2.1's rows, RE-USED and not re-implemented", () => {
  const rows: Array<{ row: number; code: string; note: string | null }> = [
    { row: 2, code: "nk-note-unreadable", note: null },
    { row: 3, code: "nk-no-opt-in", note: "```nk-card\ntitle: A\n```\n" },
    { row: 4, code: "nk-no-fence", note: "---\nnk-type: card\n---\n\njust prose\n" },
    { row: 5, code: "nk-unknown-type", note: "---\nnk-type: card\n---\n\n```nk-other\ntitle: A\n```\n" },
  ];

  for (const { row, code, note } of rows) {
    test(`row ${row}: ${code} exits 1 and writes nothing`, async () => {
      const h = harness({ readNote: () => note });
      expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(1);
      expect(envelope(h.out).error!.code).toBe(code);
      expect(h.writes).toEqual([]);
    });
  }

  test("row 4 also covers an UNTERMINATED fence — locateFence is null either way", async () => {
    const h = harness({ readNote: () => "---\nnk-type: card\n---\n\n```nk-card\ntitle: A\n" });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(1);
    expect(envelope(h.out).error!.code).toBe("nk-no-fence");
    expect(h.writes).toEqual([]);
  });

  test("row 6: an invalid spec exits 1 with the RenderSpecError VERBATIM (code + field), no write", async () => {
    // An empty title makes the spec fail validation, which is `core`'s verdict, not the CLI's.
    const h = harness({ readNote: () => "---\nnk-type: card\n---\n\n```nk-card\ntitle: \n```\n" });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(1);
    const env = envelope(h.out);
    expect(typeof env.error!.code).toBe("string");
    expect(env.error).toHaveProperty("field"); // the `field` half is what "verbatim" means here
    expect(h.writes).toEqual([]);
  });
});

describe("AC #5 row 7 — the note changed under us (BOTH sites)", () => {
  test("7a: the note was DELETED between the plan and the write", async () => {
    const h = harness({ readNote: scriptedReads(MESSY, null) });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(1);
    expect(envelope(h.out).error!.code).toBe("nk-note-changed");
    expect(h.writes).toEqual([]); // nothing written — the whole point of the row
  });

  test("7b: the note's BYTES changed between the plan and the write", async () => {
    const h = harness({ readNote: scriptedReads(MESSY, `${MESSY}\nsomeone else was here\n`) });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(1);
    expect(envelope(h.out).error!.code).toBe("nk-note-changed");
    expect(h.writes).toEqual([]);
  });

  test("the race check is not vacuous — an UNCHANGED note still writes", async () => {
    // Without this, a row-7 check that fired on every run would look green above and break every apply.
    const h = harness({ readNote: scriptedReads(MESSY, MESSY, MESSY_APPLIED) });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(0);
    expect(h.writes).toHaveLength(1);
  });
});

describe("AC #5 row 8 — the write threw", () => {
  test("an injected writer that throws is nk-write-failed at exit 1", async () => {
    const h = harness({
      readNote: scriptedReads(MESSY, MESSY),
      writeNote: () => {
        throw new Error("ENOSPC: no space left on device");
      },
    });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(1);
    const env = envelope(h.out);
    expect(env.error!.code).toBe("nk-write-failed");
    expect(String(env.error!.message)).toContain("ENOSPC");
  });

  test("REAL fs: a 0555 PARENT DIRECTORY — the note is byte-identical and no temp is left", async () => {
    // ⚠ THE TWO OBVIOUS FIXTURES DO NOT WORK, and both were re-probed at dev time rather than reasoned
    // about (`uid=501`): a read-only FILE (`chmod 0444`) SUCCEEDS — `atomicWrite` writes a temp sibling
    // and renames over the target, and rename is governed by the DIRECTORY's mode; and "the parent
    // vanished" SUCCEEDS too, because `atomicWrite` calls `ensureDir`, which recreates it. Only `0555`
    // on the parent throws, and it throws at the TEMP-FILE CREATE (`EACCES`, errno -13) — before
    // anything touches the target, which is what makes the byte-identity assertion below assertable at
    // all: there is no torn write to reason about.
    if (process.getuid?.() === 0) return; // root defeats the permission bit; the injected case above still runs

    const dir = mkdtempSync(join(tmpdir(), "nk-w-perm-"));
    const note = join(dir, "n.md");
    writeFileSync(note, MESSY);
    const before = readFileSync(note, "utf-8");
    try {
      chmodSync(dir, 0o555);
      const h = harness({ readNote: () => readFileSync(note, "utf-8"), writeNote: undefined });
      // `writeNote: undefined` puts the REAL `atomicWrite` on the path — the default this suite must
      // exercise, or the sole-writer gate would be guarding a call site no test ever runs.
      delete h.deps.writeNote;
      expect(await runNotekitApply(["render", note, ...CONFIG, "--json"], h.deps)).toBe(1);
      expect(envelope(h.out).error!.code).toBe("nk-write-failed");
      chmodSync(dir, 0o755);
      expect(readFileSync(note, "utf-8")).toBe(before); // byte-identical
      expect(readdirSync(dir)).toEqual(["n.md"]); // fsx removed its temp
    } finally {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── the NON-`Error` THROW — CodeRabbit, PR #83 ─────────────────────────────────────────────────────
//
// `catch (e)` binds `unknown`, and JavaScript lets a `throw` carry ANY value. The shipped code read
// `(e as Error).message ?? String(e)`, which is not a fallback: the property read runs BEFORE `??` can
// apply, so a thrown `null`/`undefined` made the FORMATTING throw. Measured on `1ef02fb` before the fix:
//
//   writeNote throws null      → exit 1, but stderr read "std notekit: null is not an object
//                                (evaluating 'e.message')" — the `nk-write-failed` envelope was LOST,
//                                so a `--json` caller got NOTHING on stdout to branch on
//   the re-read throws undefined → the TypeError ESCAPED `runNotekitApply` entirely, so `main.ts`
//                                surfaced an unhandled rejection instead of the exit 1 that the outer
//                                catch's own comment promises
//
// ⚠ THE SECOND ROW IS THE REAL DEFECT, and it is NOT the one the review described. The review's model
// was that the inner catch's TypeError reaches the outer catch and escapes from there — measured, it
// does reach the outer catch, and the outer catch formats a TypeError just fine (a TypeError IS an
// Error), so exit 1 survives with a corrupted message. What actually escapes is a raw non-Error throw
// landing in the OUTER catch with no inner catch between. Both are fixed by `errorText`; only the
// second was a crash.
describe("a thrown non-Error is still an exit code, never a crash", () => {
  /** A reader that serves `MESSY`, then THROWS the given value on the nth call (1-based). */
  function throwOnRead(n: number, thrown: unknown): () => string {
    let calls = 0;
    return () => {
      calls += 1;
      if (calls === n) throw thrown;
      return MESSY;
    };
  }

  test("INNER catch: a writer that throws `null` still emits nk-write-failed at exit 1", async () => {
    const h = harness({
      readNote: scriptedReads(MESSY, MESSY),
      writeNote: () => {
        throw null;
      },
    });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(1);
    const env = envelope(h.out);
    expect(env.error!.code).toBe("nk-write-failed"); // the envelope survives — it did not before
    expect(String(env.error!.message)).toContain("null");
    // …and it is NOT the TypeError text the old expression produced.
    expect(String(env.error!.message)).not.toContain("e.message");
  });

  test("OUTER catch: a re-read that throws `undefined` RETURNS 1 — it used to escape the function", async () => {
    // The load-bearing assertion is that `runNotekitApply` RESOLVES at all. `expect(...).toBe(1)` alone
    // would report the old behaviour as a rejected promise rather than as a wrong exit code, so the
    // resolution is captured explicitly first.
    const h = harness({ readNote: throwOnRead(2, undefined), writeNote: () => {} });
    let settled: number | string;
    try {
      settled = await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], h.deps);
    } catch (e) {
      settled = `ESCAPED: ${e instanceof Error ? e.name : String(e)}`;
    }
    expect(settled).toBe(1);
    expect(h.writes).toEqual([]); // it threw at step 4, before any write
    expect(h.err.join("\n")).toContain("std notekit: undefined");
    expect(h.err.join("\n")).not.toContain("e.message");
  });

  // ⚠ A REGISTRY LOADER THAT THROWS `null` IS A USAGE `2`, AND THAT IS A BEHAVIOUR CHANGE THE FIX
  // CAUSED — recorded here rather than left for someone to trip over. `resolveRegistry` catches a
  // failing `--config` and returns `null`, which is the usage `2` its own docblock prescribes. Before
  // the fix that catch could not FORMAT a `null`: it raised a TypeError, which sailed past
  // `resolveRegistry`'s return, landed in `runNotekitApply`'s outer catch, and came out as a fail-loud
  // `1`. So the old code reported "the CLI crashed internally" for what is really "your --config is
  // broken". The exit code moving 1 → 2 is the defect being removed, not a regression.
  test("a registry loader that throws `null` is the usage 2, not a fail-loud 1", async () => {
    const h = harness({
      loadRegistry: async () => {
        throw null;
      },
    });
    let settled: number | string;
    try {
      settled = await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], h.deps);
    } catch (e) {
      settled = `ESCAPED: ${e instanceof Error ? e.name : String(e)}`;
    }
    expect(settled).toBe(2);
    expect(h.writes).toEqual([]);
    expect(h.err.join("\n")).toContain("cannot load the note-type registry — null");
    expect(h.out).toEqual([]); // usage puts nothing on stdout, `--json` or not
  });

  test("errorText itself: Error → message, everything else → String(e)", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText(new TypeError("wrong shape"))).toBe("wrong shape"); // subclasses narrow too
    expect(errorText(null)).toBe("null");
    expect(errorText(undefined)).toBe("undefined");
    expect(errorText("a bare string")).toBe("a bare string");
    expect(errorText(42)).toBe("42");
    // ⚠ THE CASE `??` COULD NEVER HAVE COVERED, even if the property read had been safe: a non-Error
    // object HAS no `message`, so `undefined ?? String(e)` fell through to "[object Object]" — the
    // fallback fired and said nothing. `errorText` reaches the same text by the same route, so this
    // pins the limit rather than claiming an improvement that is not there.
    expect(errorText({ code: "x" })).toBe("[object Object]");
  });

  test("COUNTERFACTUAL: the expression that was replaced really does throw on these values", () => {
    // The premise, executed rather than asserted in prose. If this ever stops throwing, the fix above
    // is guarding nothing and this test says so.
    const old = (e: unknown) => (e as Error).message ?? String(e);
    expect(() => old(null)).toThrow(TypeError);
    expect(() => old(undefined)).toThrow(TypeError);
    expect(old(new Error("fine"))).toBe("fine"); // …and it was correct for the Error case all along
  });
});

describe("AC #5 row 9 — the read-back does not match", () => {
  test("nk-write-unverified names the path, and does NOT claim the note survived", async () => {
    const h = harness({ readNote: scriptedReads(MESSY, MESSY, "something else entirely") });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(1);
    const env = envelope(h.out);
    expect(env.error!.code).toBe("nk-write-unverified");
    expect(String(env.error!.message)).toContain("n.md");
    expect(h.writes).toHaveLength(1); // the write DID happen — that is why the pre-state is gone
  });

  test("…and a read-back that MATCHES is the success row, so the check can go both ways", async () => {
    const h = harness({ readNote: scriptedReads(MESSY, MESSY, MESSY_APPLIED) });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(0);
    expect(envelope(h.out).value!.written).toBe(true);
  });
});

describe("AC #5 row 10 — success, at both of its sites", () => {
  test("bytes written: exit 0, written: true, and the spliced note is what landed", async () => {
    const h = harness({ readNote: scriptedReads(MESSY, MESSY, MESSY_APPLIED) });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(0);
    expect(envelope(h.out).value!.written).toBe(true);
    expect(h.writes).toEqual([["n.md", MESSY_APPLIED]]);
  });

  test("already identical: exit 0, written: false, and NO write is attempted at all", async () => {
    const h = harness({ readNote: () => CANONICAL });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(0);
    expect(envelope(h.out).value!.written).toBe(false);
    expect(h.writes).toEqual([]);
  });
});

// ── AC #6 — idempotence is a byte no-op, and it is not hashed ─────────────────────────────────────

describe("AC #6 — idempotence, on the real filesystem", () => {
  function realFixture(body: string): { dir: string; note: string; deps: NotekitApplyDeps; out: string[] } {
    const dir = mkdtempSync(join(tmpdir(), "nk-w-idem-"));
    const note = join(dir, "n.md");
    writeFileSync(note, body);
    const out: string[] = [];
    return {
      dir,
      note,
      out,
      // No `writeNote` — the REAL `atomicWrite` runs, which is the point of this block.
      deps: { log: (l) => out.push(l), err: () => {}, now: () => AT, loadRegistry: async () => REGISTRY },
    };
  }

  test("a second identical run writes NOTHING: same bytes, unchanged mtime, written: false", async () => {
    const f = realFixture(MESSY);
    try {
      expect(await runNotekitApply(["render", f.note, ...CONFIG, "--json"], f.deps)).toBe(0);
      const afterFirst = readFileSync(f.note, "utf-8");
      expect(afterFirst).toBe(MESSY_APPLIED);
      const mtime = statMtime(f.note);
      expect(mtime).toBeGreaterThan(0); // …so "unchanged" below is not "unstatable" twice over

      f.out.length = 0;
      await new Promise((r) => setTimeout(r, 12)); // long enough that a real write would move mtime
      expect(await runNotekitApply(["render", f.note, ...CONFIG, "--json"], f.deps)).toBe(0);
      expect(envelope(f.out).value!.written).toBe(false);
      expect(readFileSync(f.note, "utf-8")).toBe(afterFirst);
      // ⚠ A SUPPORTING signal only: `fsx.statMtime` is fail-soft (any stat error, ENOENT included,
      // returns 0), so an unchanged mtime cannot by itself distinguish "not written" from "not
      // statable". The byte compare and `written: false` carry the claim.
      expect(statMtime(f.note)).toBe(mtime);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("COUNTERFACTUAL: one trailing space inside the fence body and the second run MUST write", async () => {
    // The un-failable class this epic keeps catching: a skip-if-identical that skips after a real
    // change. ⚠ `core.contentHash` would be GREEN here — it collapses whitespace before hashing.
    const f = realFixture(MESSY);
    try {
      expect(await runNotekitApply(["render", f.note, ...CONFIG, "--json"], f.deps)).toBe(0);
      const canonical = readFileSync(f.note, "utf-8");

      writeFileSync(f.note, canonical.replace("title: Primer", "title: Primer "));
      expect(readFileSync(f.note, "utf-8")).not.toBe(canonical);

      f.out.length = 0;
      expect(await runNotekitApply(["render", f.note, ...CONFIG, "--json"], f.deps)).toBe(0);
      expect(envelope(f.out).value!.written).toBe(true); // it WROTE — the skip did not fire
      expect(readFileSync(f.note, "utf-8")).toBe(canonical); // …and restored the canonical body
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

// ── AC #1 — only the fence body moves, proven by oracles that do not route through the splice ─────

describe("AC #1 — the write touches only the fence region", () => {
  /** Oracle (b), on the file that actually landed. */
  function expectDelimiterFraming(markdown: string): void {
    const f = locateFence(markdown)!;
    expect(f).not.toBeNull();
    const prefix = markdown.slice(0, f.bodyStart);
    expect(/(\r\n|\r|\n)$/.test(prefix)).toBe(true);
    expect(/^[ \t]*`{3,}nk-[a-z]+[ \t]*$/.test(prefix.split(/\r\n|\r|\n/).at(-2)!)).toBe(true);
    expect(/^[ \t]*`{3,}[ \t]*(\r\n|\r|\n|$)/.test(markdown.slice(f.bodyEnd))).toBe(true);
  }

  test("a LENGTH-CHANGING apply: (b) framing, (c) round-trip, (d) golden bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nk-w-oracle-"));
    const note = join(dir, "n.md");
    writeFileSync(note, MESSY); // 7 body lines in, 3 out — the length changes
    try {
      const out: string[] = [];
      const deps: NotekitApplyDeps = { log: (l) => out.push(l), err: () => {}, now: () => AT, loadRegistry: async () => REGISTRY };
      expect(await runNotekitApply(["render", note, ...CONFIG, "--json"], deps)).toBe(0);
      const after = readFileSync(note, "utf-8");

      expect(after).toBe(MESSY_APPLIED); // (d) — hand-written bytes, byte for byte
      expectDelimiterFraming(after); // (b)
      // (c) — the body re-locates out of the WRITTEN file exactly as composed. ⚠ Asserted with the
      // composed (newline-terminated) body the CLI really writes, never raw codec output.
      expect(locateFence(after)!.body).toBe(composeBody(parseFenceBody(locateFence(MESSY)!.body)));
      expect(locateFence(after)!.type).toBe("card");

      // …and the prose outside the fence is the same CONTENT at a new index (NK-4 rule 2 — the
      // invariant is on the region, not on byte offsets).
      // `blockEnd` runs to just PAST the closing run's line terminator, so the remainder starts at the
      // blank line after the fence — measured, not assumed.
      const f = locateFence(after)!;
      expect(after.slice(f.blockEnd)).toBe("\ntrailing prose");
      expect(after.startsWith("---\nnk-type: card\n---\n\n# Heading\n\n")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a TWO-FENCE note: the first is spliced, the second is byte-identical afterwards", async () => {
    const two = ["---", "nk-type: card", "---", "", "```nk-card", "title:  Primer", "status: live", "```", "", "between", "", "```nk-card", "second: 2", "```", "", "tail"].join("\n");
    const h = harness({ readNote: scriptedReads(two, two, "unused") });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG], h.deps)).toBe(1); // row 9, read-back
    const written = h.writes[0]![1];
    expect(written).toContain("```nk-card\nsecond: 2\n```\n\ntail");
    expect(locateFence(written)!.body).toBe("title: Primer\nstatus: live\n");
  });

  test("a CRLF note: prose keeps CRLF byte-for-byte, the fence body is LF (declared, not discovered)", async () => {
    const crlf = ["---", "nk-type: card", "---", "", "```nk-card", "title:   Primer", "status: live", "```", "", "prose"].join("\r\n");
    const h = harness({ readNote: scriptedReads(crlf, crlf, "unused") });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG], h.deps)).toBe(1); // row 9
    expect(h.writes[0]![1]).toBe(
      "---\r\nnk-type: card\r\n---\r\n\r\n```nk-card\r\ntitle: Primer\nstatus: live\n```\r\n\r\nprose",
    );
  });
});

// ── AC #2 — the codec is the sole writer, and the newline contract is settled ──────────────────────

describe("AC #2 — composeBody, the one canonical form", () => {
  test("it round-trips through locateFence(spliceFence(…)) for a NON-EMPTY record", () => {
    const md = "```nk-card\nold: 1\n```\n";
    const body = composeBody({ a: "1", b: "2" });
    expect(body).toBe("a: 1\nb: 2\n");
    const f = locateFence(md)!;
    const after = md.slice(0, f.bodyStart) + body + md.slice(f.bodyEnd);
    expect(locateFence(after)!.body).toBe(body);
  });

  test("…and for an EMPTY record it stays \"\", never \"\\n\"", () => {
    // `"\n"` would splice a blank line into a fence that must collapse to bodyStart === bodyEnd.
    expect(composeBody({})).toBe("");
    const md = "```nk-card\nold: 1\n```\n";
    const f = locateFence(md)!;
    const after = md.slice(0, f.bodyStart) + composeBody({}) + md.slice(f.bodyEnd);
    expect(after).toBe("```nk-card\n```\n");
    const relocated = locateFence(after)!;
    expect(relocated.body).toBe("");
    expect(relocated.bodyStart).toBe(relocated.bodyEnd);
  });

  test("THE NEGATIVE CASE: the raw serializeFenceBody form would DESTROY the fence", () => {
    // This is what stops a later "simplification" from deleting composeBody: the raw form is not a
    // slightly-worse spelling, it is a fence-destroying one.
    const md = "```nk-card\nold: 1\n```\n";
    const f = locateFence(md)!;
    const raw = serializeFenceBody({ a: "1" });
    expect(raw).toBe("a: 1"); // no trailing newline — the whole problem, in one assertion
    const broken = md.slice(0, f.bodyStart) + raw + md.slice(f.bodyEnd);
    expect(broken).toBe("```nk-card\na: 1```\n");
    expect(locateFence(broken)).toBeNull(); // it is no longer a fence
    // …while the composed form survives the identical splice.
    expect(locateFence(md.slice(0, f.bodyStart) + composeBody({ a: "1" }) + md.slice(f.bodyEnd))!.body).toBe("a: 1\n");
  });
});

describe("AC #2 — the preview is MECHANIZED to be the same preview, in both output modes", () => {
  test("non-json: the preview region is byte-identical to a preview-only run's stdout", async () => {
    const preview = harness({ readNote: () => MESSY });
    expect(await runNotekitRead(["render", "n.md", ...CONFIG], preview.deps)).toBe(0);

    const applied = harness({ readNote: scriptedReads(MESSY, MESSY, MESSY_APPLIED) });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG], applied.deps)).toBe(0);

    expect(preview.out).toHaveLength(1);
    expect(applied.out).toHaveLength(2);
    expect(applied.out[0]).toBe(preview.out[0]!); // the preview region, to the byte
    expect(applied.out[1]).toBe("✓ wrote n.md"); // …then the result line, after it
    expect(applied.err).toEqual([]); // logs and errors never share stdout with it
  });

  test("json: value.diff is identical between the preview-only and the apply run", async () => {
    const preview = harness({ readNote: () => MESSY });
    await runNotekitRead(["render", "n.md", ...CONFIG, "--json"], preview.deps);
    const applied = harness({ readNote: scriptedReads(MESSY, MESSY, MESSY_APPLIED) });
    await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], applied.deps);

    const a = envelope(preview.out).value!;
    const b = envelope(applied.out).value!;
    expect(b.diff).toBe(a.diff as string);
    expect(b.html).toBe(a.html as string);
    expect(JSON.stringify(b.spec)).toBe(JSON.stringify(a.spec));
  });

  test("PROVENANCE: the --json diff is non-empty and describes the change that was then made", async () => {
    // NK-4 rule 3 cannot be satisfied by print ORDER under --json (the envelope is the only stdout, and
    // it is emitted once, at the end), so it is satisfied by provenance instead — and provenance is
    // what this asserts: the diff's proposed side IS what landed in the fence.
    const applied = harness({ readNote: scriptedReads(MESSY, MESSY, MESSY_APPLIED) });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], applied.deps)).toBe(0);
    const diff = String(envelope(applied.out).value!.diff);
    expect(diff.length).toBeGreaterThan(0);

    const proposed = diff
      .split("\n")
      .filter((l) => l.startsWith("+"))
      .map((l) => l.slice(1))
      .join("\n");
    const landed = locateFence(applied.writes[0]![1])!.body;
    expect(landed).toBe(`${proposed}\n`); // byte for byte, modulo the newline composeBody re-attaches
  });

  test("a CANONICAL note previews an EMPTY diff and still exits 0 with written: false", async () => {
    // Without this the "non-empty diff" assertion above could be true for the wrong reason.
    const h = harness({ readNote: () => CANONICAL });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(0);
    expect(envelope(h.out).value!.diff).toBe("");
  });
});

describe("AC #2 — E1-A3, the four input classes, on the bytes that reach the note", () => {
  test("(a) prototype-chain names are ordinary fields and survive the apply verbatim", async () => {
    const note = ["---", "nk-type: card", "---", "", "```nk-card", "title:  Primer", "constructor: x", "toString: y", "valueOf: z", "__proto__: [a, b]", "```", ""].join("\n");
    const h = harness({ readNote: scriptedReads(note, note, "unused") });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG], h.deps)).toBe(1); // row 9
    const body = locateFence(h.writes[0]![1])!.body;
    expect(body).toBe("title: Primer\nconstructor: x\ntoString: y\nvalueOf: z\n__proto__: [a, b]\n");
  });

  test("(b) a holed array writes neither `undefined` nor `null` into the note", () => {
    const holed = new Array(3) as string[];
    holed[1] = "middle";
    const line = composeBody({ tags: holed });
    expect(line).toBe("tags: [, middle, ]\n");
    const md = "```nk-card\nold: 1\n```\n";
    const f = locateFence(md)!;
    const after = md.slice(0, f.bodyStart) + line + md.slice(f.bodyEnd);
    expect(after).not.toContain("undefined");
    expect(after).not.toContain("null");
    expect(locateFence(after)!.body).toBe(line);
  });

  test("(c) empty strings: an empty body stays a fence; an empty VALUE re-parses to the same field", async () => {
    const md = "```nk-card\n```\n";
    const spliced = md.slice(0, locateFence(md)!.bodyStart) + composeBody({}) + md.slice(locateFence(md)!.bodyEnd);
    expect(locateFence(spliced)).not.toBeNull(); // re-located in the RESULT, not assumed

    expect(composeBody({ title: "" })).toBe("title: \n");
    expect(parseFenceBody(composeBody({ title: "" }))).toEqual({ title: "" } as FenceFields);
  });

  test("(d) a NON-OBJECT never reaches the codec — it fails loud instead of emitting text", () => {
    for (const bad of [null, 7, "str", []] as unknown[]) {
      expect(() => composeBody(bad as FenceFields)).toThrow(/must be a record/);
    }
    // …and a real record still works, so the guard is not just rejecting everything.
    expect(composeBody({ a: "1" })).toBe("a: 1\n");
  });
});

// ── AC #4 — the read path is provably not weakened ────────────────────────────────────────────────

describe("AC #4 — nothing writes without --apply", () => {
  test("BEHAVIOURAL: the read path driven through a deps whose writeNote THROWS still exits 0", async () => {
    // The source scan proves no write CALL SITE exists outside the sanctioned module; this proves no
    // write is ATTEMPTED on the read path. Different questions — neither subsumes the other.
    const h = harness({
      readNote: () => MESSY,
      writeNote: () => {
        throw new Error("the read path must never reach for a writer");
      },
    });
    expect(await runNotekitRead(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(0);
    expect(h.writes).toEqual([]);
  });

  test("REAL fs: `render` without --apply leaves a note byte-identical even under a 0555 parent", async () => {
    // The strongest form of the same claim: the directory is unwritable, so ANY write attempt would
    // throw — and the run still exits 0 because it never attempts one.
    if (process.getuid?.() === 0) return;
    const dir = mkdtempSync(join(tmpdir(), "nk-w-ro-"));
    const note = join(dir, "n.md");
    writeFileSync(note, MESSY);
    try {
      chmodSync(dir, 0o555);
      const out: string[] = [];
      const code = await runNotekitRead(["render", note, ...CONFIG, "--json"], {
        log: (l) => out.push(l),
        err: () => {},
        now: () => AT,
        loadRegistry: async () => REGISTRY,
      });
      expect(code).toBe(0);
      chmodSync(dir, 0o755);
      expect(readFileSync(note, "utf-8")).toBe(MESSY);
      expect(readdirSync(dir)).toEqual(["n.md"]);
    } finally {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the module dependency runs ONE WAY — the read surface knows nothing of the writer", () => {
    // ⚠ MASKED, NOT A RAW `includes`: this asserts an absent CODE EDGE, and the read surface's header
    // legitimately NAMES `notekit-write.ts` in prose to explain the direction. A raw scan reads that
    // sentence as a dependency and goes red on a correct file — found by this test doing exactly that
    // on its first run.
    //
    // ⚠ AND `stripStringsAndComments`, NOT `stripComments` — measured, not preferred. `stripComments`
    // is a two-regex pass whose block-comment half is `/\*[\s\S]*?\*\//`, which does not know it is
    // inside a line comment: both notekit headers carry the literal `../notekit/edge/**` in a `//`
    // line, that `/**` opens a phantom block comment, and it runs to the next `*/` — swallowing the
    // whole import block, which is the one region this test needs to READ. The single-pass masker
    // tokenizes properly and keeps genuine module specifiers, which is exactly the shape wanted here.
    const read = stripStringsAndComments(readFileSync(join(import.meta.dir, "notekit-read.ts"), "utf-8"));
    expect(read).not.toContain("notekit-write");
    expect(read).not.toContain("runNotekitApply");

    // …and the direction it DOES run is a real edge, so the assertion above is not about nothing.
    const write = stripStringsAndComments(readFileSync(join(import.meta.dir, "notekit-write.ts"), "utf-8"));
    expect(write).toContain('from "./notekit-read"');

    // The counterfactual for the masker choice itself, both directions.
    expect(stripStringsAndComments(`import { x } from "./notekit-write";\n`)).toContain("notekit-write");
    expect(stripStringsAndComments(`// notekit-write.ts is mentioned, not imported\n`)).not.toContain(
      "notekit-write",
    );
  });
});

// ═══ Story 2.5 — Task 2: deriveFenceFields, the ONE frontmatter→fence derivation ══════════════════

describe("deriveFenceFields — the rubric projection (AC #1)", () => {
  const RUBRIC = {
    kind: "card" as const,
    titleField: "title",
    fields: [{ key: "role" }, { key: "org", label: "ORG" }],
  };

  /** Build a note from frontmatter lines. Prose is irrelevant to the derivation and stays constant. */
  function note(...fm: string[]): string {
    return ["---", ...fm, "---", "", "Prose."].join("\n");
  }

  test("the output key set is EXACTLY the rubric's keys ∩ the frontmatter's own keys", () => {
    const { fields } = deriveFenceFields(parseFrontmatter(note("title: T", "role: r", "org: o", "stray: s")), RUBRIC);
    expect(Object.keys(fields)).toEqual(["title", "role", "org"]);
    expect(fields).toEqual({ title: "T", role: "r", org: "o" });
    // `stray` is in the frontmatter and NOT in the rubric — the projection drops it.
    expect(Object.prototype.hasOwnProperty.call(fields, "stray")).toBe(false);
  });

  test("a rubric key absent from the frontmatter yields NO key at all — not an empty one", () => {
    const { fields } = deriveFenceFields(parseFrontmatter(note("title: T")), RUBRIC);
    expect(Object.keys(fields)).toEqual(["title"]);
    // The distinction matters downstream: `noteToRenderSpec` omits an absent key (no row) and writes
    // an EMPTY row for a present-but-empty one. Conflating them changes what the card renders.
    expect(Object.prototype.hasOwnProperty.call(fields, "role")).toBe(false);
  });

  test("⚠ `nk-type` NEVER reaches the fence body, even when the rubric names it", () => {
    // It is the OPT-IN SIGNAL, and NK-1.8 rule 2 pins routing to the fence INFO STRING. A naïve
    // `serializeFenceBody(parseFrontmatter(text))` writes `nk-type: card` into the body, duplicating
    // the signal into a region the dispatcher never reads and polluting the rubric field set.
    const withOptIn = note("title: T", "nk-type: card", "role: r");
    expect(Object.keys(deriveFenceFields(parseFrontmatter(withOptIn), RUBRIC).fields)).toEqual(["title", "role"]);

    const pathological = { kind: "card" as const, titleField: "nk-type", fields: [{ key: "nk-type" }] };
    expect(deriveFenceFields(parseFrontmatter(withOptIn), pathological).fields).toEqual({});
    expect(serializeFenceBody(deriveFenceFields(parseFrontmatter(withOptIn), pathological).fields)).toBe("");
  });

  test("an empty rubric key is SKIPPED — ⚠️-3 row 5, and FR-16 parity is why", () => {
    // `parseFrontmatter` KEEPS a trim-empty key (` : orphan` → `""`); `parseFenceBody` SKIPS it. So an
    // empty key derived through would serialize to `: orphan`, which the parser then drops —
    // `serialize(parse(body)) !== body` on a fence this story just created, failing Story 3.1's gate.
    const orphan = note("title: T", " : orphan");
    const empties = { kind: "card" as const, titleField: "", fields: [{ key: "" }, { key: "title" }] };
    expect(Object.keys(deriveFenceFields(parseFrontmatter(orphan), empties).fields)).toEqual(["title"]);
  });

  test("COUNTERFACTUAL — WITHOUT the empty-key skip, FR-16 parity is FALSE on the created body", () => {
    // The skip is not decorative. This is what the body would be if the empty key rode through.
    const unskipped: FenceFields = { "": "orphan", title: "T" };
    const body = `${serializeFenceBody(unskipped)}\n`;
    expect(body).toBe(": orphan\ntitle: T\n");
    expect(`${serializeFenceBody(parseFenceBody(body))}\n`).not.toBe(body); // parity FALSE
    // …and with the skip, parity holds.
    const { fields: skipped } = deriveFenceFields(parseFrontmatter(note("title: T", " : orphan")), {
      kind: "card" as const, titleField: "", fields: [{ key: "" }, { key: "title" }],
    });
    const good = `${serializeFenceBody(skipped)}\n`;
    expect(`${serializeFenceBody(parseFenceBody(good))}\n`).toBe(good);
  });

  describe("🔴 THE TWO CODECS DISAGREE ON QUOTES — the silent-corruption risk, both cases shipped", () => {
    test("a colon-bearing quoted scalar SURVIVES the round trip", () => {
      // `parseFrontmatter` strips the quotes; `parseFenceBody` re-reads the literal, and only the
      // FIRST colon splits (rule 7) — so the value comes back whole.
      const { fields } = deriveFenceFields(parseFrontmatter(note('title: "Some: Thing"')), RUBRIC);
      expect(fields).toEqual({ title: "Some: Thing" });
      const body = `${serializeFenceBody(fields)}\n`;
      expect(body).toBe("title: Some: Thing\n");
      expect(parseFenceBody(body)).toEqual({ title: "Some: Thing" });
    });

    test("⚠ A DECLARED LIMIT — a quoted bracket-string becomes a LIST, a type change the trip cannot see", () => {
      // `parseFrontmatter` unquotes `'[a, b]'` to the literal string `[a, b]`; `parseFenceBody` then
      // reads that back as a two-element list. It is NOT "fixed" by re-quoting on the way out — that
      // would make the fence body non-canonical and break FR-16 parity, which Story 3.1 enforces.
      const { fields } = deriveFenceFields(parseFrontmatter(note("title: '[a, b]'")), RUBRIC);
      expect(fields).toEqual({ title: "[a, b]" }); // still a STRING here
      const body = `${serializeFenceBody(fields)}\n`;
      expect(body).toBe("title: [a, b]\n");
      expect(parseFenceBody(body)).toEqual({ title: ["a", "b"] }); // …a LIST on the way back
    });
  });

  test("array-index keys VANISH one layer down, by design (rule 8) — inherited, not a bug here", () => {
    const indexed = { kind: "card" as const, titleField: "title", fields: [{ key: "1" }] };
    const { fields } = deriveFenceFields(parseFrontmatter(note("title: T", "1: one")), indexed);
    expect(Object.prototype.hasOwnProperty.call(fields, "1")).toBe(true); // derive KEEPS it…
    expect(serializeFenceBody(fields)).toBe("title: T"); // …and the codec drops it
  });

  describe("E1-A3 — the four input classes", () => {
    test("(a) prototype-chain names — `__proto__` VANISHES at parse, ordinary names survive as data", () => {
      // ⚠ `parseFrontmatter` builds a PLAIN `{}`, not `parseFenceBody`'s `Object.create(null)`. So a
      // `__proto__:` line hits the prototype SETTER and the key never lands — a line the author wrote,
      // silently eaten. This is why every read below is `hasOwnProperty`, never truthiness or `in`.
      expect(Object.keys(parseFrontmatter("---\n__proto__: x\n---\n"))).toEqual([]);

      const proto = { kind: "card" as const, titleField: "title", fields: [{ key: "__proto__" }] };
      const { fields: derived } = deriveFenceFields(parseFrontmatter(note("title: T", "__proto__: x")), proto);
      expect(Object.prototype.hasOwnProperty.call(derived, "__proto__")).toBe(false);

      const inherited = { kind: "card" as const, titleField: "title", fields: [{ key: "toString" }, { key: "constructor" }, { key: "valueOf" }] };
      // `toString` is NOT in the frontmatter — a truthiness check would find the inherited FUNCTION.
      const { fields: noneWritten } = deriveFenceFields(parseFrontmatter(note("title: T")), inherited);
      expect(Object.keys(noneWritten)).toEqual(["title"]);
      // …and when they ARE written, they survive as ordinary own fields.
      const { fields: written } = deriveFenceFields(parseFrontmatter(note("title: T", "constructor: c", "valueOf: v")), inherited);
      expect(Object.keys(written)).toEqual(["title", "constructor", "valueOf"]);
      // Read through an index rather than `written.constructor` — the property NAME collides with
      // `Object`'s, and tsc resolves the dotted form to `Function` even on a null-prototype record.
      expect(written["constructor"]).toBe("c");
      expect(written["valueOf"]).toBe("v");
    });

    test("(a) the OUTPUT is null-prototype too, mirroring parseFenceBody", () => {
      const { fields } = deriveFenceFields(parseFrontmatter(note("title: T")), RUBRIC);
      expect(Object.getPrototypeOf(fields)).toBeNull();
    });

    test("(b) sparse/holed arrays — the derived list is DENSE, no undefined/null reaches the note", () => {
      const tagged = { kind: "card" as const, titleField: "title", fields: [{ key: "tags" }] };
      const { fields } = deriveFenceFields(parseFrontmatter(note("title: T", "tags: [a, , b]")), tagged);
      expect(fields.tags).toEqual(["a", "b"]); // `parseFrontmatter` filters empties
      const body = serializeFenceBody(fields);
      expect(body).toContain("tags: [a, b]");
      expect(body).not.toContain("undefined");
      expect(body).not.toContain("null");
      // …and `joinOwn`'s own-index behaviour on a HAND-BUILT holed array (which no note can produce).
      const holed: string[] = ["a"]; holed[2] = "c";
      expect(serializeFenceBody({ tags: holed })).toBe("tags: [a, , c]");
    });

    test("(c) an empty value derives to an empty field — reported as a gap, never a silent blank", () => {
      const { fields } = deriveFenceFields(parseFrontmatter(note("title: T", "role:", "org: o")), RUBRIC);
      expect(fields).toEqual({ title: "T", role: "", org: "o" });
      // PRESENT-BUT-EMPTY is a gap on the same footing as absent — the human still has to fill it in,
      // and `validate` will not tell them (a non-title empty is `ok:true`, value `""`).
      expect(deriveFenceFields(parseFrontmatter(note("title: T", "role:", "org: o")), RUBRIC).gaps).toEqual(["role"]);
    });

    test("(d) non-objects — TOTAL on markdown, LOUD on a bad rubric", () => {
      // Total on its `markdown: string` input: no `---` block ⇒ `parseFrontmatter` returns `{}`.
      expect(deriveFenceFields(parseFrontmatter("just prose, no frontmatter\n"), RUBRIC).fields).toEqual({});
      expect(deriveFenceFields(parseFrontmatter(""), RUBRIC).fields).toEqual({});
      expect(deriveFenceFields(parseFrontmatter("---\n---\n"), RUBRIC).fields).toEqual({});

      // ⚠ THE RUBRIC GUARD IS A RUNTIME GUARD, NOT A COMPILER ONE. The rubric arrives from
      // `resolveTemplate` over a `--config` module the CLI `await import`s, so tsc's `Rubric` type is
      // a claim about a value it never saw.
      for (const bad of [null, 7, "str", [], undefined, { titleField: "t" }]) {
        expect(() => deriveFenceFields(parseFrontmatter(note("title: T")), bad as never)).toThrow(
          /rubric must be an object with a fields array/,
        );
      }
    });
  });

  test("IDENTITY-FREE (D4/NFR3) — the derivation names no vault, no path and no note type", () => {
    // 🔴 THIS GATE WAS VACUOUS WHEN FIRST SHIPPED, AND THE WAY IT FAILED IS THE LESSON. It opened
    // `notekit-write.ts` and sliced from `indexOf("export function deriveFenceFields")`. Story 2.5
    // MOVED that function to `notekit-read.ts`, so `indexOf` returned **-1**, `slice(-1)` yielded the
    // file's last character — `"\n"` — and every banned-string check passed forever, on one newline.
    // The suite reported green while guarding nothing. Found by cross-vendor review (grok, 2026-08-06,
    // F1); it is the exact class the Epic-1 retrospective already recorded once.
    //
    // Two fixes, because pointing it at the right file is only half of it:
    //   1. the slice is BOUNDED at the next top-level export, so it cannot silently swallow the module;
    //   2. `start` is ASSERTED non-negative, so a future move reddens this test instead of neutering it.
    const src = readFileSync(new URL("./notekit-read.ts", import.meta.url), "utf-8");
    const start = src.indexOf("export function deriveFenceFields");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\nexport ", start + 1);
    expect(end).toBeGreaterThan(start);
    const derivation = src.slice(start, end);
    expect(derivation.length).toBeGreaterThan(200); // a slice too small to contain the function is not a scan

    const BANNED = ["note-report", "zDrafts", "primer", "protocol", "pattern", "/Users/"];
    for (const banned of BANNED) expect(derivation).not.toContain(banned);

    // COUNTERFACTUAL — the scan bites on planted identity, which the -1 version could never have done.
    for (const banned of BANNED) {
      expect(`${derivation}\nconst home = "${banned}";`).toContain(banned);
    }
  });
});

describe("the gap advisory — ONE notion of `the rubric's keys`, not two (AC #6 row iii)", () => {
  const RUBRIC = { kind: "card" as const, titleField: "title", fields: [{ key: "role" }, { key: "org" }] };
  const note = (...fm: string[]) => ["---", ...fm, "---", "", "Prose."].join("\n");

  test("a missing key and an EMPTY key are both gaps", () => {
    expect(deriveFenceFields(parseFrontmatter(note("title: T", "role: r", "org: o")), RUBRIC).gaps).toEqual([]);
    expect(deriveFenceFields(parseFrontmatter(note("title: T", "role: r")), RUBRIC).gaps).toEqual(["org"]);
    expect(deriveFenceFields(parseFrontmatter(note("title: T", "role:", "org: o")), RUBRIC).gaps).toEqual(["role"]);
    expect(deriveFenceFields(parseFrontmatter(note("prose: p")), RUBRIC).gaps).toEqual(["title", "role", "org"]);
  });

  test("the gap set and the derived key set are COMPLEMENTS over the rubric's keys", () => {
    // This is the anti-drift property: two notions of "the rubric's keys" would let them disagree.
    for (const fm of [["title: T"], ["title: T", "role: r"], ["role: r", "org: o"], ["title:", "org: o"]]) {
      const md = note(...fm);
      const { fields, gaps } = deriveFenceFields(parseFrontmatter(md), RUBRIC);
      const derived = Object.keys(fields);
      const wanted = ["title", "role", "org"];
      // A key is either derived-and-non-empty, or a gap. An empty value is BOTH derived and a gap,
      // which is exactly the (c) case — so gaps ⊇ (wanted \ derived), and their union covers `wanted`.
      expect([...new Set([...derived, ...gaps])].sort()).toEqual(wanted.slice().sort());
      expect(gaps.every((g) => wanted.includes(g))).toBe(true);
    }
  });

  test("`nk-type` and an empty key are excluded from the gap set too — same skips, one owner", () => {
    const weird = { kind: "card" as const, titleField: "", fields: [{ key: "nk-type" }, { key: "role" }] };
    expect(deriveFenceFields(parseFrontmatter(note("nk-type: card")), weird).gaps).toEqual(["role"]);
  });

  test("`__proto__` is a GAP, not a silent success (AC #6)", () => {
    // `fm["__proto__"]` is TRUTHY (the inherited prototype object) on a record that never carried the
    // key, so only the `hasOwnProperty` read of AC #1(a) makes this detectable at all.
    const proto = { kind: "card" as const, titleField: "title", fields: [{ key: "__proto__" }] };
    expect(deriveFenceFields(parseFrontmatter(note("title: T", "__proto__: x")), proto).gaps).toEqual(["__proto__"]);
    const asTitle = { kind: "card" as const, titleField: "__proto__", fields: [] };
    expect(deriveFenceFields(parseFrontmatter(note("__proto__: x")), asTitle).gaps).toEqual(["__proto__"]);
  });

  test("a bad rubric fails LOUD here too — one guard, not two postures", () => {
    for (const bad of [null, 7, "str", []]) {
      expect(() => deriveFenceFields(parseFrontmatter(note("title: T")), bad as never)).toThrow(/rubric must be an object/);
    }
  });
});

// ═══ Story 2.5 — author mode: the one allowed structural add, end to end ══════════════════════════

/**
 * Author-mode fixtures. The rubric is 2.2's REGISTRY above — `title` (the titleField), `summary`,
 * `status` — so these notes are read against the same registry every other test in this file uses.
 */
const SEEDABLE = "---\nnk-type: card\ntitle: Primer\nsummary: A thing\nstatus: live\n---\n\nProse the human wrote.\n";

/**
 * Deps for a PREVIEW run — the read surface, which is where the no-`--apply` path lives and which
 * holds no writer at all. Kept separate from `harness` so a preview test cannot accidentally be handed
 * a `writeNote` and prove nothing.
 */
function preview(note: string, out: string[]): NotekitApplyDeps {
  return {
    log: (l) => out.push(l),
    err: () => {},
    now: () => AT,
    loadRegistry: async () => REGISTRY,
    readNote: () => note,
  };
}

/** The bytes `SEEDABLE` must become. Hand-written (oracle (d)): a human wrote these, not the offsets. */
const SEEDED = [
  "---",
  "nk-type: card",
  "title: Primer",
  "summary: A thing",
  "status: live",
  "---",
  "",
  "```nk-card",
  "title: Primer",
  "summary: A thing",
  "status: live",
  "```",
  "",
  "",
  "Prose the human wrote.",
  "",
].join("\n");

describe("AC #2 — row 4 FORKS: create under author mode, refuse otherwise", () => {
  test("the CREATE arm — an opted-in, fence-less, seedable note gets exactly one fence", async () => {
    const h = harness({ readNote: scriptedReads(SEEDABLE, SEEDABLE, SEEDED) });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--at", AT], h.deps)).toBe(0);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]![1]).toBe(SEEDED);
  });

  test("…and the written note reads back through the LOCATOR, which is the oracle", async () => {
    const h = harness({ readNote: scriptedReads(SEEDABLE, SEEDABLE, SEEDED) });
    await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--at", AT], h.deps);
    const written = h.writes[0]![1];
    const f = locateFence(written)!;
    expect(f).not.toBeNull();
    expect(f.type).toBe("card");
    expect(parseFenceBody(f.body)).toEqual({ title: "Primer", summary: "A thing", status: "live" });
    // Exactly ONE nk-fence in the note — a second opening line is the corruption this row guards.
    expect(written.match(/^```nk-[a-z]+$/gm)!.length).toBe(1);
    // FR-16 parity holds on the fence author mode just created.
    expect(`${serializeFenceBody(parseFenceBody(f.body))}\n`).toBe(f.body);
  });

  test("⚠ `nk-type` is NOT written into the body, though it IS in the frontmatter", async () => {
    const h = harness({ readNote: scriptedReads(SEEDABLE, SEEDABLE, SEEDED) });
    await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--at", AT], h.deps);
    const f = locateFence(h.writes[0]![1])!;
    expect(f.body).not.toContain("nk-type");
    expect(Object.keys(parseFenceBody(f.body))).not.toContain("nk-type");
  });

  test("the REFUSE arm — an UNTERMINATED fence is never created over, and the note is untouched", async () => {
    // `locateFence` returns `null` for "no fence" AND for "an unterminated fence" and cannot tell the
    // caller which. Creating here would leave TWO opening runs and no matching close — corruption from
    // the one operation this epic allows to add structure.
    const torn = "---\nnk-type: card\ntitle: Primer\n---\n\n```nk-card\ntitle: Primer\n";
    const h = harness({ readNote: () => torn });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--json"], h.deps)).toBe(1);
    expect(envelope(h.out).error!.code).toBe("nk-no-fence");
    expect(h.writes).toEqual([]);
  });

  test("the REFUSE arm — a note whose frontmatter answers NOTHING the rubric asks for", async () => {
    // ⚠ THIS IS THE CONDITION THAT LETS ROW 4 FORK AT ALL, and it is why 2.1's and 2.2's own row-4
    // fixtures stay green UNEDITED: their note is exactly this shape. Author mode carries frontmatter
    // INTO a fence, and here there is none to carry — so `nk-no-fence` is the honest verdict, not an
    // invented empty fence.
    const h = harness({ readNote: () => "---\nnk-type: card\n---\n\njust prose\n" });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--json"], h.deps)).toBe(1);
    expect(envelope(h.out).error!.code).toBe("nk-no-fence");
    expect(h.writes).toEqual([]);
  });

  test("the fence lands immediately after the frontmatter, before all prose", async () => {
    const h = harness({ readNote: scriptedReads(SEEDABLE, SEEDABLE, SEEDED) });
    await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--at", AT], h.deps);
    const written = h.writes[0]![1];
    const f = locateFence(written)!;
    // Everything before the block is the frontmatter and nothing else; the prose is all after it.
    expect(written.slice(0, f.blockStart)).toBe("---\nnk-type: card\ntitle: Primer\nsummary: A thing\nstatus: live\n---\n\n");
    expect(written.slice(f.blockEnd)).toContain("Prose the human wrote.");
  });

  test("2.2's TRANSFORM path is untouched — a note WITH a fence still splices, never creates", async () => {
    const h = harness();  // the default `readNote` is MESSY, which has a fence
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--at", AT], h.deps)).toBe(1);
    // (row 7 — the scripted single-answer reader makes the re-read see the same bytes; the point here
    // is only that the transform arm was taken, so no `gaps` key appears.)
    const h2 = harness({ readNote: scriptedReads(MESSY, MESSY, MESSY_APPLIED) });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--at", AT, "--json"], h2.deps)).toBe(0);
    expect(h2.writes[0]![1]).toBe(MESSY_APPLIED);
    expect(envelope(h2.out).value).not.toHaveProperty("gaps");
  });
});

describe("AC #3 — validation PRECEDES the write, and the absence of a fence is the proof", () => {
  /**
   * 🔴 THE FIXTURE IS A TITLE GAP, AND IT HAS TO BE. AC #6's table has the measurements: a missing or
   * empty NON-title rubric key leaves `validate` at `ok:true`, so a fixture built on one writes the
   * fence and exits 0 — the "no fence was created" assertion would be red for the right reason on the
   * wrong grounds, or green forever once relaxed. `title` is the ONLY note-derivable input that
   * reaches row 6. The name says so, so it is not silently edited away later.
   */
  const TITLE_GAP = "---\nnk-type: card\nsummary: A thing\nstatus: live\n---\n\nProse.\n";

  test("author-mode-title-gap-refuses-before-write — absent title", async () => {
    const h = harness({ readNote: () => TITLE_GAP });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--json", "--at", AT], h.deps)).toBe(1);
    const env = envelope(h.out);
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("nk-missing-field");
    expect(env.error!.field).toBe("title");
    // ⚠ `Result` is a DISCRIMINATED UNION — an `ok:false` envelope has NO `value` key at all, because
    // nothing was planned. Do not assert `value.written === false` here; that is `undefined.written`
    // and throws in the test rather than in the code.
    expect(env).not.toHaveProperty("value");
    // THE ORDERING PROOF, and the only assertion here that can fail: no fence was created.
    expect(h.writes).toEqual([]);
  });

  test("author-mode-title-gap-refuses-before-write — present but EMPTY title", async () => {
    const h = harness({ readNote: () => "---\nnk-type: card\ntitle:\nstatus: live\n---\n\nProse.\n" });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--json", "--at", AT], h.deps)).toBe(1);
    expect(envelope(h.out).error!.field).toBe("title");
    expect(h.writes).toEqual([]);
  });

  test("…and the same refusal in the HUMAN output mode, note still untouched", async () => {
    const h = harness({ readNote: () => TITLE_GAP });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--at", AT], h.deps)).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.err.join("\n")).toContain("title");
    expect(h.out).toEqual([]); // no preview was printed either — nothing was composed
  });

  test("COUNTERFACTUAL (E1-A6) — a validate that ran AFTER the compose would let a fence through", () => {
    // Demonstrated on the pieces rather than by mutating the shipped order, because the shipped order
    // is what the fixtures above assert. This is what the write WOULD have carried: `createFence`
    // composes happily from a title-less record, so nothing but the ORDER stops it landing.
    const { fields } = deriveFenceFields(parseFrontmatter(TITLE_GAP), REGISTRY.templates["catalog-card"]!.rubric);
    expect(Object.keys(fields)).toEqual(["summary", "status"]); // no title — the gap
    const wouldHaveBeen = createFence(TITLE_GAP, "card", composeBody(fields), 0);
    expect(locateFence(wouldHaveBeen)).not.toBeNull(); // a fence WAS composable
    // …and `validate` is what refuses it, which is why it runs first.
    const spec = noteToRenderSpec(fields, REGISTRY.templates["catalog-card"]!.rubric, { id: "x", generatedAt: AT });
    expect(validate(spec).ok).toBe(false);
  });
});

describe("AC #4 — `--apply` is opt-in; the default path leaves the vault byte-untouched", () => {
  // ⚠ THE NO-`--apply` PATH IS `runNotekitRead`, NOT `runNotekitApply`. `main.ts` holds the single
  // `--apply` read and routes on it (2.2 AC #4), so `runNotekitApply` is BY DEFINITION the apply path
  // and driving it flagless would test a call `main.ts` never makes. Getting this wrong is how a
  // "writes nothing without --apply" assertion ends up proving the opposite of what it claims.
  test("no `--apply` writes NOTHING, in both output modes, over every author fixture", async () => {
    for (const note of [SEEDABLE, "---\nnk-type: card\ntitle: T\n---\n\nProse.\n"]) {
      for (const extra of [[], ["--json"]]) {
        const out: string[] = [];
        const code = await runNotekitRead(["render", "n.md", ...CONFIG, "--at", AT, ...extra], {
          log: (l) => out.push(l),
          err: () => {},
          loadRegistry: async () => REGISTRY,
          readNote: () => note,
        });
        expect(code).toBe(0);
        // The read surface holds NO writer at all — 2.1's AC #4 gate scans its source for sixteen fs
        // tokens and finds none, which is the structural half of this claim.
        expect(out).toHaveLength(1);
      }
    }
  });

  test("THE BEHAVIOURAL HALF — the preview path never even ATTEMPTS a write", async () => {
    // The byte compare proves nothing landed; a throwing double proves nothing was ATTEMPTED. On the
    // read surface there is no `writeNote` dep to throw from — the absence IS the proof — so the
    // throwing double is aimed at the one entry point that has one, asserting it is not reached
    // before `--apply` was passed.
    const h = harness({
      readNote: () => SEEDABLE,
      writeNote: () => {
        throw new Error("this writer must never be called");
      },
    });
    // With `--apply`, the writer IS reached (and its throw becomes `nk-write-failed`, 2.2's row 8) —
    // which is what makes the flagless case above a real distinction rather than a vacuous one.
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--at", AT, "--json"], h.deps)).toBe(1);
    expect(envelope(h.out).error!.code).toBe("nk-write-failed");
  });

  test("the READ surface previews author mode too, and holds no writer at all", async () => {
    const out: string[] = [];
    const code = await runNotekitRead(["render", "n.md", ...CONFIG, "--at", AT, "--json"], {
      log: (l) => out.push(l),
      err: () => {},
      loadRegistry: async () => REGISTRY,
      readNote: () => SEEDABLE,
    });
    expect(code).toBe(0);
    const env = JSON.parse(out[0]!) as { ok: boolean; value: Record<string, unknown> };
    expect(env.ok).toBe(true);
    expect(env.value).not.toHaveProperty("written"); // preview only — nothing was written to report
  });

  test("2.2's single-`--apply`-read gate stays at EXACTLY ONE, in main.ts", () => {
    // ⚠ THE GLOB FORM, not a shell-expanded path list: `-g '!*.test.ts'` does NOT filter a file
    // ripgrep was handed explicitly, so the path-list form drags this very test file into scope and
    // counts its own `--apply` fixtures as extra reads. A measurement correction, not a contract
    // change — the assertion (exactly one read, in `main.ts`) is 2.2's, unchanged.
    const proc = Bun.spawnSync({
      cmd: ["rg", "-n", 'hasFlag\\([^)]*"apply"', "src/",
            "-g", "src/cli/main.ts", "-g", "src/cli/notekit-*.ts", "-g", "src/notekit/**/*.ts",
            "-g", "!*.test.ts"],
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const hits = proc.stdout.toString().trim().split("\n").filter((l) => l.length > 0);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("src/cli/main.ts");
  });
});

describe("AC #5 — prose and fence are separable by a MECHANICAL property", () => {
  test("THE SUBTRACTION — deleting [blockStart, blockEnd) leaves the pre-note plus two \\n", async () => {
    // ⚠ CONTENT, not offsets. Creation inserts a whole block, so EVERY offset after the insertion
    // point shifts — an "differs only between bodyStart and bodyEnd" assertion is FALSE BY
    // CONSTRUCTION here. NK-4 rule 2 says the invariant lives on the fence AST, not on byte offsets.
    const h = harness({ readNote: scriptedReads(SEEDABLE, SEEDABLE, SEEDED) });
    await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--at", AT], h.deps);
    const written = h.writes[0]![1];
    const f = locateFence(written)!;
    const at = SEEDABLE.indexOf("\n\nProse") + 1; // just past the frontmatter block's closing `---\n`
    expect(written.slice(0, f.blockStart) + written.slice(f.blockEnd)).toBe(
      SEEDABLE.slice(0, at) + "\n" + "\n" + SEEDABLE.slice(at),
    );
  });

  test("what a GREP sees: one whole-line opening delimiter, no prose sharing its line", async () => {
    const h = harness({ readNote: scriptedReads(SEEDABLE, SEEDABLE, SEEDED) });
    await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--at", AT], h.deps);
    const written = h.writes[0]![1];
    expect(written.match(/^```nk-[a-z]+$/gm)).toHaveLength(1);
    expect(locateFence(written)!.type).toMatch(/^[a-z]+$/);
    // …and there is no SECOND fence after the first.
    expect(locateFence(written.slice(locateFence(written)!.blockEnd))).toBeNull();
  });

  test("the prose is BYTE-IDENTICAL — author mode adds a fence and touches nothing else", async () => {
    const h = harness({ readNote: scriptedReads(SEEDABLE, SEEDABLE, SEEDED) });
    await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--at", AT], h.deps);
    const f = locateFence(h.writes[0]![1])!;
    // Under this story's admitted scope the prose already exists and is human-authored, so Epic 2's
    // "never risking prose" holds UNCHANGED and byte-provable — the same claim 2.2 makes.
    expect(h.writes[0]![1].slice(f.blockEnd).trimStart()).toBe("Prose the human wrote.\n");
  });
});

describe("AC #6 — the required-field gap, on EVERY gap path", () => {
  const rubric = REGISTRY.templates["catalog-card"]!.rubric;

  test("(i) an UNREGISTERED nk-type is a refusal, not an invented rubric", async () => {
    // NFR5 generates the capabilities catalog from THIS registry, so a type absent from it is one
    // notewright was never told about. The answer is `nk-unknown-type` and stop.
    const h = harness({ readNote: () => "---\nnk-type: ledger\ntitle: T\n---\n\nProse.\n" });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--json"], h.deps)).toBe(1);
    expect(envelope(h.out).error!.code).toBe("nk-unknown-type");
    expect(h.writes).toEqual([]);
  });

  test("(ii) the TITLE gap refuses with code AND field, and the note is byte-identical", async () => {
    for (const note of [
      "---\nnk-type: card\nsummary: s\n---\n\nProse.\n",
      "---\nnk-type: card\ntitle:\nsummary: s\n---\n\nProse.\n",
    ]) {
      const h = harness({ readNote: () => note });
      expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--json", "--at", AT], h.deps)).toBe(1);
      const env = envelope(h.out);
      expect(env.error!.code).toBe("nk-missing-field");
      // ⚠ `code` ALONE IS NOT A DISCRIMINATOR — row (iv) carries the same code with a `fields[n].value`
      // path. Asserting the exact path is what tells the two apart.
      expect(env.error!.field).toBe("title");
      expect(h.writes).toEqual([]);
    }
  });

  test("(iii) a NON-title gap is an ADVISORY: exit 0, fence created, key omitted, name in the report", async () => {
    // 🔴 THIS IS WHERE FR-9 ACTUALLY LIVES, and it is a PREVIEW assertion rather than an exit code.
    // Turning it into an exit 1 would contradict the PRD ("a field absent in the note is omitted
    // gracefully") and refuse notes the product is specified to accept.
    const gapped = "---\nnk-type: card\ntitle: Primer\nstatus: live\n---\n\nProse.\n"; // no `summary`
    const h = harness({ readNote: scriptedReads(gapped, gapped, null) });
    const code = await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--json", "--at", AT], h.deps);
    // The write is reported unverified (the scripted reader returns null on read-back), but the point
    // here is what was COMPOSED, and that the gap did not change the decision to compose it.
    expect(h.writes).toHaveLength(1);
    const f = locateFence(h.writes[0]![1])!;
    expect(Object.keys(parseFenceBody(f.body))).toEqual(["title", "status"]); // `summary` omitted
    expect(f.body).not.toContain("summary");
    expect(code).not.toBe(2);
  });

  test("(iii) …and the gap NAME reaches stdout in the preview, plus `value.gaps` under --json", async () => {
    const gapped = "---\nnk-type: card\ntitle: Primer\nstatus: live\n---\n\nProse.\n";

    const human: string[] = [];
    expect(await runNotekitRead(["render", "n.md", ...CONFIG, "--at", AT], preview(gapped, human))).toBe(0);
    // An exit code alone tells the human nothing about WHICH field to add. FR-9's whole point.
    expect(human.join("\n")).toContain("summary");

    const json: string[] = [];
    expect(await runNotekitRead(["render", "n.md", ...CONFIG, "--at", AT, "--json"], preview(gapped, json))).toBe(0);
    const env = JSON.parse(json[0]!) as { value: { gaps: string[]; diff: string } };
    expect(env.value.gaps).toEqual(["summary"]);

    // ⚠ BOTH MODES RENDER FROM THE ONE RESULT OBJECT — the same rule 2.1 applies to `capabilities`.
    // The JSON `value.diff` (the whole proposed block) and the human preview's block region are the
    // same bytes; two printers is exactly what drifts.
    expect(human.join("\n")).toContain(env.value.diff);
  });

  test("(iii) DELETE THE ADVISORY AND THIS GOES RED — a fully-answered note reports NO gap", async () => {
    // The falsifiability check: if the advisory were unconditional text it would appear here too.
    const json: string[] = [];
    expect(await runNotekitRead(["render", "n.md", ...CONFIG, "--at", AT, "--json"], preview(SEEDABLE, json))).toBe(0);
    expect((JSON.parse(json[0]!) as { value: { gaps: string[] } }).value.gaps).toEqual([]);

    const human: string[] = [];
    await runNotekitRead(["render", "n.md", ...CONFIG, "--at", AT], preview(SEEDABLE, human));
    expect(human.join("\n")).not.toContain("no value for");
  });

  test("(iv) a WRONG-SHAPE field is UNIT-LEVEL ONLY — it is unreachable from a note", async () => {
    // `parseFrontmatter` emits only `string | string[]` and filters empty elements, so every derived
    // array is DENSE. A holed or non-string element can only arrive from a hand-built record — so it
    // is tested against `validate` directly rather than through a CLI fixture that cannot fire.
    const holed: string[] = ["a"];
    delete (holed as unknown as Record<number, string>)[0];
    holed[1] = "b";
    const spec = noteToRenderSpec({ title: "T", summary: holed }, rubric, { id: "x", generatedAt: AT });
    const result = validate(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("nk-missing-field");
      // The DIFFERENT `field` path under the SAME code — this is what (ii) cannot be confused with.
      expect(result.error.field).toMatch(/^fields\[\d+\]\.value$/);
    }
  });

  test("`nk-unknown-version` is DECLARED UNREACHABLE in author mode", () => {
    // `RenderSpec.version` is the literal `"nk-v1"` and `noteToRenderSpec` stamps it, so `validate`
    // dispatches to the only branch there is. The code can arise only through `validate --spec -` with
    // a foreign spec on stdin — a verb author mode never calls. Of the two `RenderSpecErrorCode`
    // members, exactly ONE is reachable here. Stated so nobody writes a test that cannot fail.
    const spec = noteToRenderSpec({ title: "T" }, rubric, { id: "x", generatedAt: AT });
    expect((spec as { version: string }).version).toBe("nk-v1");
    expect(validate(spec).ok).toBe(true);
  });

  test("4 gap paths, 0 NEW error codes — every one is a code 2.1 already ships", () => {
    // (A `typeof c === "string"` assertion over a literal array stood here and could not fail for any
    // implementation — deleted after cross-vendor review, F5. The source greps below are the real half.)
    const src = readFileSync(new URL("./notekit-write.ts", import.meta.url), "utf-8");
    // The write-code union is 2.2's three, unchanged — 2.5 adds none.
    expect(src.match(/"nk-(note-changed|write-failed|write-unverified)"/g)!.length).toBeGreaterThan(0);
    expect(src).not.toContain("nk-author");
    expect(src).not.toContain("nk-created");
  });
});

// ═══ AC #1's MECHANICAL GATE — the derivation happens in exactly one place ════════════════════════

describe("AC #1 — the frontmatter→fence derivation has ONE call site, and the residuals are named", () => {
  const ROOT = join(import.meta.dir, "..", "..");

  /** The scope, as a GLOB over `src/` — never a shell-expanded path list. See the test below for why. */
  const SCOPE = ["-g", "src/notekit/**/*.ts", "-g", "src/cli/notekit-*.ts", "-g", "!*.test.ts"];

  function scopeFiles(): string[] {
    const proc = Bun.spawnSync({ cmd: ["rg", "--files", "src/", ...SCOPE], cwd: ROOT, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    return proc.stdout.toString().trim().split("\n").filter((l) => l.length > 0);
  }

  /**
   * Every REAL `parseFrontmatter(` call in scope, with comments and strings masked.
   *
   * ⚠ THREE WAYS A NAÏVE GREP GETS THIS WRONG, all of them measured on this tree rather than imagined:
   *   1. A BARE IDENTIFIER (`\bparseFrontmatter\b`) counts the `import { parseFrontmatter }` line, so
   *      the very module the story prescribes reads as two hits in a file that must have one. An import
   *      declares intent; the thing being counted is CALL SITES. This is 2.2's `atomicWrite` trap.
   *   2. Even the call form counts PROSE — `notekit-read.ts` explains the hazard twice in docblocks,
   *      writing `serializeFenceBody(parseFrontmatter(text))` as the thing NOT to do. Masking comments
   *      is what separates a warning from a violation.
   *   3. A shell-expanded path list is not the same scope as a glob: `-g '!*.test.ts'` does NOT filter
   *      a file ripgrep was handed explicitly, so `src/cli/notekit-*.ts` drags the test files in and
   *      this story's own `parseFrontmatter(`-shaped fixtures count as violations. Asserted below.
   */
  /**
   * ⚠ THE MATCHER COVERS BOTH READER NAMES. `parseFrontmatterBlock` is `parseFrontmatter`'s superset —
   * same match, plus the block's end offset — so a gate that named only the shorter one could be
   * satisfied by renaming the call. A gate you can pass by importing a different alias is not a gate.
   */
  const READS_FRONTMATTER = /\bparseFrontmatter(?:Block)?\s*\(/;

  function callSites(): Array<{ file: string; line: number }> {
    const hits: Array<{ file: string; line: number }> = [];
    for (const file of scopeFiles()) {
      const masked = stripStringsAndComments(readFileSync(join(ROOT, file), "utf-8"));
      masked.split("\n").forEach((text, i) => {
        if (READS_FRONTMATTER.test(text)) hits.push({ file, line: i + 1 });
      });
    }
    return hits;
  }

  test("EXACTLY ONE frontmatter read in the whole slice, and it is named", () => {
    // ⚠ THIS SHIPPED AT **TWO** FIRST, AND THAT WAS A SOFTENED GATE DEFENDED WITH A TRUE-BUT-IRRELEVANT
    // FACT. The argument was: 2.1's `nk-type:` opt-in read is sanctioned by NK-1.8 rule 2, therefore
    // "exactly one" is unreachable on live code. The premise is true and the conclusion did not follow —
    // rule 2 sanctions CONSULTING the opt-in, it never required a second `parseFrontmatter(` site.
    // `renderPlan` already holds the whole record when it checks the opt-in, so threading it into
    // `deriveFenceFields` costs nothing and the slice reads frontmatter ONCE. Cross-vendor review
    // (grok, 2026-08-06, F3) refused the softening and was right to.
    //
    // What the one site now feeds, from one match: the opt-in presence check, the rubric projection
    // (`deriveFenceFields`, which takes the RECORD), and the fence insertion offset (the block's `end`).
    const sites = callSites();
    expect(sites).toHaveLength(1);
    expect(sites[0]!.file).toBe("src/cli/notekit-read.ts");

    const src = readFileSync(join(ROOT, "src/cli/notekit-read.ts"), "utf-8").split("\n");
    const enclosing = sites.map((s) => {
      for (let i = s.line - 1; i >= 0; i--) {
        // ⚠ `async` IS PART OF THE SHAPE. Without it the walk skips straight past
        // `export async function renderPlan(` and attributes its call to whatever plain `function`
        // sits above — which is how this assertion first reported the wrong owner and would have gone
        // on naming a bystander after any future edit moved the declarations around.
        const m = /^(?:export )?(?:async )?function (\w+)/.exec(src[i]!);
        if (m) return m[1];
      }
      return "<module>";
    });
    expect(enclosing).toEqual(["renderPlan"]);
  });

  test("`deriveFenceFields` reads NO frontmatter — it projects a record it is handed", () => {
    // The structural half of the claim above: the derivation cannot re-read even if someone wanted it
    // to, because it never receives note text. Its signature is the guard.
    const src = readFileSync(join(ROOT, "src/cli/notekit-read.ts"), "utf-8");
    const start = src.indexOf("export function deriveFenceFields");
    expect(start).toBeGreaterThan(-1); // ⚠ a -1 here silently slices to nothing — see the D4 gate below
    const body = stripStringsAndComments(src.slice(start, src.indexOf("\nexport ", start + 1)));
    expect(READS_FRONTMATTER.test(body)).toBe(false);
    expect(body).toContain("frontmatter: Record<string, string | string[]>");
  });

  test("COUNTERFACTUAL — a planted second call site REDDENS the gate, under EITHER reader name", () => {
    // Run against text rather than by editing a shipped file, so the gate is proven to move without
    // leaving the tree dirty. Both plants are the exact convenience the AC warns about.
    const writer = readFileSync(join(ROOT, "src/cli/notekit-write.ts"), "utf-8");
    for (const plant of [
      `function titleShortcut(md: string) { return parseFrontmatter(md)["title"]; }`,
      `function endShortcut(md: string) { return parseFrontmatterBlock(md).end; }`,
    ]) {
      const masked = stripStringsAndComments(`${writer}\n${plant}\n`);
      expect(masked.split("\n").filter((l) => READS_FRONTMATTER.test(l))).toHaveLength(1);
    }
    expect(callSites()).toHaveLength(1); // …and the real tree is unchanged
  });

  test("COUNTERFACTUAL — an IMPORT is not a call, and PROSE is not a call", () => {
    // Both of these are present in the real tree right now, and a naïve gate counts both.
    const raw = readFileSync(join(ROOT, "src/cli/notekit-read.ts"), "utf-8");
    expect(raw).toContain("  parseFrontmatterBlock,"); // the import — bare-identifier scans count this
    // …and the docblocks explain the hazard by writing the call form out, which is not a violation.
    const rawCallForm = raw.split("\n").filter((l) => READS_FRONTMATTER.test(l));
    expect(rawCallForm.length).toBeGreaterThan(callSites().length);
  });

  test("THE SCOPE IS A GLOB, and the shell-expanded form is a DIFFERENT, broken scope", () => {
    // `-g '!*.test.ts'` does not filter a file ripgrep was handed explicitly. Measured, not assumed.
    const globbed = scopeFiles();
    expect(globbed.length).toBeGreaterThan(0); // a scope that matches nothing is a gate that reads nothing
    expect(globbed.every((f) => !f.endsWith(".test.ts"))).toBe(true);

    const expanded = Bun.spawnSync({
      cmd: ["rg", "--files", "-g", "!*.test.ts", "src/notekit/", "src/cli/notekit-read.test.ts"],
      cwd: ROOT, stdout: "pipe", stderr: "pipe", stdin: "ignore",
    }).stdout.toString();
    // The explicitly-handed test file survives the ignore glob — which is the whole trap.
    expect(expanded).toContain("src/cli/notekit-read.test.ts");
  });
});

describe("🔴 REGRESSION (cross-vendor review F2) — a GLUED closing delimiter must not wreck the note", () => {
  // The defect, end to end: `parseFrontmatter` accepted `---EXTRA prose` as a closing delimiter and
  // returned a real record WITH the `nk-type:` opt-in, while a caller-side "where does frontmatter
  // stop" pattern found no match and reported offset 0. Author mode then inserted the fence BEFORE the
  // opening `---`. The note stopped being frontmatter-led, its opt-in silently vanished — and every
  // other check still passed, including the `locateFence` oracle, which happily found the new fence in
  // the wreckage. Fixed structurally: `parseFrontmatterBlock` reports fields and end from ONE match.
  const GLUED = "---\nnk-type: card\ntitle: Primer\nstatus: live\n---EXTRA\nProse the human wrote.\n";

  test("the fence lands AFTER the frontmatter, and the opt-in survives", async () => {
    const h = harness({ readNote: scriptedReads(GLUED, GLUED, null) });
    await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--at", AT], h.deps);
    expect(h.writes).toHaveLength(1);
    const written = h.writes[0]![1];

    // The three properties the old code broke, each asserted separately so a partial regression is
    // still visible: still frontmatter-led, opt-in still readable, fence after the block.
    expect(written.startsWith("---\nnk-type: card\n")).toBe(true);
    expect(parseFrontmatter(written)["nk-type"]).toBe("card");
    const f = locateFence(written)!;
    expect(written.slice(0, f.blockStart)).toContain("---EXTRA");
    expect(parseFenceBody(f.body)).toEqual({ title: "Primer", status: "live" });
  });

  test("…and the note is re-renderable: the round trip finds the fence it just wrote", async () => {
    // The sharpest form of the claim. Under the defect this failed at the FIRST row — the note had no
    // opt-in any more, so a second `render` exited `nk-no-opt-in` on a note author mode had authored.
    const h = harness({ readNote: scriptedReads(GLUED, GLUED, null) });
    await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--at", AT], h.deps);
    const written = h.writes[0]![1];

    const second: string[] = [];
    const code = await runNotekitRead(["render", "n.md", ...CONFIG, "--at", AT, "--json"], {
      log: (l) => second.push(l), err: () => {},
      loadRegistry: async () => REGISTRY, readNote: () => written,
    });
    expect(code).toBe(0);
    const env = JSON.parse(second[0]!) as { ok: boolean; value: Record<string, unknown> };
    expect(env.ok).toBe(true);
    expect(env.value).not.toHaveProperty("gaps"); // the TRANSFORM arm — the note now has a fence
  });

  test("prose after the glued delimiter is byte-identical", async () => {
    const h = harness({ readNote: scriptedReads(GLUED, GLUED, null) });
    await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--at", AT], h.deps);
    const written = h.writes[0]![1];
    const f = locateFence(written)!;
    expect(written.slice(0, f.blockStart) + written.slice(f.blockEnd)).toBe(
      GLUED.slice(0, GLUED.indexOf("Prose")) + "\n" + "\n" + GLUED.slice(GLUED.indexOf("Prose")),
    );
  });
});

describe("the two nk-no-fence refusal arms are DISTINGUISHABLE by message (review F4)", () => {
  test("an unterminated fence and an unseedable note carry the same code, different sentences", async () => {
    // A second CODE would be a widening SM-C2 counts against, and 2.3's/2.4's inventories pin the
    // count — so the code stays `nk-no-fence` and the MESSAGE answers "why".
    const torn = harness({ readNote: () => "---\nnk-type: card\ntitle: T\n---\n\n```nk-card\ntitle: T\n" });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--json"], torn.deps)).toBe(1);
    const tornEnv = envelope(torn.out);

    const bare = harness({ readNote: () => "---\nnk-type: card\n---\n\njust prose\n" });
    expect(await runNotekitApply(["render", "n.md", ...CONFIG, "--apply", "--json"], bare.deps)).toBe(1);
    const bareEnv = envelope(bare.out);

    expect(tornEnv.error!.code).toBe("nk-no-fence");
    expect(bareEnv.error!.code).toBe("nk-no-fence");
    expect(tornEnv.error!.message).not.toBe(bareEnv.error!.message);
    expect(String(tornEnv.error!.message)).toContain("never closed");
    expect(String(bareEnv.error!.message)).toContain("nothing to seed");
  });
});
