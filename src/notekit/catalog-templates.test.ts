// Story 2.6 — the three catalog templates, proven headlessly BEFORE Obsidian is ever opened.
//
// FR-15's claim is not "three cards render". It is "three CONFIGURATIONS of one renderer", and the way
// to say that as a test is the skeleton assertion below: strip the text out of all three projections
// and the tag/class sequences are IDENTICAL. Rows differ; shape does not. That is the property a second
// renderer would break first, and it is why this file exists alongside `edge/renderer-count.test.ts` —
// that one watches the renderer table, this one watches what the templates actually produce.
//
// ⚠ THE RUBRICS ARE DECLARED INLINE AND ARE HAND-KEPT IN STEP WITH THE VAULT CONFIG. Importing
// `~/Documents/note-report/Scripts/notekit.config.ts` from `src/` would bake a vault path into the
// package — the exact `check:no-consumer-ids` / D4 breach this story is otherwise built to avoid.
//
// 🔴 AND NOTHING MECHANICAL CATCHES THAT DRIFT — said plainly, because an earlier version of this
// header claimed the catalog-parity assertion below did. It does not, and a cross-vendor review was
// right to call it. That assertion proves `Object.keys(registry.noteTypes)` ≡ the catalog's `nkType`
// values ON A HERMETIC FIXTURE; it never reads the vault, never compares FIELD lists, and its fixture
// binds all four note types to one shared rubric. So it catches a note type that exists in one place
// and not the other, and it catches nothing at all about whether these three rubrics still match the
// vault's. That parity is hand-kept, full stop. (Checked by hand at authoring: the vault's three
// templates are key- and label-identical to the three below, with zero dead keys against the demo
// notes.) A gate for it would have to live vault-side or at release time, outside `src/` — where the
// vault path is allowed to exist. Overstating a gate is worse than not having one: it stops the next
// person looking.
//
// ⚠ NOT A SECOND ORACLE FOR 1.2's MARKUP CONTRACT. The exact tag vocabulary is `NK_TAGS`'s and has its
// own tests in `core-html.test.ts`. What is asserted here is skeleton IDENTITY across templates and the
// per-template row set — claims about the templates, not about the HTML.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { noteToRenderSpec, renderCardHtml } from "./index";
import type { FenceFields, Injected, Rubric } from "./index";

const HERE = import.meta.dir;
const REPO = join(HERE, "..", "..");
const CLI = join(REPO, "src", "cli", "main.ts");
const CLI_TIMEOUT_MS = 30_000;

/** Injected, never clock-read — a timestamp in a snapshot is a flake waiting to be excused (NFR2). */
const INJECTED: Injected = { id: "nk-fixture", generatedAt: "2026-01-01T00:00:00.000Z" };

const PRIMER: Rubric = {
  kind: "card",
  titleField: "title",
  fields: [
    { key: "status", label: "status" },
    { key: "askedOn", label: "asked" },
    { key: "answeredBy", label: "answered by" },
    { key: "answeredOn", label: "answered" },
    { key: "savedAt", label: "saved" },
    { key: "source", label: "source" },
  ],
};

const PROTOCOL: Rubric = {
  kind: "card",
  titleField: "title",
  fields: [
    { key: "applies-to", label: "applies to" },
    { key: "artifact", label: "artifact" },
    { key: "defined-in", label: "defined in" },
    { key: "created", label: "created" },
    { key: "tags", label: "tags" },
  ],
};

const PATTERN: Rubric = {
  kind: "card",
  titleField: "title",
  fields: [
    { key: "project", label: "project" },
    { key: "tool", label: "tool" },
    { key: "author", label: "author" },
    { key: "source", label: "source" },
    { key: "tags", label: "tags" },
  ],
};

const PRIMER_FIELDS: FenceFields = {
  title: "Architecture brief — std",
  status: "answered",
  askedOn: "2026-07-03",
  answeredBy: "Winston (std architect)",
  answeredOn: "2026-07-03",
  savedAt: "2026-07-02T14:47:56.369Z",
  source: "file",
};

