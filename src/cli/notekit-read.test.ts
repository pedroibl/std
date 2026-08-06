import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VALUE_FLAGS, runNotekitRead, type NotekitReadDeps } from "./notekit-read";
import { SURFACE } from "./surface";
import { stripStringsAndComments } from "../../scripts/lib/specifiers";
import type { NoteTypeRegistry } from "../notekit/index";

const AT = "2026-01-01T00:00:00.000Z";

const REGISTRY: NoteTypeRegistry = {
  noteTypes: { card: "catalog-card" },
  templates: {
    "catalog-card": {
      renderer: "nk-card",
      rubric: {
        kind: "card",
        titleField: "title",
        fields: [{ key: "summary", label: "SUMMARY" }, { key: "status" }],
      },
    },
  },
};

const NOTE = ["---", "nk-type: card", "---", "", "```nk-card", "title: Primer", "summary: A thing", "status: live", "```", ""].join("\n");

/** A capture harness: every effect injected, so no test touches a real fs, stdin or clock. */
function harness(over: Partial<NotekitReadDeps> = {}): {
  deps: NotekitReadDeps;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      log: (l) => out.push(l),
      err: (l) => err.push(l),
      now: () => AT,
      loadRegistry: async () => REGISTRY,
      readNote: () => NOTE,
      ...over,
    },
  };
}

const CONFIG = ["--config", "cfg.ts"];

// ── AC #1 — `render` previews, and every one of its seven exit rows is enumerated ────────────────

