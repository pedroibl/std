// gotchas-promoter — hermetic tests (Story 15.2, AC8).
//
// mkdtempSync fixture trees ONLY — never Pedro's real ~/.claude/skills. The headline invariant
// ("this tool never edits a skill") is proven HERE, by hashing the fixture skills tree before and
// after a full run: byte-identical. AC4's grep is only the tripwire; this is the proof.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import {
  type Bucket,
  type PromoterInput,
  type Report,
  buildReport,
  loadMap,
  main,
  readQueue,
  renderHuman,
} from "./gotchas-promoter";

// ── fixture helpers ──────────────────────────────────────────────────────────

const roots: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(path: string, body: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf-8");
  return path;
}

/** A well-formed queue candidate, shaped exactly like `queueCandidate` emits it. */
function candidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "correction: something",
    content: "## Correction\n\nAlways pass the tz explicitly.",
    domain: "Ideas",
    type: "idea",
    confidence: 0.9,
    provenance: {
      sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
      sourceLine: 412,
      timestamp: "2026-07-20T04:00:00.000Z",
      projectSlug: "-Users-pibl-Dev-personal-std",
    },
    ...over,
  };
}

function queueWith(files: Record<string, unknown | string>): string {
  const dir = tmp("gp-queue-");
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`, "utf-8");
  }
  return dir;
}

/** A fixture skills tree. `gotchas` picks the heading depth, or `null` for no Gotchas section. */
function skillsTree(spec: Record<string, string | null>): { root: string; paths: Record<string, string> } {
  const root = tmp("gp-skills-");
  const paths: Record<string, string> = {};
  for (const [name, heading] of Object.entries(spec)) {
    const body =
      heading === null
        ? `# ${name}\n\nA skill with no gotchas section.\n\n## Overview\n\nstuff\n`
        : `# ${name}\n\nIntro line.\n\n## Overview\n\nstuff\n\n${heading} Gotchas\n\n- an existing gotcha\n\n## After\n\ntail\n`;
    paths[name] = write(join(root, name, "SKILL.md"), body);
  }
  return { root, paths };
}

/** Recursive content hash of a directory tree — catches an edited file AND a vanished one. */
function treeHash(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        h.update(`D:${relative(root, full).split(sep).join("/")}\n`);
        walk(full);
      } else {
        h.update(`F:${relative(root, full).split(sep).join("/")}:${readFileSync(full, "utf-8")}\n`);
      }
    }
  };
  walk(root);
  return h.digest("hex");
}

function inputsFrom(dir: string): PromoterInput[] {
  return readQueue(dir);
}

function reader(): (p: string) => string | null {
  return (p: string) => {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return null;
    }
  };
}

function report(queueDir: string, map: Record<string, string>, min?: number): Report {
  return buildReport(inputsFrom(queueDir), map, { readArtifact: reader(), minConfidence: min ?? null });
}

const bucketOf = (r: Report): Bucket[] => r.verdicts.map((v) => v.bucket);

// ── AC8 case 1 — routed candidate: artifact + derived anchor line + full provenance ──

describe("AC8.1 routed candidate", () => {
  test("resolves the artifact, the Gotchas anchor as a LINE, and the full provenance tuple", () => {
    const { root, paths } = skillsTree({ MySkill: "##" });
    const q = queueWith({ "a.json": candidate() });
    const r = report(q, { "-Users-pibl-Dev-personal-std": paths.MySkill });

    expect(r.total).toBe(1);
    expect(r.counts.routed).toBe(1);
    const v = r.verdicts[0];
    expect(v.bucket).toBe("routed");
    expect(v.artifact).toBe(paths.MySkill);
    expect(v.heading).toBe("## Gotchas");

    // The anchor is a 1-based LINE, not findSection's character offset.
    const body = readFileSync(paths.MySkill, "utf-8");
    const expected = body.slice(0, body.indexOf("## Gotchas")).split("\n").length;
    expect(v.anchorLine).toBe(expected);
    expect(v.anchorLine).toBeGreaterThan(1);
    expect(v.anchorLine).toBeLessThan(body.split("\n").length);

    // Full provenance tuple — the human must be able to open the exact source line.
    expect(v.provenance).toEqual({
      sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
      sourceLine: 412,
      timestamp: "2026-07-20T04:00:00.000Z",
      projectSlug: "-Users-pibl-Dev-personal-std",
    });
    expect(v.confidence).toBe(0.9);
    expect(v.content).toContain("Always pass the tz explicitly.");

    // …and the human render carries all of it (no `undefined` leaking through).
    const md = renderHuman(r);
    expect(md).toContain(`${paths.MySkill}:${v.anchorLine}`);
    expect(md).toContain("abcdef12-3456-7890-abcd-ef1234567890");
    expect(md).toContain("412");
    expect(md).not.toContain("undefined");
    expect(root).toBeTruthy();
  });
});

