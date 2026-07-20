// adr-generator — hermetic tests (Story 15.4, AC7).
//
// mkdtempSync fixture trees ONLY — never Pedro's real ~/.claude/projects and never the real
// hand-written docs/DECISIONS.md. The two headline guards are here, not as niceties:
//   • THE OFF-BY-ONE — a fixture whose line N is distinguishable from N±1, asserted by content.
//     The cursor is 1-based; an off-by-one silently cites the wrong line, which is the single
//     failure this story exists to prevent.
//   • NEVER CLOBBERS A HUMAN ADR — a fixture DECISIONS.md is hashed before and after a full run
//     and asserted byte-identical. A name-grep can never prove absence of mutation; a hash can.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AdrInput,
  type BuildDeps,
  type Bucket,
  PRECEDENCE,
  buildReport,
  buildTranscriptIndex,
  composeAdr,
  existingMarkers,
  flagArg,
  highestAdrNumber,
  isCandidate,
  isDecisionShaped,
  lineText,
  main,
  markerFor,
  hasProducerShape,
  recomposeContent,
  readQueue,
  readWindow,
  renderAdr,
  renderHuman,
  resolveHome,
  unknownFlags,
} from "./adr-generator";

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

const SESSION = "abcdef12-3456-7890-abcd-ef1234567890";

/** One JSONL transcript line carrying `text` as an assistant message. */
function msg(text: string, type = "assistant"): string {
  return JSON.stringify({ type, timestamp: "2026-07-20T04:00:00.000Z", message: { role: type, content: text } });
}

/** A transcript whose line N reads "LINE-N …" so an off-by-one is visible in the assertion. */
function numberedTranscript(count: number): string {
  const out: string[] = [];
  for (let i = 1; i <= count; i++) out.push(msg(`LINE-${i} this is the distinguishable text of line ${i}.`));
  return `${out.join("\n")}\n`;
}

/** The exact text `numberedTranscript` puts on line n — what the producer would have sliced. */
function textOfLine(n: number): string {
  return `LINE-${n} this is the distinguishable text of line ${n}.`;
}

/** A well-formed queue candidate, shaped exactly like the producer's `queueCandidate` emits it. */
function candidate(over: Record<string, any> = {}): Record<string, any> {
  const prov = {
    sessionId: SESSION,
    sourceLine: 5,
    timestamp: "2026-07-20T04:00:00.000Z",
    projectSlug: "-Users-pibl-Dev-personal-std",
    ...(over.provenance || {}),
  };
  const mined = over.mined ?? textOfLine(prov.sourceLine);
  const memoryType = over.memoryType ?? "decision";
  const body = {
    title: `${memoryType}: ${mined.slice(0, 60)}...`,
    // The producer's composed shape: `## <Type>\n\n<content>\n\n## Context\n\n<context>`.
    content: `## ${memoryType[0].toUpperCase()}${memoryType.slice(1)}\n\n${mined}\n\n## Context\n\n${mined}`,
    domain: "Ideas",
    type: "idea",
    tags: [memoryType, "mined", "project:-Users-pibl-Dev-personal-std"],
    confidence: 0.6,
    sourcePattern: "decided",
    project: prov.projectSlug,
    sourcePath: prov.sessionId,
    minedAt: "2026-07-20T04:00:00.000Z",
  };
  delete over.mined;
  delete over.memoryType;
  return { ...body, ...over, provenance: prov };
}