const PROTOCOL_FIELDS: FenceFields = {
  title: "my-functions family — zsh autocompletion",
  "applies-to": "my-functions · find-function · edit-function",
  artifact: "~/.oh-my-zsh/completions/_my-functions",
  "defined-in": "~/.oh-my-zsh/custom/my-functions-management.zsh",
  created: "2026-06-18",
  tags: ["zsh", "completion", "compdef"],
};

const PATTERN_FIELDS: FenceFields = {
  title: "ForgeAsFunction — second-model code producer",
  project: "PAI skill",
  tool: "Tools/ForgeAsFunction.ts",
  author: "Tomé",
  source: "live SKILL.md",
  tags: ["forge", "how-to"],
};

const TEMPLATES = [
  { id: "catalog-primer", rubric: PRIMER, fields: PRIMER_FIELDS },
  { id: "catalog-protocol", rubric: PROTOCOL, fields: PROTOCOL_FIELDS },
  { id: "catalog-pattern", rubric: PATTERN, fields: PATTERN_FIELDS },
] as const;

const project = (rubric: Rubric, fields: FenceFields): string =>
  renderCardHtml(noteToRenderSpec(fields, rubric, INJECTED));

/**
 * The element skeleton: tags and classes, with every text node removed. Two projections that agree
 * here are the same card shape holding different content — which is the whole of "configuration".
 */
function skeleton(html: string): string {
  return (html.match(/<[^>]+>/g) ?? []).join("");
}