// ── AC8.2 — unmatched slug → `unrouted`, counted, reported, exit 0 ────────────

describe("AC8.2 unmatched slug", () => {
  test("lands in `unrouted`, is counted and reported — never dropped", () => {
    const q = queueWith({ "a.json": candidate({ provenance: { ...(candidate().provenance as object), projectSlug: "-Users-pibl-nowhere" } }) });
    const r = report(q, { "-Users-pibl-Dev-personal-std": "/nope/SKILL.md" });

    expect(r.counts.unrouted).toBe(1);
    expect(r.counts.routed).toBe(0);
    expect(r.verdicts[0].slug).toBe("-Users-pibl-nowhere");
    expect(renderHuman(r)).toContain("-Users-pibl-nowhere");
  });

  test("exit 0 through the CLI even with unrouted candidates", () => {
    const q = queueWith({ "a.json": candidate() });
    const mapFile = join(tmp("gp-map-"), "map.json");
    writeFileSync(mapFile, JSON.stringify({}), "utf-8");
    expect(main(["--queue", q, "--map", mapFile, "--json"])).toBe(0);
  });
});

// ── AC8.3 — routed artifact with NO Gotchas section (the 9/57 case) ───────────

describe("AC8.3 no-target-section", () => {
  test("a routed artifact lacking a Gotchas heading reports `no-target-section`, never crashes", () => {
    const { paths } = skillsTree({ Bare: null });
    const q = queueWith({ "a.json": candidate() });
    const r = report(q, { "-Users-pibl-Dev-personal-std": paths.Bare });

    expect(r.counts["no-target-section"]).toBe(1);
    expect(r.verdicts[0].artifact).toBe(paths.Bare);
    expect(r.verdicts[0].anchorLine).toBeUndefined();
  });

  test("a missing artifact FILE also reports `no-target-section`, never crashes", () => {
    const q = queueWith({ "a.json": candidate() });
    const r = report(q, { "-Users-pibl-Dev-personal-std": "/definitely/not/here/SKILL.md" });
    expect(r.counts["no-target-section"]).toBe(1);
  });
});

// ── AC8.4 — a `### Gotchas` artifact must NOT false-negative ──────────────────

describe("AC8.4 heading-depth probe", () => {
  test("`### Gotchas` resolves and records the matched depth", () => {
    const { paths } = skillsTree({ Deep: "###" });
    const q = queueWith({ "a.json": candidate() });
    const r = report(q, { "-Users-pibl-Dev-personal-std": paths.Deep });

    expect(r.counts.routed).toBe(1);
    expect(r.counts["no-target-section"]).toBe(0);
    expect(r.verdicts[0].heading).toBe("### Gotchas");
  });

  test("`# Gotchas` resolves too", () => {
    const { paths } = skillsTree({ Top: "#" });
    const q = queueWith({ "a.json": candidate() });
    const r = report(q, { "-Users-pibl-Dev-personal-std": paths.Top });
    expect(r.verdicts[0].heading).toBe("# Gotchas");
    expect(r.counts.routed).toBe(1);
  });
});

// ── AC8.5 — the three-way prefix collision (AC2: EXACT match) ─────────────────