function queueWith(files: Record<string, unknown | string>): string {
  const dir = tmp("adr-queue-");
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`, "utf-8");
  }
  return dir;
}

/** A projects tree: `relPath` (under the root) → raw transcript text. */
function projectsWith(files: Record<string, string>): string {
  const root = tmp("adr-projects-");
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body, "utf-8");
  }
  return root;
}

function inputsFrom(objs: unknown[]): AdrInput[] {
  return objs.map((o, i) => ({ file: `/q/c${i}.json`, raw: typeof o === "string" ? o : JSON.stringify(o) }));
}

function deps(over: Partial<BuildDeps> = {}): BuildDeps {
  return {
    existing: "",
    readTranscript: () => numberedTranscript(20),
    radius: 3,
    ...over,
  };
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sumOf(counts: Record<Bucket, number>): number {
  return PRECEDENCE.reduce((n, b) => n + counts[b], 0);
}

// ── pure vocabulary ──────────────────────────────────────────────────────────

describe("shape guard + selection", () => {
  test("isCandidate accepts the producer's real shape and rejects wrong shapes", () => {
    expect(isCandidate(candidate())).toBe(true);
    for (const bad of [{}, [], "x", 3, null, undefined, { provenance: { sessionId: "s" } }]) {
      expect(isCandidate(bad)).toBe(false);
    }
    // partial provenance must fail — a half-guard emits "line undefined"
    expect(isCandidate(candidate({ provenance: { sourceLine: 0 } }))).toBe(false);
    expect(isCandidate(candidate({ tags: ["decision", 7] }))).toBe(false);
  });

  test("decision-shaped is read by tag MEMBERSHIP, not position", () => {
    expect(isDecisionShaped(candidate() as any)).toBe(true);
    expect(isDecisionShaped(candidate({ tags: ["mined", "skill:X", "decision"] }) as any)).toBe(true);
    expect(isDecisionShaped(candidate({ memoryType: "preference" }) as any)).toBe(false);
  });

  test("hasProducerShape is a SHAPE PROBE and recomposeContent rebuilds the producer's output exactly", () => {
    expect(hasProducerShape(candidate().content)).toBe(true);
    expect(hasProducerShape("no producer shape here")).toBe(false);
    expect(recomposeContent(textOfLine(5), "decision")).toBe(candidate().content);
  });

  test("recomposeContent applies the producer's 500/300 truncation", () => {
    const long = "z".repeat(900);
    expect(recomposeContent(long, "decision")).toBe(`## Decision\n\n${"z".repeat(500)}\n\n## Context\n\n${"z".repeat(300)}`);
  });

  test("markerFor is the cursor and is prefix-collision-safe", () => {
    expect(markerFor({ sessionId: "s", sourceLine: 42 } as any)).toBe("<!-- adr-src: s:42 -->");
    const doc = `x ${markerFor({ sessionId: "s", sourceLine: 42 } as any)} y`;
    expect(doc.includes(markerFor({ sessionId: "s", sourceLine: 4 } as any))).toBe(false);
    expect(existingMarkers(doc).has("<!-- adr-src: s:42 -->")).toBe(true);
  });

  test("highestAdrNumber matches the real prior-art heading form and never invents one", () => {
    expect(highestAdrNumber("")).toBe(0);
    expect(highestAdrNumber("## ADR-0001 — a\n\n## ADR-0012 — b\n")).toBe(12);
    expect(highestAdrNumber("### ADR-0099 — not a top-level heading\n")).toBe(0);
  });

  test("REGRESSION (review MAJOR 3): numbers past 9999 are SEEN, so they can never be reused", () => {
    // `\d{4}` reported 9999 here and the next run re-allocated 10000 → duplicate headings.
    expect(highestAdrNumber("## ADR-9999 — a\n## ADR-10000 — b\n")).toBe(10000);
    expect(highestAdrNumber("## ADR-123456 — big\n")).toBe(123456);
  });

  test("REGRESSION (review MINOR 3): a fenced example heading does not burn numbers", () => {
    const doc = "# Doc\n\n```\n## ADR-0042 — example in a code fence\n```\n\n## ADR-0002 — the real one\n";
    expect(highestAdrNumber(doc)).toBe(2);
  });

  test("lineText mirrors the producer's extractor and never throws", () => {
    expect(lineText(msg("hello"))).toBe("hello");
    expect(lineText(JSON.stringify({ message: { content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }] } }))).toBe("a\nb");
    expect(lineText("{not json")).toBe("");
    expect(lineText("")).toBe("");
    expect(lineText(JSON.stringify({ message: {} }))).toBe("");
  });
});

// ── THE HEADLINE GUARD #1: the 1-based cursor lands on the RIGHT line ─────────