describe("FR-15 — three templates, one renderer (headless)", () => {
  test("each template projects deterministically and carries its own rows", () => {
    // Determinism first: the same inputs twice must be byte-identical, or every assertion below is
    // about one lucky run.
    for (const { rubric, fields } of TEMPLATES) {
      expect(project(rubric, fields)).toBe(project(rubric, fields));
    }

    const [primer, protocol, pattern] = TEMPLATES.map((t) => project(t.rubric, t.fields));

    expect(primer).toContain(">answered by<");
    expect(primer).toContain(">Winston (std architect)<");
    expect(protocol).toContain(">applies to<"); // the hyphenated key, labelled
    expect(protocol).toContain(">defined in<");
    expect(pattern).toContain(">project<");
    expect(pattern).toContain(">Tomé<");

    // Rows are per-template, so each one's keys stay out of the other two.
    expect(primer).not.toContain(">applies to<");
    expect(protocol).not.toContain(">answered by<");
    expect(pattern).not.toContain(">artifact<");
  });

  test("🔴 the three templates share ONE element skeleton — the rubric isolated from its data", () => {
    // This is FR-15 expressed as an assertion rather than as prose. RED when any template acquires a
    // shape the others do not have — which is the first move a second renderer makes.
    //
    // 🔴 THE SKELETON MUST BE TAKEN OVER A FIXED VALUE PROFILE, and that is a MEASUREMENT, not a
    // stylistic choice. An array-valued fence key renders `<ul>` with one `<li>` PER ELEMENT, so a raw
    // skeleton comparison over the real notes is confounded by how many tags each note happens to
    // carry — the protocol demo has 7 and the pattern demo 11, and the projections differ by four
    // `<li>` markers that say nothing whatever about the templates. Worse, that difference would make
    // the assertion RED on correct code, which is how a gate gets "simplified" away. So every rubric is
    // projected against ONE scalar value per key: the only thing varying is the rubric itself, which is
    // the only thing this test is about. Value-shape rendering is `core-html`'s contract and is tested
    // there.
    const scalar = (rubric: Rubric): FenceFields => {
      const fields: FenceFields = { [rubric.titleField]: "t" };
      for (const f of rubric.fields) fields[f.key] = "v";
      return fields;
    };
    const skeletons = TEMPLATES.map((t) => skeleton(project(t.rubric, scalar(t.rubric))));

    // The two five-row templates are structurally interchangeable — same shape, top to bottom.
    expect(skeletons[1]).toBe(skeletons[2]);

    // And the six-row one differs by EXACTLY one repeated row unit, never by a new kind of element.
    const rowUnit =
      '<div class="nk-field"><span class="nk-field-label"></span><span class="nk-field-value"></span></div>';
    expect(skeletons[0]!.replace(rowUnit, "")).toBe(skeletons[1]!);

    // Stated positively: the set of distinct tag+class markers is the same for all three. A per-type
    // element or a per-type class beyond the shared `nk-` set reddens here.
    // ⚠ THIS RUNS ON THE SCALAR PROFILE, like everything above it — it is NOT a claim about the real
    // notes. An earlier draft of this comment said it held "over the REAL notes too", which was
    // wishful: markers are computed from `skeletons`, and `skeletons` is scalar-only by construction.
    // Corrected rather than left, because a comment that overstates its assertion is how the next
    // reader concludes the gate covers something it never looked at.
    const markers = (s: string) => [...new Set(s.match(/<[a-z0-9]+(?: class="[^"]*")?/g) ?? [])].sort();
    expect(markers(skeletons[1]!)).toEqual(markers(skeletons[2]!));
    expect(markers(skeletons[0]!)).toEqual(markers(skeletons[1]!));

    // 🔴 AND THE SAME AGAIN OVER AN EQUAL-LENGTH ARRAY PROFILE, because the scalar profile is blind to
    // list markup entirely — no scalar ever emits `<ul>`/`<li>`, so a global change to how list values
    // render (`ul` → `ol`, a new wrapper, a per-type list class) passes everything above without a
    // murmur. Measured: with `listNode` returning `tag: "ol"`, the scalar-only version of this test
    // stayed 6 pass / 0 fail. Equal-length arrays are the point — UNEQUAL lengths are what made the
    // raw comparison red on correct code in the first place, so the fix is to hold cardinality fixed,
    // never to reintroduce the confound.
    const withList = (rubric: Rubric): FenceFields => {
      const fields: FenceFields = { [rubric.titleField]: "t" };
      rubric.fields.forEach((f, i) => {
        fields[f.key] = i === rubric.fields.length - 1 ? ["a", "b"] : "v";
      });
      return fields;
    };
    const listSkeletons = TEMPLATES.map((t) => skeleton(project(t.rubric, withList(t.rubric))));
    expect(listSkeletons[1]).toBe(listSkeletons[2]);
    expect(listSkeletons[0]!.replace(rowUnit, "")).toBe(listSkeletons[1]!);
    expect(markers(listSkeletons[0]!)).toEqual(markers(listSkeletons[1]!));
    // …and the list markup really is in the compared shape, so the assertions above are about it.
    expect(listSkeletons[1]).toContain('<ul class="nk-field-values"><li class="nk-field-value">');
  });

  test("a rubric key the fence lacks yields NO row — never the literal `undefined` (FR-5)", () => {
    for (const { rubric, fields } of TEMPLATES) {
      const dropped = rubric.fields[1]!.key;
      const thinned = { ...fields };
      delete (thinned as Record<string, unknown>)[dropped];

      const html = project(rubric, thinned);
      expect(html).not.toContain("undefined");
      expect(html).not.toContain(`>${rubric.fields[1]!.label ?? dropped}<`);

      // …and the card is one row shorter, so the key really did drop rather than render empty.
      const rows = (h: string) => (h.match(/class="nk-field"/g) ?? []).length;
      expect(rows(html)).toBe(rows(project(rubric, fields)) - 1);
    }
  });

  test("every emitted class is `nk-`-prefixed — zero `dk-`, zero `cn-` (AD-8 / NK-2)", () => {
    for (const { rubric, fields } of TEMPLATES) {
      const html = project(rubric, fields);
      for (const m of html.matchAll(/class="([^"]*)"/g)) {
        for (const cls of m[1]!.split(/\s+/).filter(Boolean)) {
          expect(cls.startsWith("nk-")).toBe(true);
        }
      }
    }
  });
});

describe("NFR5 — the capabilities catalog IS the registry, not a fork of it", () => {
  // ⚠ A HERMETIC FIXTURE REGISTRY, NEVER THE VAULT. A test that reads
  // `~/Documents/note-report/Scripts/notekit.config.ts` bakes a vault path into the repo — the D4
  // breach this whole story is built around avoiding. The fixture carries the same four note-type KEYS
  // the vault does, which is what ties the claim to this story's templates — but only their keys. All
  // four bind to one shared rubric here, deliberately: what NFR5 asserts is that the catalog is
  // GENERATED from the registry rather than forked from it, and one rubric proves that as well as four
  // would while keeping the fixture readable. Rubric FIELD parity with the vault is not in scope for
  // this assertion and is not claimed by it — see the file header.
  const FIXTURE = `import type { NotekitConfig } from ${JSON.stringify(join(REPO, "src", "notekit", "index.ts"))};

const card = { renderer: "nk-card", rubric: { kind: "card", titleField: "title",
  fields: [{ key: "summary" }] } } as const;

export const NOTEKIT_CONFIG = {
  noteTypes: { card: "catalog-card", primer: "catalog-primer", protocol: "catalog-protocol",
    pattern: "catalog-pattern" },
  templates: { "catalog-card": card, "catalog-primer": card, "catalog-protocol": card,
    "catalog-pattern": card },
} satisfies NotekitConfig;

export default NOTEKIT_CONFIG;
`;

  function capabilitiesFor(source: string): { noteTypes: Array<{ nkType: string }> } {
    const dir = mkdtempSync(join(tmpdir(), "nk-cap-"));
    try {
      const config = join(dir, "fixture.config.ts");
      writeFileSync(config, source);
      // A COLD SUBPROCESS through the repo's own entrypoint — never bare `std`, which resolves through
      // a global `bun link` into whatever tree was linked last.
      const proc = Bun.spawnSync({
        cmd: ["bun", CLI, "notekit", "capabilities", "--config", config, "--json"],
        cwd: REPO,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        timeout: CLI_TIMEOUT_MS,
      });
      expect(proc.exitCode).toBe(0);
      const envelope = JSON.parse(proc.stdout.toString());
      // ⚠ `error.code`, never `error.kind` — `Classified<C>` is `{code, message}`. NK-7 rule 2 says
      // `kind` and is wrong; first recorded by 2.3.
      expect(envelope.ok, JSON.stringify(envelope.error?.code ?? envelope.error)).toBe(true);
      return envelope.value;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("the registry's note-type keys and the catalog's `nkType` values are the SAME SET", () => {
    // ⚠ SETS, NOT LENGTHS. Equal counts with different members is exactly the drift this catches.
    const catalog = capabilitiesFor(FIXTURE);
    expect(new Set(catalog.noteTypes.map((t) => t.nkType))).toEqual(
      new Set(["card", "primer", "protocol", "pattern"]),
    );
  });

  test("COUNTERFACTUAL — drop a note type from the registry and the sets diverge", () => {
    // Without this the assertion above is a claim about one config file rather than about the
    // generator. Here the registry really loses `pattern`, and the catalog has to lose it too.
    const dropped = FIXTURE.replace(` pattern: "catalog-pattern"`, "");
    // ⚠ THE MUTATION IS ASSERTED, NOT ASSUMED. This `replace` depends on the fixture's exact
    // whitespace; a reformat above would make it a no-op. The counterfactual is fail-SAFE either way
    // (a no-op leaves four types and the set assertion goes red), but red for the wrong reason is a
    // half-hour of confusion later. This line names it immediately.
    expect(dropped).not.toBe(FIXTURE);
    const catalog = capabilitiesFor(dropped);
    const types = new Set(catalog.noteTypes.map((t) => t.nkType));

    expect(types).toEqual(new Set(["card", "primer", "protocol"]));
    expect(types).not.toEqual(new Set(["card", "primer", "protocol", "pattern"]));
  });
});