describe("AC8.5 prefix collision — all three arms", () => {
  const SLUGS = {
    std: "-Users-pibl-Dev-personal-std",
    pub: "-Users-pibl-Dev-personal-std-public",
    bmad: "-Users-pibl-Dev-personal-std--bmad-output",
  };

  test("each of the three prefixed slugs routes to its OWN artifact and no other", () => {
    const { paths } = skillsTree({ Std: "##", Pub: "##", Bmad: "##" });
    const map = { [SLUGS.std]: paths.Std, [SLUGS.pub]: paths.Pub, [SLUGS.bmad]: paths.Bmad };

    const q = queueWith({
      "1.json": candidate({ provenance: { ...(candidate().provenance as object), projectSlug: SLUGS.std } }),
      "2.json": candidate({ provenance: { ...(candidate().provenance as object), projectSlug: SLUGS.pub } }),
      "3.json": candidate({ provenance: { ...(candidate().provenance as object), projectSlug: SLUGS.bmad } }),
    });
    const r = report(q, map);
    expect(r.counts.routed).toBe(3);

    const bySlug = new Map(r.verdicts.map((v) => [v.slug, v.artifact]));
    expect(bySlug.get(SLUGS.std)).toBe(paths.Std);
    expect(bySlug.get(SLUGS.pub)).toBe(paths.Pub);
    expect(bySlug.get(SLUGS.bmad)).toBe(paths.Bmad);
  });

  test("the shortest slug does NOT route to a longer sibling when only the siblings are mapped", () => {
    const { paths } = skillsTree({ Pub: "##", Bmad: "##" });
    const q = queueWith({ "1.json": candidate({ provenance: { ...(candidate().provenance as object), projectSlug: SLUGS.std } }) });
    const r = report(q, { [SLUGS.pub]: paths.Pub, [SLUGS.bmad]: paths.Bmad });
    expect(r.counts.unrouted).toBe(1);
    expect(r.counts.routed).toBe(0);
  });

  test("a longer slug does NOT route to its shorter prefix (the reverse arm)", () => {
    const { paths } = skillsTree({ Std: "##" });
    const q = queueWith({
      "1.json": candidate({ provenance: { ...(candidate().provenance as object), projectSlug: SLUGS.pub } }),
      "2.json": candidate({ provenance: { ...(candidate().provenance as object), projectSlug: SLUGS.bmad } }),
    });
    const r = report(q, { [SLUGS.std]: paths.Std });
    expect(r.counts.unrouted).toBe(2);
    expect(r.counts.routed).toBe(0);
  });
});

// ── AC8.6 — runs degraded: missing / empty queue dir ──────────────────────────

describe("AC8.6 runs degraded", () => {
  test("a MISSING queue dir yields 0 candidates and exit 0", () => {
    const missing = join(tmp("gp-none-"), "not-created");
    expect(readQueue(missing)).toEqual([]);
    const r = report(missing, {});
    expect(r.total).toBe(0);
    expect(renderHuman(r)).toContain("0 candidates");
    expect(main(["--queue", missing, "--map", join(missing, "map.json")])).toBe(0);
  });

  test("an EMPTY queue dir yields 0 candidates and exit 0", () => {
    const empty = queueWith({});
    const r = report(empty, {});
    expect(r.total).toBe(0);
    expect(main(["--queue", empty, "--map", join(empty, "map.json")])).toBe(0);
  });
});

// ── AC8.7 — malformed: unparseable AND parseable-but-wrong-shape ─────────────

describe("AC8.7 malformed candidates", () => {
  test("unparseable JSON → `malformed`, reported, never a crash", () => {
    const q = queueWith({ "bad.json": "{ this is not json" });
    const r = report(q, {});
    expect(r.counts.malformed).toBe(1);
    expect(r.verdicts[0].reason).toBe("unparseable");
    expect(renderHuman(r)).toContain("malformed");
  });

  test("parseable-but-wrong-shape ({} / [] / \"x\") → `malformed` via the RUNTIME guard", () => {
    const q = queueWith({ "a.json": {}, "b.json": [], "c.json": '"x"\n' });
    const r = report(q, {});
    expect(r.total).toBe(3);
    expect(r.counts.malformed).toBe(3);
    expect(r.verdicts.every((v) => v.reason === "bad-shape")).toBe(true);
  });

  test("a partial provenance (routing key only) is ALSO `malformed` — no `undefined` in the report", () => {
    const q = queueWith({ "a.json": { provenance: { projectSlug: "-Users-pibl-Dev-personal-std" }, confidence: 0.9, content: "x" } });
    const r = report(q, { "-Users-pibl-Dev-personal-std": "/x/SKILL.md" });
    expect(r.counts.malformed).toBe(1);
    expect(renderHuman(r)).not.toContain("undefined");
  });

  test("a vanished/unreadable queue file folds into `malformed` with reason `missing` — no sixth bucket", () => {
    const r = buildReport([{ file: "/gone/x.json", raw: null }], {}, { readArtifact: reader(), minConfidence: null });
    expect(r.counts.malformed).toBe(1);
    expect(r.verdicts[0].reason).toBe("missing");
    expect(Object.keys(r.counts).sort()).toEqual(["filtered", "malformed", "no-target-section", "routed", "unrouted"]);
  });
});

// ── AC8.8 — the `filtered` bucket is actually exercised ──────────────────────