describe("cursor dereference (the off-by-one guard)", () => {
  test("readWindow resolves sourceLine 1-based — line N, not N-1 or N+1", () => {
    const raw = numberedTranscript(20);
    const w = readWindow(raw, 7, 2)!;
    expect(w.line).toBe(textOfLine(7));
    expect(w.line).not.toBe(textOfLine(6));
    expect(w.line).not.toBe(textOfLine(8));
    expect(w.before).toEqual([textOfLine(5), textOfLine(6)]);
    expect(w.after).toEqual([textOfLine(8), textOfLine(9)]);
  });

  test("the first line is reachable (sourceLine 1) and clamps its window", () => {
    const w = readWindow(numberedTranscript(5), 1, 3)!;
    expect(w.line).toBe(textOfLine(1));
    expect(w.before).toEqual([]);
  });

  test("the window is measured in PROSE MESSAGES and scans past tool-only lines", () => {
    // The defect the first live dry-run exposed: real transcripts are mostly tool_use/tool_result
    // records, which yield no text. A raw-line window reported an EMPTY Context on 4 of 5 real ADRs
    // while every all-prose fixture passed.
    const tool = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } });
    const raw = [msg(textOfLine(1)), tool, tool, tool, msg(textOfLine(5)), tool, tool, msg(textOfLine(8))].join("\n");
    const w = readWindow(raw, 5, 2)!;
    expect(w.line).toBe(textOfLine(5));
    expect(w.before).toEqual([textOfLine(1)]);
    expect(w.after).toEqual([textOfLine(8)]);
  });

  test("the outward scan is BOUNDED — a cursor in a long tool-only stretch never scans the file", () => {
    const tool = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } });
    // radius 1 → scan bound 25; the only prose sits 60 lines away and must NOT be reached
    const raw = [msg(textOfLine(1)), ...Array(60).fill(tool), msg(textOfLine(62))].join("\n");
    const w = readWindow(raw, 62, 1)!;
    expect(w.line).toBe(textOfLine(62));
    expect(w.before).toEqual([]);
  });

  test("past EOF and non-positive lines return null rather than throwing", () => {
    expect(readWindow(numberedTranscript(5), 99, 3)).toBeNull();
    expect(readWindow(numberedTranscript(5), 0, 3)).toBeNull();
  });

  test("the emitted ADR quotes line N — asserted by content, end to end", () => {
    const report = buildReport(inputsFrom([candidate({ provenance: { sourceLine: 9 } })]), deps());
    expect(report.counts.emitted).toBe(1);
    const adr = report.verdicts[0].adr!;
    expect(adr.decision).toContain("LINE-9");
    expect(adr.decision).not.toContain("LINE-8");
    expect(adr.decision).not.toContain("LINE-10");
    // the Context/Consequences come from the transcript WINDOW, never from the truncated candidate
    expect(adr.context).toContain("LINE-6");
    expect(adr.consequences).toContain("LINE-10");
  });
});

// ── THE SUBAGENT-TIER GUARD (~15% of the live population) ────────────────────

describe("subagent tier — a path-join resolver fails this, an exact-basename walk does not", () => {
  test("resolves a depth-3 subagent transcript whose projectSlug is the literal 'subagents'", () => {
    const projects = projectsWith({
      "-Users-pibl-Dev-personal-std/f1e2d3c4-0000-0000-0000-000000000000/subagents/agent-awrite-your-last-2ed55d37.jsonl":
        numberedTranscript(12),
      "-Users-pibl-Dev-personal-std/normal-session.jsonl": numberedTranscript(3),
    });
    const index = buildTranscriptIndex(projects);
    // the subagent sessionId is NOT a UUID and its slug is unusable as a path component
    expect(index.byId.get("agent-awrite-your-last-2ed55d37")).toContain("/subagents/");

    const report = buildReport(
      inputsFrom([
        candidate({
          provenance: { sessionId: "agent-awrite-your-last-2ed55d37", sourceLine: 4, projectSlug: "subagents" },
          mined: textOfLine(4),
        }),
      ]),
      deps({
        readTranscript: (id) => {
          const p = index.byId.get(id);
          return p ? readFileSync(p, "utf-8") : null;
        },
      }),
    );
    expect(report.counts.emitted).toBe(1);
    expect(report.counts.stale).toBe(0); // a path-join resolver reports stale here — that is the point
    expect(report.verdicts[0].adr!.decision).toContain("LINE-4");
  });

  test("the index predicate ignores non-.jsonl files that would otherwise claim the key", () => {
    const projects = projectsWith({
      "p/real-session.jsonl": numberedTranscript(2),
      "p/decoy/real-session": "impostor with no extension\n",
    });
    const index = buildTranscriptIndex(projects);
    expect(index.byId.get("real-session")).toBe(join(projects, "p/real-session.jsonl"));
  });

  test("basenames resolve by EXACT equality, never substring (the producer's idiom collides here)", () => {
    const projects = projectsWith({
      "p/agent-alpha-beta.jsonl": numberedTranscript(2),
      "p/agent-alpha.jsonl": numberedTranscript(2),
    });
    const index = buildTranscriptIndex(projects);
    expect(index.byId.get("agent-alpha")).toBe(join(projects, "p/agent-alpha.jsonl"));
    expect(index.byId.get("agent-alpha-beta")).toBe(join(projects, "p/agent-alpha-beta.jsonl"));
  });
});

// ── buckets ──────────────────────────────────────────────────────────────────