describe("render — the seven-row exit table", () => {
  test("row 7: success emits {html, diff, spec} at exit 0", async () => {
    const h = harness();
    const code = await runNotekitRead(["render", "note.md", ...CONFIG, "--json"], h.deps);
    expect(code).toBe(0);
    expect(h.out).toHaveLength(1);
    const env = JSON.parse(h.out[0]!) as {
      ok: boolean;
      value: { html: string; diff: string; spec: Record<string, unknown> };
    };
    expect(env.ok).toBe(true);
    expect(env.value.html).toContain("nk-card");
    expect(env.value.spec.version).toBe("nk-v1");
    expect(env.value.spec.title).toBe("Primer");
    expect(env.value.spec.generatedAt).toBe(AT);
    expect(env.value.spec.id).toBe("nk-notemd"); // slugify drops the dot; the id is a slug, not a path
    expect(h.err).toEqual([]); // nothing on stderr on the happy path
  });

  test("row 1: no <note> positional is a usage 2 with NO JSON on stdout", async () => {
    const h = harness();
    expect(await runNotekitRead(["render", ...CONFIG, "--json"], h.deps)).toBe(2);
    expect(h.out).toEqual([]);
    expect(h.err.join("\n")).toContain("<note> path is required");
  });

  test("the <note> positional survives flags placed BEFORE it", async () => {
    // `positional(argv.slice(1))` returns the first non-`--` token, which for
    // `render --config cfg.ts note.md` is **cfg.ts** — so the config file would be rendered as a note
    // on every invocation that puts a flag first. Found at dev time; a space-form value flag must be
    // skipped WITH its value.
    const seen: string[] = [];
    const h = harness({
      readNote: (p) => {
        seen.push(p);
        return NOTE;
      },
    });
    expect(await runNotekitRead(["render", ...CONFIG, "note.md", "--json"], h.deps)).toBe(0);
    expect(seen).toEqual(["note.md"]);

    // …and the equals form consumes nothing, so the path is still found.
    const eq = harness({
      readNote: (p) => {
        seen.push(p);
        return NOTE;
      },
    });
    expect(await runNotekitRead(["render", "--config=cfg.ts", "note.md", "--json"], eq.deps)).toBe(0);
    expect(seen).toEqual(["note.md", "note.md"]);
  });

  test("row 1: a missing --config is a usage 2, NOT alias's 1", async () => {
    const h = harness();
    expect(await runNotekitRead(["render", "note.md", "--json"], h.deps)).toBe(2);
    expect(h.out).toEqual([]);
    expect(h.err.join("\n")).toContain("--config <path> is required");
  });

  test("row 1: an UNLOADABLE --config is a usage 2, and does not reject", async () => {
    const h = harness({
      loadRegistry: async () => {
        throw new Error("boom at load");
      },
    });
    expect(await runNotekitRead(["render", "note.md", ...CONFIG], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("cannot load the note-type registry");
  });

  test("row 2: an unreadable note exits 1 with nk-note-unreadable", async () => {
    const h = harness({ readNote: () => null });
    expect(await runNotekitRead(["render", "gone.md", ...CONFIG, "--json"], h.deps)).toBe(1);
    expect(JSON.parse(h.out[0]!)).toEqual({
      ok: false,
      error: { code: "nk-note-unreadable", message: "cannot read note 'gone.md'" },
    });
  });

  test("row 3: no nk-type frontmatter opt-in exits 1 with nk-no-opt-in", async () => {
    const h = harness({ readNote: () => "```nk-card\ntitle: X\n```\n" });
    expect(await runNotekitRead(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(1);
    expect((JSON.parse(h.out[0]!) as { error: { code: string } }).error.code).toBe("nk-no-opt-in");
  });

  test("row 4: an opted-in note with no fence exits 1 with nk-no-fence", async () => {
    const h = harness({ readNote: () => "---\nnk-type: card\n---\n\njust prose\n" });
    expect(await runNotekitRead(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(1);
    expect((JSON.parse(h.out[0]!) as { error: { code: string } }).error.code).toBe("nk-no-fence");
  });

  test("row 5: an unregistered fence type exits 1 with nk-unknown-type", async () => {
    const h = harness({
      readNote: () => "---\nnk-type: card\n---\n\n```nk-primer\ntitle: X\n```\n",
    });
    expect(await runNotekitRead(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(1);
    const env = JSON.parse(h.out[0]!) as { error: { code: string; message: string } };
    expect(env.error.code).toBe("nk-unknown-type");
    expect(env.error.message).toContain("primer");
  });

  test("row 6: an invalid spec exits 1 with the RenderSpecError VERBATIM (code + field)", async () => {
    // No `title` key in the fence → noteToRenderSpec produces an empty title → validate rejects it.
    const h = harness({
      readNote: () => "---\nnk-type: card\n---\n\n```nk-card\nsummary: no title here\n```\n",
    });
    expect(await runNotekitRead(["render", "n.md", ...CONFIG, "--json"], h.deps)).toBe(1);
    const env = JSON.parse(h.out[0]!) as { error: { code: string; field: string; message: string } };
    // ⚠ the field is `code`, not `kind` — NK-7's prose says `kind`, the shipped type says `code`.
    expect(env.error.code).toBe("nk-missing-field");
    expect(env.error.field).toBe("title");
    expect(typeof env.error.message).toBe("string");
  });
});

describe("render — determinism and the FR-16 parity diff", () => {
  test("--at makes the output byte-identical across runs", async () => {
    const a = harness({ now: () => "DRIFTS" });
    const b = harness({ now: () => "DRIFTS-DIFFERENTLY" });
    await runNotekitRead(["render", "n.md", ...CONFIG, "--at", AT, "--json"], a.deps);
    await runNotekitRead(["render", "n.md", ...CONFIG, "--at", AT, "--json"], b.deps);
    expect(a.out[0]).toBe(b.out[0]!);
  });

  test("a trailing --at with no value is a usage 2, never a silent fall back to the clock", async () => {
    const h = harness();
    expect(await runNotekitRead(["render", "n.md", ...CONFIG, "--at"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("--at needs an ISO timestamp");
  });

  test("--at followed by another flag is rejected, not read as the literal '--json'", async () => {
    // flagValue's space form returns args[i+1] unconditionally, so this would otherwise stamp the
    // card with a generatedAt of "--json" at exit 0.
    const h = harness();
    expect(await runNotekitRead(["render", "n.md", ...CONFIG, "--at", "--json"], h.deps)).toBe(2);
  });

  test("a CANONICAL fence body yields an EMPTY diff — that emptiness is the parity signal", async () => {
    const h = harness();
    await runNotekitRead(["render", "n.md", ...CONFIG, "--at", AT, "--json"], h.deps);
    expect((JSON.parse(h.out[0]!) as { value: { diff: string } }).value.diff).toBe("");
  });

  test("a NON-CANONICAL body yields a NON-EMPTY diff — without this the signal cannot go red", async () => {
    // Every declared normalization at once: a blank line, a colon-less line, and a repeated key.
    const messy = [
      "---",
      "nk-type: card",
      "---",
      "",
      "```nk-card",
      "title: Primer",
      "",
      "prose without a colon",
      "status: draft",
      "status: live",
      "```",
      "",
    ].join("\n");
    const h = harness({ readNote: () => messy });
    await runNotekitRead(["render", "n.md", ...CONFIG, "--at", AT, "--json"], h.deps);
    const diff = (JSON.parse(h.out[0]!) as { value: { diff: string } }).value.diff;
    expect(diff).not.toBe("");
    expect(diff).toContain("status: live");
  });

  test("a CRLF note reports parity rather than flagging every line as changed", async () => {
    const h = harness({ readNote: () => NOTE.replace(/\n/g, "\r\n") });
    await runNotekitRead(["render", "n.md", ...CONFIG, "--at", AT, "--json"], h.deps);
    expect((JSON.parse(h.out[0]!) as { value: { diff: string } }).value.diff).toBe("");
  });

  test("without --json the HTML and the parity verdict go to stdout, not stderr", async () => {
    const h = harness();
    expect(await runNotekitRead(["render", "n.md", ...CONFIG, "--at", AT], h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("nk-card");
    expect(h.out.join("\n")).toContain("FR16 parity holds");
    expect(h.err).toEqual([]);
  });
});

// ── AC #2 — `validate --spec -` returns the Result union ─────────────────────────────────────────

function validSpec(): Record<string, unknown> {
  return {
    version: "nk-v1",
    kind: "card",
    id: "nk-x",
    generatedAt: AT,
    title: "Primer",
    fields: [{ key: "summary", label: "SUMMARY", value: "a thing" }],
  };
}

describe("validate", () => {
  test("ok:true is one line of JSON on stdout at exit 0", async () => {
    const spec = validSpec();
    const h = harness({ readStdin: async () => spec });
    expect(await runNotekitRead(["validate", "--spec", "-", "--json"], h.deps)).toBe(0);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0]!)).toEqual({ ok: true, value: spec });
    expect(h.err).toEqual([]);
  });

  test("ok:false carries {code, message, field} at exit 1", async () => {
    const h = harness({ readStdin: async () => ({ ...validSpec(), title: "" }) });
    expect(await runNotekitRead(["validate", "--spec", "-", "--json"], h.deps)).toBe(1);
    const env = JSON.parse(h.out[0]!) as { ok: boolean; error: Record<string, unknown> };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("nk-missing-field");
    expect(env.error.field).toBe("title");
    expect(typeof env.error.message).toBe("string");
  });

  test("without --json the human verdict is rendered from the SAME Result value", async () => {
    const pass = harness({ readStdin: async () => validSpec() });
    expect(await runNotekitRead(["validate", "--spec", "-"], pass.deps)).toBe(0);
    expect(pass.out.join("")).toContain("✓ nk-v1 RenderSpec valid");

    const fail = harness({ readStdin: async () => ({ ...validSpec(), title: "" }) });
    expect(await runNotekitRead(["validate", "--spec", "-"], fail.deps)).toBe(1);
    expect(fail.out).toEqual([]); // failures go to stderr, never stdout
    expect(fail.err.join("")).toContain("✗ nk-missing-field at title");
  });

  test("--spec anything-but-dash is a usage 2 — `-` is the whole v1 grammar", async () => {
    for (const argv of [
      ["validate", "--json"],
      ["validate", "--spec", "spec.json"],
      ["validate", "--spec"],
    ]) {
      const h = harness({ readStdin: async () => validSpec() });
      expect(await runNotekitRead(argv, h.deps)).toBe(2);
      expect(h.out).toEqual([]);
    }
  });

  test("unusable stdin is a usage 2 with NO JSON — never a lying ok:false verdict", async () => {
    // empty / malformed / timeout all arrive as one `null` through readStdinJson, and a validation
    // verdict on input that never arrived would be a lie.
    const h = harness({ readStdin: async () => null });
    expect(await runNotekitRead(["validate", "--spec", "-", "--json"], h.deps)).toBe(2);
    expect(h.out).toEqual([]);
    expect(h.err.join("")).toContain("no usable JSON on stdin");
  });
});

// E1-A3 — the four input classes, each producing ok:false with a code, never a throw, never ok:true.
describe("validate — the four E1-A3 input classes", () => {
  async function verdict(candidate: unknown): Promise<{ code: string; field: string }> {
    const h = harness({ readStdin: async () => candidate });
    const code = await runNotekitRead(["validate", "--spec", "-", "--json"], h.deps);
    expect(code).toBe(1);
    const env = JSON.parse(h.out[0]!) as {
      ok: boolean;
      error: { code: string; field: string; message: string };
    };
    expect(env.ok).toBe(false);
    // Every verdict carries a human message; the assertions below pin the CLASSIFICATION, so the
    // message is checked for presence here rather than pinned as prose in fifteen places.
    expect(typeof env.error.message).toBe("string");
    expect(env.error.message.length).toBeGreaterThan(0);
    return { code: env.error.code, field: env.error.field };
  }

  test("(a) a prototype-chain name as `version` is nk-unknown-version, never a blessed spec", async () => {
    for (const version of ["constructor", "toString", "__proto__", "valueOf"]) {
      expect((await verdict({ ...validSpec(), version })).code).toBe("nk-unknown-version");
    }
  });

  test("(b) a holed fields array names fields[n]; a holed value names fields[n].value", async () => {
    // The two report DIFFERENT paths — assert each exactly, they are not interchangeable.
    const holedRow = await verdict({ ...validSpec(), fields: [, { key: "a", label: "A", value: "v" }] });
    expect(holedRow).toEqual({ code: "nk-missing-field", field: "fields[0]" });

    const holedValue = await verdict({
      ...validSpec(),
      fields: [{ key: "a", label: "A", value: ["x", , "z"] }],
    });
    expect(holedValue).toEqual({ code: "nk-missing-field", field: "fields[0].value" });
  });

  test("(c) an empty string in any required slot names that path", async () => {
    for (const [key, path] of [
      ["id", "id"],
      ["title", "title"],
      ["generatedAt", "generatedAt"],
    ] as const) {
      expect(await verdict({ ...validSpec(), [key]: "" })).toEqual({
        code: "nk-missing-field",
        field: path,
      });
    }
    expect(
      await verdict({ ...validSpec(), fields: [{ key: "", label: "A", value: "v" }] }),
    ).toEqual({ code: "nk-missing-field", field: "fields[0].key" });
    expect(
      await verdict({ ...validSpec(), fields: [{ key: "a", label: "", value: "v" }] }),
    ).toEqual({ code: "nk-missing-field", field: "fields[0].label" });
  });

  test("(d) a non-object candidate is nk-missing-field at `version`", async () => {
    for (const bad of [7, "str", []]) {
      expect(await verdict(bad)).toEqual({ code: "nk-missing-field", field: "version" });
    }
    // ⚠ a literal JSON `null` is indistinguishable from empty/malformed/timeout by readStdinJson, so
    // it takes the USAGE path instead. Declared, not silently absorbed.
    const h = harness({ readStdin: async () => null });
    expect(await runNotekitRead(["validate", "--spec", "-", "--json"], h.deps)).toBe(2);
  });
});

// ── AC #3 — `capabilities` ───────────────────────────────────────────────────────────────────────

describe("capabilities", () => {
  test("--json emits the catalog union as the only thing on stdout", async () => {
    const h = harness();
    expect(await runNotekitRead(["capabilities", ...CONFIG, "--json"], h.deps)).toBe(0);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0]!)).toEqual({
      ok: true,
      value: {
        catalogVersion: "nk-cap-v1",
        noteTypes: [
          {
            nkType: "card",
            templateId: "catalog-card",
            renderer: "nk-card",
            titleField: "title",
            fields: [
              { key: "summary", label: "SUMMARY" },
              { key: "status", label: "status" },
            ],
          },
        ],
      },
    });
    expect(h.err).toEqual([]);
  });

  test("without --json a short human table goes to stdout, from the SAME catalog object", async () => {
    const h = harness();
    expect(await runNotekitRead(["capabilities", ...CONFIG], h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("nk-cap-v1");
    expect(h.out.join("\n")).toContain("card");
  });

  test("its exit set is {0, 2} — a registry resolving NOTHING still exits 0", async () => {
    // Every malformed class degrades in the generator, so there is no failure verdict to report. A
    // capabilities run that returns 1 means someone added a throw path.
    const h = harness({ loadRegistry: async () => ({}) as NoteTypeRegistry });
    expect(await runNotekitRead(["capabilities", ...CONFIG, "--json"], h.deps)).toBe(0);
    expect(JSON.parse(h.out[0]!)).toEqual({
      ok: true,
      value: { catalogVersion: "nk-cap-v1", noteTypes: [] },
    });
  });

  test("a missing --config is the ONLY non-zero exit, and it is 2", async () => {
    const h = harness();
    expect(await runNotekitRead(["capabilities", "--json"], h.deps)).toBe(2);
    expect(h.out).toEqual([]);
  });
});

// ── the dispatch arm that main.ts cannot reach ───────────────────────────────────────────────────

describe("dispatch", () => {
  test("an unknown subcommand exits 2 with usage on stderr", async () => {
    // Unreachable from main.ts (only the three known verbs route in), so it is green by construction
    // unless exercised directly — and `dispatchAsync`'s onUnknown is a REQUIRED third parameter, so
    // the arm cannot simply be dropped.
    const h = harness();
    expect(await runNotekitRead(["bogus"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("unknown subcommand 'bogus'");
  });

  test("an ABSENT subcommand exits 2 with bare usage", async () => {
    const h = harness();
    expect(await runNotekitRead([], h.deps)).toBe(2);
    expect(h.err.join("\n")).toContain("usage: std notekit");
  });

  test("a throw does not escape — a config module that throws at load exits 2, not rejects", async () => {
    const h = harness({
      loadRegistry: () => {
        throw new Error("top-level throw at import");
      },
    });
    expect(await runNotekitRead(["render", "n.md", ...CONFIG], h.deps)).toBe(2);
  });

  test("an UNMODELLED throw is fail-loud 1, not a usage 2", async () => {
    // The two codes are not interchangeable: 2 means "you typed something wrong". Everything reaching
    // the outer catch is an internal fault (cardTree on a non-object spec, an fs fault outside the
    // modelled null), and calling that usage misdirects the user. The one genuinely-usage throw — an
    // unloadable --config — never gets here, because resolveRegistry catches it and returns 2 itself.
    const h = harness({
      readNote: () => {
        throw new Error("fs exploded in an unmodeled way");
      },
    });
    expect(await runNotekitRead(["render", "n.md", ...CONFIG], h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("fs exploded in an unmodeled way");
  });

  test("…and the two paths stay DISTINGUISHABLE — a bad --config is still 2", async () => {
    // The assertion that keeps the fix honest: if the fail-loud catch ever swallowed the config path
    // too, both would collapse to one code and the distinction above would be decorative.
    const h = harness({
      loadRegistry: () => {
        throw new Error("top-level throw at import");
      },
    });
    expect(await runNotekitRead(["render", "n.md", ...CONFIG], h.deps)).toBe(2);
  });

  test("a caller config that throws from INSIDE capabilities is a crash (1), not a verdict", async () => {
    // A registry is arbitrary caller TypeScript. This is why `capabilities` is documented as having no
    // failure VERDICT rather than as "exit set {0,2}" — the latter reading is strictly false.
    //
    // ⚠ A plain throwing GETTER, deliberately, and not a Proxy: a Proxy raises on the `await` inside
    // resolveRegistry (awaiting any object reads `.then`), so it never reaches the generator and exits
    // 2 as a config-load failure — measured during the 2.1 code review. Only a getter on an otherwise
    // ordinary object survives the load and throws where this test needs it to.
    const hostile = { templates: {} } as unknown as NoteTypeRegistry;
    Object.defineProperty(hostile, "noteTypes", {
      enumerable: true,
      get(): never {
        throw new Error("hostile registry getter");
      },
    });
    const h = harness({ loadRegistry: async () => hostile });
    expect(await runNotekitRead(["capabilities", ...CONFIG, "--json"], h.deps)).toBe(1);
    expect(h.out).toEqual([]);
    expect(h.err.join("\n")).toContain("hostile registry getter");
  });

  test("…and a PROXY registry is a config-load failure (2), which is a different thing", async () => {
    // Recorded because it is the case the review probed, and the two codes are correct for different
    // reasons: the Proxy never survived loading; the getter did and then crashed the generator.
    const h = harness({
      loadRegistry: async () =>
        new Proxy({} as NoteTypeRegistry, {
          get() {
            throw new Error("hostile proxy");
          },
        }),
    });
    expect(await runNotekitRead(["capabilities", ...CONFIG, "--json"], h.deps)).toBe(2);
  });
});

// ── the VALUE_FLAGS drift gate (2.1 code review, finding 3) ──────────────────────────────────────

describe("VALUE_FLAGS tracks the declared surface", () => {
  test("it is EXACTLY the value-arity flags on notekit's read verbs", () => {
    // The landmine this closes: a value flag added to surface.ts and missed in VALUE_FLAGS makes
    // notePositional treat its VALUE as the <note> path — silently, on every invocation that puts the
    // flag first. check:surface-drift cannot catch it: that gate proves every flag READ is declared,
    // which is the opposite direction. So this test is the drift gate for the set's completeness.
    const notekit = SURFACE.commands.find((c) => c.name === "notekit")!;
    const readVerbs = ["render", "validate", "capabilities"];
    const declared = new Set(
      notekit.subcommands
        .filter((sub) => readVerbs.includes(sub.name))
        // Widened deliberately: SURFACE is `as const satisfies CommandSurface`, so each subcommand's
        // `flags` is its own readonly TUPLE of literal types and `flatMap` cannot unify them. The
        // narrowing is what the model is FOR elsewhere; here only `name` and `arity` are read.
        .flatMap((sub) => (sub.flags ?? []) as readonly { name: string; arity: string }[])
        .filter((flag) => flag.arity === "value")
        .map((flag) => flag.name.replace(/^--/, "")),
    );
    expect([...VALUE_FLAGS].sort()).toEqual([...declared].sort());
  });

  test("the gate is not vacuous — it found flags to compare", () => {
    // Both sides empty would satisfy the toEqual above forever.
    expect(VALUE_FLAGS.size).toBeGreaterThan(0);
    // `body` joined at Story 2.7: `--body` is declared `arity: "value"` on `notekit render`, so the
    // equality above forces it — and without it `render --body - --apply <note>` would read the literal
    // `-` as the <note> path.
    expect([...VALUE_FLAGS].sort()).toEqual(["at", "body", "config", "spec"]);
  });
});

// ── AC #4(a) — the behavioural read-only gate ────────────────────────────────────────────────────

/**
 * A fingerprint that can actually go red.
 *
 * ⚠ `readdirSync(dir, {recursive:true})` and NOT `fsx.walkFiles`: `walkFiles` is fail-soft per
 * directory and returns files only, so an unreadable directory silently disappears from the
 * fingerprint and both sides go on matching — the same un-failable class as the hash below.
 *
 * ⚠ RAW BYTES and NOT `core.contentHash`: that is a DEDUP hash — it collapses whitespace, lowercases,
 * and truncates to 400 characters before hashing, so a write that changed only whitespace, or anything
 * past character 400, produces an identical hash and the gate passes while the file is rewritten.
 *
 * ⚠ `statSync(p).isFile()` before reading: `readdirSync` returns directory entries too, and
 * `readFileSync` on a directory throws. mtime rides along as a supporting signal only — `fsx.statMtime`
 * is fail-soft (any stat error, ENOENT included, returns 0), so it cannot tell "deleted" from
 * "unstatable"; the listing and the byte compare are what carry the claim.
 */
function fingerprint(dir: string): string {
  const entries = [...readdirSync(dir, { recursive: true })].map(String).sort();
  const parts: string[] = [];
  for (const rel of entries) {
    const full = join(dir, rel);
    if (!statSync(full).isFile()) {
      parts.push(`${rel}\tDIR`);
      continue;
    }
    parts.push(`${rel}\t${readFileSync(full).toString("base64")}\t${statSync(full).mtimeMs}`);
  }
  return parts.join("\n");
}

describe("AC #4(a) — the read surface provably touches no byte on disk", () => {
  test("a hermetic fixture is byte-identical before and after all three verbs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nk-read-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "note.md"), NOTE);
    writeFileSync(join(dir, "sub", "decoy.md"), "a sibling nothing should touch\n");

    const before = fingerprint(dir);
    const h = harness({ readNote: () => readFileSync(join(dir, "note.md"), "utf-8") });
    await runNotekitRead(["render", join(dir, "note.md"), ...CONFIG, "--at", AT, "--json"], h.deps);
    await runNotekitRead(["capabilities", ...CONFIG, "--json"], h.deps);
    await runNotekitRead(["validate", "--spec", "-", "--json"], {
      ...h.deps,
      readStdin: async () => validSpec(),
    });

    expect(fingerprint(dir)).toBe(before);
  });

  test("the fingerprint goes RED on a planted write — including a whitespace-only one", async () => {
    // The counterfactual for the gate above, run as a test rather than recorded as a claim. The second
    // half is the interesting one: a contentHash-based fingerprint would stay GREEN on it.
    const dir = mkdtempSync(join(tmpdir(), "nk-read-cf-"));
    writeFileSync(join(dir, "note.md"), NOTE);

    const before = fingerprint(dir);
    writeFileSync(join(dir, "note.md"), `${NOTE}   `); // trailing whitespace ONLY
    expect(fingerprint(dir)).not.toBe(before);

    // …and a creation is caught by the listing half.
    const after = fingerprint(dir);
    writeFileSync(join(dir, "planted.md"), "");
    expect(fingerprint(dir)).not.toBe(after);
  });
});

// ── AC #4(b) — the source-level read-only scan ───────────────────────────────────────────────────

/**
 * A CLOSED set, pinned by this test: a new fs API added to the estate later must be added here too.
 * Sixteen tokens — the nine an AC would list, plus the promises/stream siblings a dev would otherwise
 * reach for and a shorter list would miss.
 */
const WRITE_TOKENS = [
  "Bun.write",
  "writeFileSync",
  "appendFileSync",
  "rmSync",
  "unlinkSync",
  "mkdirSync",
  "renameSync",
  "atomicWrite",
  "ensureDir",
  "saveJson",
  "writeFile",
  "appendFile",
  "createWriteStream",
  "copyFileSync",
  "cpSync",
  "truncateSync",
];

/**
 * ⚠ Resolved from `import.meta.dir`, never the cwd: `bun test` inherits whatever directory it was
 * launched from, so a cwd-relative read fails — or worse, silently reads a different tree.
 *
 * ⚠ The scan covers these three files and NEVER this test file, which necessarily carries all sixteen
 * tokens as its own banned list. A self-scan would be permanently red; moving the list into a string to
 * dodge that would make it permanently green under the masker. Vacuous either way.
 *
 * ⚠ `core-fence.ts` is here because `check:core-purity` does NOT cover this: its FORBIDDEN_GLOBALS is
 * `["process","document","fetch","XMLHttpRequest","WebSocket"]` — `Bun` is not among them, so a
 * `Bun.write` inside any `src/notekit/core-*.ts` passes the purity gate cleanly. That hole is why the
 * read-surface claim needs its own scan, and why the file this story EDITS on the render path is in it.
 */
const SCANNED = [
  join(import.meta.dir, "notekit-read.ts"),
  join(import.meta.dir, "..", "notekit", "core-capabilities.ts"),
  join(import.meta.dir, "..", "notekit", "core-fence.ts"),
];

describe("AC #4(b) — no write API appears in the read surface's source", () => {
  test("none of the sixteen write tokens appears in code in any scanned file", () => {
    for (const file of SCANNED) {
      // stripStringsAndComments, not stripComments: the ban is on CODE tokens, so both strings and
      // comments are masked. (check:no-consumer-ids and check:surface-drift mask comments ONLY,
      // because their targets live INSIDE string literals — the opposite case.)
      const code = stripStringsAndComments(readFileSync(file, "utf-8"));
      for (const token of WRITE_TOKENS) {
        expect({ file, token, present: code.includes(token) }).toEqual({
          file,
          token,
          present: false,
        });
      }
    }
  });

  test("the scan is not vacuous — it really read the three files", () => {
    for (const file of SCANNED) {
      expect(readFileSync(file, "utf-8").length).toBeGreaterThan(500);
    }
    expect(WRITE_TOKENS).toHaveLength(16);
  });

  test("counterfactual, BOTH directions: masked in a comment is green, in code is red", () => {
    const real = readFileSync(SCANNED[0]!, "utf-8");

    // A banned token inside a `//` comment must stay GREEN — that is what the masker is for.
    const commented = stripStringsAndComments(`${real}\n// atomicWrite is mentioned, not called\n`);
    expect(commented.includes("atomicWrite")).toBe(false);

    // The same token in CODE must go RED.
    const planted = stripStringsAndComments(`${real}\nconst leak = atomicWrite;\n`);
    expect(planted.includes("atomicWrite")).toBe(true);
  });
});