describe("AC8.8 --min-confidence", () => {
  test("a sub-threshold candidate is `filtered` and REPORTED, not dropped", () => {
    const { paths } = skillsTree({ MySkill: "##" });
    const q = queueWith({
      "low.json": candidate({ confidence: 0.3 }),
      "high.json": candidate({ confidence: 0.9 }),
    });
    const r = report(q, { "-Users-pibl-Dev-personal-std": paths.MySkill }, 0.5);

    expect(r.counts.filtered).toBe(1);
    expect(r.counts.routed).toBe(1);
    expect(r.minConfidence).toBe(0.5);
    const md = renderHuman(r);
    expect(md).toContain("filtered");
    expect(md).toContain("0.5");
  });

  test("the filter is OFF by default — nothing is filtered without the flag", () => {
    const { paths } = skillsTree({ MySkill: "##" });
    const q = queueWith({ "low.json": candidate({ confidence: 0.3 }) });
    const r = report(q, { "-Users-pibl-Dev-personal-std": paths.MySkill });
    expect(r.minConfidence).toBeNull();
    expect(r.counts.filtered).toBe(0);
    expect(r.counts.routed).toBe(1);
  });
});

// ── AC8.9 — bucket precedence: malformed → filtered → unrouted → no-target → routed ──

describe("AC8.9 bucket precedence", () => {
  test("unmatched-slug AND sub-threshold lands in `filtered`, not `unrouted`", () => {
    const q = queueWith({ "a.json": candidate({ confidence: 0.2, provenance: { ...(candidate().provenance as object), projectSlug: "-nowhere" } }) });
    const r = report(q, {}, 0.5);
    expect(bucketOf(r)).toEqual(["filtered"]);
    expect(r.counts.unrouted).toBe(0);
  });

  test("the known cost is DISCLOSED — an absorbed unmatched slug carries the `unroutedCoTag`", () => {
    const q = queueWith({ "a.json": candidate({ confidence: 0.2, provenance: { ...(candidate().provenance as object), projectSlug: "-nowhere" } }) });
    const r = report(q, {}, 0.5);
    expect(r.verdicts[0].unroutedCoTag).toBe(true);
    expect(r.unroutedCoTagged).toBe(1);
    // The caveat must be visible wherever the unrouted rate is printed.
    expect(renderHuman(r)).toContain("co-tagged");
  });

  test("malformed wins over filtered — an unvalidated shape has no readable confidence", () => {
    const q = queueWith({ "a.json": { confidence: "not-a-number", content: "x", provenance: { projectSlug: "s", sessionId: "s", sourceLine: 1, timestamp: "t" } } });
    const r = report(q, {}, 0.5);
    expect(bucketOf(r)).toEqual(["malformed"]);
  });
});

// ── AC8.10 — the five buckets sum to the queue file count ────────────────────