describe("terminal buckets — every candidate lands in exactly one, and they sum", () => {
  test("a non-decision candidate is `skipped`, counted, never emitted", () => {
    const report = buildReport(inputsFrom([candidate({ memoryType: "preference" })]), deps());
    expect(report.counts.skipped).toBe(1);
    expect(report.counts.emitted).toBe(0);
    expect(report.verdicts[0].reason).toContain("not decision-shaped");
  });

  test("a missing transcript is a reported `stale`, not a crash", () => {
    const report = buildReport(inputsFrom([candidate()]), deps({ readTranscript: () => null }));
    expect(report.counts.stale).toBe(1);
    expect(report.verdicts[0].reason).toContain("transcript not found");
  });

  test("a line past EOF is a reported `stale`", () => {
    const report = buildReport(inputsFrom([candidate({ provenance: { sourceLine: 999 } })]), deps());
    expect(report.counts.stale).toBe(1);
    expect(report.verdicts[0].reason).toContain("past EOF");
  });

  test("quoted text drifted at the cited line is `stale` — verify-against-live", () => {
    // the cursor still resolves, but the transcript now says something else at that line
    const report = buildReport(
      inputsFrom([candidate({ provenance: { sourceLine: 5 }, mined: "a decision that USED to be on line 5." })]),
      deps(),
    );
    expect(report.counts.stale).toBe(1);
    expect(report.verdicts[0].reason).toContain("no longer matches");
  });

  test("REGRESSION (review MAJOR 1): a mined body containing the producer's OWN delimiter cannot fail open", () => {
    // The prefix check recovered a 17-char excerpt from this body and then PASSED against a line
    // that had drifted past it — emitting an ADR citing text that was no longer there.
    const minedBody = "I decided we need\n\n## Context\n\nmore details about the old architecture decision.";
    const drifted = "I decided we need a totally different approach that is not the original ADR at all.";
    const c = candidate({ provenance: { sourceLine: 2 }, mined: minedBody });
    const raw = [msg("padding line one here"), msg(drifted), msg("padding line three here")].join("\n");
    const report = buildReport(inputsFrom([c]), deps({ readTranscript: () => raw }));
    expect(report.counts.emitted).toBe(0);
    expect(report.counts.stale).toBe(1);
    expect(report.verdicts[0].reason).toContain("no longer matches");

    // …and the SAME body still verifies cleanly when the line genuinely has not drifted
    const intact = [msg("padding line one here"), msg(minedBody), msg("padding line three here")].join("\n");
    const ok = buildReport(inputsFrom([c]), deps({ readTranscript: () => intact }));
    expect(ok.counts.emitted).toBe(1);
  });

  test("REGRESSION (review MAJOR 2): an AMBIGUOUS basename is stale, never a confident wrong file", () => {
    // Two transcripts sharing a basename whose lines share the producer's <=500-char prefix: a
    // last-wins Map emitted an ADR composed from the WRONG session with nothing looking broken.
    const shared = "We decided the shared prefix text that both sessions begin with here.";
    const projects = projectsWith({
      [`projA/${SESSION}.jsonl`]: `${msg(`${shared} DETAILS ONLY IN A`)}\n`,
      [`projB/${SESSION}.jsonl`]: `${msg(`${shared} DETAILS ONLY IN B`)}\n`,
    });
    const index = buildTranscriptIndex(projects);
    expect(index.byId.has(SESSION)).toBe(false); // NOT last-wins
    expect(index.ambiguous.get(SESSION)!.length).toBe(2);

    const report = buildReport(inputsFrom([candidate({ provenance: { sourceLine: 1 }, mined: shared })]), {
      existing: "",
      radius: 3,
      readTranscript: (id) => {
        const p = index.byId.get(id);
        return p ? readFileSync(p, "utf-8") : null;
      },
      resolveError: (id) => {
        const c = index.ambiguous.get(id);
        return c ? `AMBIGUOUS session id — ${c.length} transcripts share this basename: ${c.join(", ")}` : null;
      },
    });
    expect(report.counts.emitted).toBe(0);
    expect(report.counts.stale).toBe(1);
    expect(report.verdicts[0].reason).toContain("AMBIGUOUS");
    expect(report.verdicts[0].reason).toContain("projA");
    expect(report.verdicts[0].reason).toContain("projB");
  });

  test("a candidate whose content is not in the producer's shape is `stale`, not silently trusted", () => {
    const report = buildReport(inputsFrom([candidate({ content: "freeform, no ## Context section" })]), deps());
    expect(report.counts.stale).toBe(1);
    expect(report.verdicts[0].reason).toContain("nothing to verify against");
  });

  test("unparseable JSON and parseable-but-wrong-shape are both `malformed`, no crash", () => {
    const report = buildReport(
      [
        { file: "/q/a.json", raw: "{not json" },
        { file: "/q/b.json", raw: "{}" },
        { file: "/q/c.json", raw: "[]" },
        { file: "/q/d.json", raw: '"x"' },
        { file: "/q/e.json", raw: null }, // vanished between walk and read
      ],
      deps(),
    );
    expect(report.counts.malformed).toBe(5);
    expect(report.verdicts.map((v) => v.reason)).toEqual([
      "unparseable",
      "bad-shape",
      "bad-shape",
      "bad-shape",
      "missing",
    ]);
  });

  test("a cursor already present in the out-file is `duplicate`, not re-emitted", () => {
    const c = candidate();
    const existing = `## ADR-0001 — prior\n${markerFor(c.provenance as any)}\n**Status:** Open\n`;
    const report = buildReport(inputsFrom([c]), deps({ existing }));
    expect(report.counts.duplicate).toBe(1);
    expect(report.counts.emitted).toBe(0);
  });

  test("`duplicate` fires on ORDINARY single-run input — the queue accumulates one cursor many times", () => {
    // queueFilename embeds a fresh timestamp, so two candidate FILES legitimately share one cursor
    const report = buildReport(inputsFrom([candidate(), candidate()]), deps());
    expect(report.counts.emitted).toBe(1);
    expect(report.counts.duplicate).toBe(1);
  });

  test("the five buckets sum to the input count", () => {
    const inputs = [
      ...inputsFrom([
        candidate({ provenance: { sourceLine: 3 }, mined: textOfLine(3) }),
        candidate({ memoryType: "problem" }),
        candidate({ provenance: { sourceLine: 999 } }),
        candidate({ provenance: { sourceLine: 3 }, mined: textOfLine(3) }),
      ]),
      { file: "/q/bad.json", raw: "{oops" },
    ];
    const report = buildReport(inputs, deps());
    expect(sumOf(report.counts)).toBe(report.total);
    expect(report.total).toBe(5);
    expect(report.counts).toEqual({ malformed: 1, skipped: 1, stale: 1, duplicate: 1, emitted: 1 });
  });
});

