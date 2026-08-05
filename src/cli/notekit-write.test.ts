import { test, expect, describe } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { composeBody, runNotekitApply, type NotekitApplyDeps } from "./notekit-write";
import { errorText, runNotekitRead } from "./notekit-read";
import { locateFence, parseFenceBody, serializeFenceBody, type FenceFields } from "../notekit/index";
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