describe("AC8.10 nothing is dropped", () => {
  test("the five terminal buckets sum to the queue file count", () => {
    const { paths } = skillsTree({ MySkill: "##", Bare: null });
    const q = queueWith({
      "routed.json": candidate({ confidence: 0.9 }),
      "notarget.json": candidate({ confidence: 0.9, provenance: { ...(candidate().provenance as object), projectSlug: "-bare" } }),
      "unrouted.json": candidate({ confidence: 0.9, provenance: { ...(candidate().provenance as object), projectSlug: "-nowhere" } }),
      "filtered.json": candidate({ confidence: 0.1 }),
      "bad.json": "{{{",
      "shape.json": {},
    });
    const r = report(q, { "-Users-pibl-Dev-personal-std": paths.MySkill, "-bare": paths.Bare }, 0.5);

    const fileCount = readdirSync(q).length;
    expect(fileCount).toBe(6);
    expect(r.total).toBe(fileCount);
    const sum = Object.values(r.counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(fileCount);
    expect(r.counts).toEqual({ malformed: 2, filtered: 1, unrouted: 1, "no-target-section": 1, routed: 1 });
    expect(renderHuman(r)).toContain(`${fileCount}`);
  });
});

// ── AC8.11 — THE INVARIANT'S REAL PROOF: the fixture skills tree is byte-identical ──

describe("AC8.11 THE INVARIANT — the skills tree is never touched", () => {
  test("a full CLI run leaves the fixture skills tree byte-identical (no edit, no deletion)", () => {
    const { root, paths } = skillsTree({ MySkill: "##", Deep: "###", Bare: null });
    const q = queueWith({
      "1.json": candidate(),
      "2.json": candidate({ provenance: { ...(candidate().provenance as object), projectSlug: "-deep" } }),
      "3.json": candidate({ provenance: { ...(candidate().provenance as object), projectSlug: "-bare" } }),
      "4.json": candidate({ provenance: { ...(candidate().provenance as object), projectSlug: "-nowhere" } }),
      "5.json": "{ not json",
    });
    const mapDir = tmp("gp-map-");
    const mapFile = join(mapDir, "map.json");
    writeFileSync(
      mapFile,
      JSON.stringify({ "-Users-pibl-Dev-personal-std": paths.MySkill, "-deep": paths.Deep, "-bare": paths.Bare }),
      "utf-8",
    );

    const before = treeHash(root);
    const code = main(["--queue", q, "--map", mapFile, "--json"]);
    const after = treeHash(root);

    expect(code).toBe(0);
    expect(after).toBe(before); // byte-identical: nothing edited, nothing deleted
    // …and the same holds for the human path and under --strict.
    main(["--queue", q, "--map", mapFile]);
    main(["--queue", q, "--map", mapFile, "--strict"]);
    expect(treeHash(root)).toBe(before);
  });

  test("--strict is the ONLY non-zero exit (AC5: candidates are information, not failure)", () => {
    const { paths } = skillsTree({ MySkill: "##" });
    const mapFile = join(tmp("gp-map-"), "map.json");
    writeFileSync(mapFile, JSON.stringify({ "-Users-pibl-Dev-personal-std": paths.MySkill }), "utf-8");
    const q = queueWith({ "1.json": candidate() });

    expect(main(["--queue", q, "--map", mapFile, "--json"])).toBe(0);
    expect(main(["--queue", q, "--map", mapFile, "--strict", "--json"])).toBe(1);

    const empty = queueWith({});
    expect(main(["--queue", empty, "--map", mapFile, "--strict", "--json"])).toBe(0);
  });
});

// ── map loading (AC2: injected DATA, honest about a missing/broken map) ──────

describe("map loading", () => {
  test("a missing map file yields an empty map + `present:false` — everything reports `unrouted`", () => {
    const { map, present } = loadMap(join(tmp("gp-map-"), "absent.json"));
    expect(present).toBe(false);
    expect(map).toEqual({});
  });

  test("an unparseable map file throws (fail-loud) rather than silently routing nothing", () => {
    const f = join(tmp("gp-map-"), "broken.json");
    writeFileSync(f, "{ nope", "utf-8");
    expect(() => loadMap(f)).toThrow(/map/i);
  });

  test("a map with a non-string value throws rather than routing to `undefined`", () => {
    const f = join(tmp("gp-map-"), "wrong.json");
    writeFileSync(f, JSON.stringify({ "-a": 3 }), "utf-8");
    expect(() => loadMap(f)).toThrow(/map/i);
  });

  test("the CLI surfaces a broken map as a non-zero exit, not a silent empty run", () => {
    const f = join(tmp("gp-map-"), "broken2.json");
    writeFileSync(f, "{ nope", "utf-8");
    const q = queueWith({ "1.json": candidate() });
    expect(main(["--queue", q, "--map", f, "--json"])).toBe(2);
  });
});

// ── queue discovery ──────────────────────────────────────────────────────────

describe("readQueue", () => {
  test("reads only .json files and returns their raw contents", () => {
    const q = queueWith({ "a.json": candidate(), "notes.md": "ignore me" });
    const inputs = readQueue(q);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].file.endsWith("a.json")).toBe(true);
    expect(inputs[0].raw).toContain("provenance");
  });

  test("results are stable-sorted by path so the report order is deterministic", () => {
    const q = queueWith({ "c.json": candidate(), "a.json": candidate(), "b.json": candidate() });
    expect(readQueue(q).map((i) => i.file.split(sep).pop())).toEqual(["a.json", "b.json", "c.json"]);
  });
});

// ── render (AC5 + §Noise: confidence visible, worst LAST) ────────────────────

describe("renderHuman", () => {
  test("groups by artifact and sorts routed candidates worst-LAST so noise stays visible", () => {
    const { paths } = skillsTree({ MySkill: "##" });
    const q = queueWith({
      "low.json": candidate({ confidence: 0.3, content: "LOWSIGNAL" }),
      "high.json": candidate({ confidence: 0.95, content: "HIGHSIGNAL" }),
    });
    const md = renderHuman(report(q, { "-Users-pibl-Dev-personal-std": paths.MySkill }));
    expect(md.indexOf("HIGHSIGNAL")).toBeLessThan(md.indexOf("LOWSIGNAL"));
    expect(md).toContain("95%");
    expect(md).toContain("30%");
  });
});