// ── numbering ────────────────────────────────────────────────────────────────

describe("ADR numbering", () => {
  test("continues from max+1 against a file with existing ADRs", () => {
    const existing = "## ADR-0001 — a\n\n## ADR-0012 — b\n";
    const report = buildReport(inputsFrom([candidate({ provenance: { sourceLine: 4 }, mined: textOfLine(4) })]), deps({ existing }));
    expect(report.startingMax).toBe(12);
    expect(report.verdicts[0].adr!.number).toBe(13);
    expect(renderAdr(report.verdicts[0].adr!)).toContain("## ADR-0013 — ");
  });

  test("NO NUMBER IS BURNED by a skipped/stale/duplicate candidate", () => {
    // A → emitted, B → skipped, C → stale, D → emitted. D must be 0002, not 0004.
    const report = buildReport(
      inputsFrom([
        candidate({ provenance: { sourceLine: 3 }, mined: textOfLine(3) }),
        candidate({ memoryType: "milestone" }),
        candidate({ provenance: { sourceLine: 999 } }),
        candidate({ provenance: { sourceLine: 8 }, mined: textOfLine(8) }),
      ]),
      deps(),
    );
    const numbers = report.verdicts.filter((v) => v.adr).map((v) => v.adr!.number);
    expect(numbers).toEqual([1, 2]);
  });
});

// ── render ───────────────────────────────────────────────────────────────────

describe("render", () => {
  test("the emitted ADR matches the prior art's format exactly", () => {
    const c = candidate({ provenance: { sourceLine: 6 }, mined: textOfLine(6) });
    const w = readWindow(numberedTranscript(20), 6, 3)!;
    const md = renderAdr(composeAdr(c as any, w, 13));
    const body = md.split("\n").filter((l) => l !== "");
    expect(body[0]).toMatch(/^## ADR-0013 — .+/);
    expect(body[1]).toBe(markerFor(c.provenance as any));
    expect(body[2]).toMatch(/^\*\*Status:\*\* Open$/);
    expect(body[3]).toMatch(/^\*\*Context:\*\* /);
    expect(body[4]).toMatch(/^\*\*Decision:\*\* /);
    expect(body[5]).toMatch(/^\*\*Consequences:\*\* /);
    // AC3 — every generated ADR carries its own provenance tuple
    expect(body[6]).toContain(c.provenance.sessionId);
    expect(body[6]).toContain("line 6");
    expect(body[6]).toContain(c.provenance.projectSlug);
    // block owns its own newlines: leading + trailing blank line for EOF concat
    expect(md.startsWith("\n")).toBe(true);
    expect(md.endsWith("\n")).toBe(true);
  });

  test("the human digest reports all five buckets and the selection-precision measurement", () => {
    const report = buildReport(inputsFrom([candidate(), candidate({ memoryType: "problem" })]), deps());
    const md = renderHuman(report, "/tmp/out.md", false);
    for (const b of PRECEDENCE) expect(md).toContain(`| ${b} |`);
    expect(md).toContain("Selection precision:");
    expect(md).toContain("Flagged, not fixed");
  });
});

// ── CLI edge ─────────────────────────────────────────────────────────────────

describe("CLI guards", () => {
  test("unknown flags are rejected (the sibling inherits no allowlist from the harvester)", () => {
    expect(unknownFlags(["--json", "--out", "x", "--typo"])).toEqual(["--typo"]);
    expect(unknownFlags(["--out=x", "--dry-run"])).toEqual([]);
    expect(main(["--typo"])).toBe(2);
  });

  test("a value flag swallowing the NEXT FLAG is a usage error, never a silent fallback", () => {
    // core.flagValue is value-flag-blind: `--out --dry-run` yields "--dry-run" as the path
    expect(flagArg(["--out", "--dry-run"], "out").error).toContain("expects a value");
    expect(flagArg(["--out", "/tmp/x.md"], "out").value).toBe("/tmp/x.md");
    expect(flagArg(["--out="], "out").error).toContain("non-empty");
    expect(main(["--out", "--dry-run"])).toBe(2);
  });

  test("REGRESSION (review MINOR 6): the EQUALS form is the escape hatch for a literal `--` path", () => {
    // unambiguous — the `=` delimits the value, so no flag can be swallowed
    expect(flagArg(["--out=--weird.md"], "out").value).toBe("--weird.md");
    expect(flagArg(["--out=--weird.md"], "out").error).toBeUndefined();
    // and the space-form rejection tells the user about it
    expect(flagArg(["--out", "--x"], "out").error).toContain("--out=--x");
  });

  test("REGRESSION (review MINOR 5): an equals-form BOOLEAN flag is a usage error, not a silent no-op", () => {
    // `core.hasFlag` matches the bare token only, so `--json=true` used to be accepted by the
    // unknown-flag guard, ignored by hasFlag, and the run printed human markdown while exiting 0.
    expect(unknownFlags(["--json=true"])).toEqual(["--json=true"]);
    expect(main(["--json=true"])).toBe(2);
    expect(main(["--dry-run=1"])).toBe(2);
    expect(unknownFlags(["--json", "--dry-run"])).toEqual([]); // bare forms still fine
  });

  test("--window is validated", () => {
    expect(main(["--window", "abc", "--dry-run"])).toBe(2);
    expect(main(["--window", "-1", "--dry-run"])).toBe(2);
  });

  test("resolveHome treats an empty HOME as absent", () => {
    expect(resolveHome("", "/fallback")).toBe("/fallback");
    expect(resolveHome(undefined, "/fallback")).toBe("/fallback");
    expect(resolveHome("/home/x", "/fallback")).toBe("/home/x");
  });

  test("--help exits 0", () => {
    expect(main(["--help"])).toBe(0);
  });

  test("readQueue is fail-soft on a missing queue dir", () => {
    expect(readQueue(join(tmp("adr-none-"), "nope"))).toEqual([]);
  });
});

// ── END TO END, on disk ──────────────────────────────────────────────────────

describe("end to end (hermetic roots only)", () => {
  function tree(over: { sourceLine?: number; memoryType?: string } = {}) {
    const projects = projectsWith({ [`slug/${SESSION}.jsonl`]: numberedTranscript(20) });
    const line = over.sourceLine ?? 5;
    const queue = queueWith({
      "mine_2026-07-20T04-00-00_decision_slug_abcdef12_L5.json": candidate({
        provenance: { sourceLine: line },
        mined: textOfLine(line),
        ...(over.memoryType ? { memoryType: over.memoryType } : {}),
      }),
    });
    const outDir = tmp("adr-out-");
    return { projects, queue, out: join(outDir, "docs", "DECISIONS.generated.md"), outDir };
  }

  test("a real run writes the header once and appends one ADR; a re-run is a byte-exact NO-OP", () => {
    const { projects, queue, out } = tree();
    const argv = ["--queue", queue, "--projects", projects, "--out", out];

    expect(main(argv)).toBe(0);
    const first = readFileSync(out, "utf-8");
    expect(first).toContain("Status legend:");
    expect(first).toContain("## ADR-0001 — ");
    expect(first).toContain("LINE-5");
    const hash1 = sha(out);

    // RE-RUN: the marker gate must hold. A heading-derived marker would append ADR-0002 here and
    // an "existing ADRs byte-unchanged" test would still pass — this hash catches it.
    expect(main(argv)).toBe(0);
    expect(sha(out)).toBe(hash1);
    expect(readFileSync(out, "utf-8").match(/^## ADR-/gm)!.length).toBe(1);
  });

  /**
   * Run `main` and capture the `--json` payload it actually emits. The parity tests below compare
   * MAIN's OWN DIGESTS — the earlier version compared two `buildReport` recomputations of the same
   * inputs, which is a tautology that would pass even if `main`'s dry-run path diverged completely
   * (15.4 review, weak test #2/#3).
   */
  function mainJson(argv: string[]): { exit: number; verdicts: any[] } {
    const captured: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: any) => {
      captured.push(String(chunk));
      return true;
    };
    let exit: number;
    try {
      exit = main([...argv, "--json"]);
    } finally {
      (process.stdout as any).write = orig;
    }
    return { exit, verdicts: JSON.parse(captured.join("")) };
  }

  const bucketCounts = (verdicts: any[]): Record<string, number> => {
    const c: Record<string, number> = { malformed: 0, skipped: 0, stale: 0, duplicate: 0, emitted: 0 };
    for (const v of verdicts) c[v.bucket] += 1;
    return c;
  };

  test("--dry-run writes NOTHING and MAIN's own digest reports the same five counts as the real run", () => {
    const { projects, queue, out } = tree();
    const argv = ["--queue", queue, "--projects", projects, "--out", out];

    const dry = mainJson([...argv, "--dry-run"]);
    expect(dry.exit).toBe(0);
    expect(() => readFileSync(out, "utf-8")).toThrow(); // nothing written

    const real = mainJson(argv); // same virgin out-file, now actually written
    expect(real.exit).toBe(0);
    expect(bucketCounts(real.verdicts)).toEqual(bucketCounts(dry.verdicts));
    expect(real.verdicts.length).toBe(dry.verdicts.length);
    expect(readFileSync(out, "utf-8")).toContain("## ADR-0001 — ");
  });

  test("--dry-run bucket parity holds for a DUPLICATE, through MAIN (the write-path-detector trap)", () => {
    // Two candidate files sharing one cursor. A `duplicate` detector built on appendIfMissing's
    // return can never fire under --dry-run: it would report emitted=2 here, and the sum test
    // would not catch it. Asserted through main so it is CLI parity, not just core logic.
    const projects = projectsWith({ [`slug/${SESSION}.jsonl`]: numberedTranscript(20) });
    const queue = queueWith({
      "a.json": candidate({ provenance: { sourceLine: 5 } }),
      "b.json": candidate({ provenance: { sourceLine: 5 } }),
    });
    const out = join(tmp("adr-dup-"), "gen.md");
    const argv = ["--queue", queue, "--projects", projects, "--out", out];

    const dry = bucketCounts(mainJson([...argv, "--dry-run"]).verdicts);
    const real = bucketCounts(mainJson(argv).verdicts);
    expect(dry).toEqual({ malformed: 0, skipped: 0, stale: 0, duplicate: 1, emitted: 1 });
    expect(real).toEqual(dry);
    expect(readFileSync(out, "utf-8").match(/^## ADR-/gm)!.length).toBe(1);
  });

  const HUMAN_BODY =
    "# Decisions — hand written\n\n> Pedro's prose.\n\n## ADR-0001 — a human decision\n**Status:** Accepted\n**Context:** because.\n**Decision:** do it.\n**Consequences:** fine.\n";

  test("THE NEVER-CLOBBER GUARD: the human ADR file on its REAL path is byte-identical after a full run", () => {
    const { projects, queue, outDir } = tree();
    // ⚠ the fixture sits at the REAL prior-art layout `docs/DECISIONS.md` — a sibling of the
    // default out-file, not at the repo root (15.4 review, weak test #1: the old fixture was one
    // directory away from the default, so the test passed on path LUCK and would have kept passing
    // if the default had been changed to `docs/DECISIONS.md`).
    const human = join(outDir, "docs", "DECISIONS.md");
    mkdirSync(join(outDir, "docs"), { recursive: true });
    writeFileSync(human, HUMAN_BODY, "utf-8");
    const before = sha(human);

    // A bare-ish run (default --out) must never land on the human file, and the default is anchored
    // to --root, so even an arbitrary cwd cannot scatter into it.
    expect(main(["--queue", queue, "--projects", projects, "--root", outDir])).toBe(0);

    expect(sha(human)).toBe(before);
    expect(readFileSync(human, "utf-8")).toBe(HUMAN_BODY);
    // the tool wrote to the file it OWNS instead
    expect(readFileSync(join(outDir, "docs", "DECISIONS.generated.md"), "utf-8")).toContain("## ADR-0001 — ");
  });

  test("even a HOSTILE --out at the human file only APPENDS — prior bytes are never replaced", () => {
    // The dangerous path the old fixture never exercised (15.4 review, weak test #1 + MINOR 1).
    // Explicit --out is the documented escape hatch, so it CAN write there — what must hold is that
    // it can never truncate, reorder, or replace what the human wrote.
    const { projects, queue, outDir } = tree({ sourceLine: 6 });
    const human = join(outDir, "docs", "DECISIONS.md");
    mkdirSync(join(outDir, "docs"), { recursive: true });
    writeFileSync(human, HUMAN_BODY, "utf-8");

    expect(main(["--queue", queue, "--projects", projects, "--out", human])).toBe(0);
    const after = readFileSync(human, "utf-8");
    expect(after.startsWith(HUMAN_BODY)).toBe(true); // every prior byte, in order, still first
    expect(after.length).toBeGreaterThan(HUMAN_BODY.length);
    expect(after).toContain("## ADR-0002 — "); // continued from the human's ADR-0001
    expect(after).not.toContain("Status legend:"); // header skipped: writeIfAbsent cannot clobber
    // and it is idempotent even here — a second hostile run changes nothing
    const hash = sha(human);
    expect(main(["--queue", queue, "--projects", projects, "--out", human])).toBe(0);
    expect(sha(human)).toBe(hash);
  });

  test("an out-file that already exists is never re-headered (writeIfAbsent, not atomicWrite)", () => {
    const { projects, queue, out } = tree();
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, "# pre-existing generated file\n", "utf-8");
    expect(main(["--queue", queue, "--projects", projects, "--out", out])).toBe(0);
    const after = readFileSync(out, "utf-8");
    expect(after.startsWith("# pre-existing generated file\n")).toBe(true);
    expect(after).not.toContain("Status legend:");
  });

  test("appending to an existing ADR file continues numbering and leaves prior bytes untouched", () => {
    const { projects, queue, out } = tree({ sourceLine: 7 });
    mkdirSync(join(out, ".."), { recursive: true });
    const prior =
      "# Decisions\n\n## ADR-0001 — first\n**Status:** Accepted\n**Context:** c.\n**Decision:** d.\n**Consequences:** q.\n";
    writeFileSync(out, prior, "utf-8");

    expect(main(["--queue", queue, "--projects", projects, "--out", out])).toBe(0);
    const after = readFileSync(out, "utf-8");
    expect(after.startsWith(prior)).toBe(true); // prior bytes preserved, EOF concat only
    expect(after).toContain("## ADR-0002 — ");
    expect(after).toContain("LINE-7");
  });

  test("--strict exits 1 only when something needs a human; the default is 0", () => {
    const projects = projectsWith({ "slug/other.jsonl": numberedTranscript(3) });
    const queue = queueWith({ "a.json": candidate() }); // cursor cannot resolve → stale
    const outDir = tmp("adr-strict-");
    const argv = ["--queue", queue, "--projects", projects, "--out", join(outDir, "gen.md"), "--dry-run"];
    expect(main(argv)).toBe(0);
    expect(main([...argv, "--strict"])).toBe(1);
  });

  test("--json emits the verdict array", () => {
    const { projects, queue, out } = tree();
    // `emitJson` writes to process.stdout (FR8 — the payload is the ONLY thing on stdout), not console.log
    const captured: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: any) => {
      captured.push(String(chunk));
      return true;
    };
    try {
      expect(main(["--queue", queue, "--projects", projects, "--out", out, "--json", "--dry-run"])).toBe(0);
    } finally {
      (process.stdout as any).write = orig;
    }
    const parsed = JSON.parse(captured.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].bucket).toBe("emitted");
    expect(parsed[0].provenance.sourceLine).toBe(5);
  });
});
