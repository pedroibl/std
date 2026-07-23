import { describe, expect, test } from "bun:test";
import {
  isClosed,
  isDone,
  isOpsKey,
  isProg,
  isStoryKey,
  parseOps,
  parseSprint,
  parseStatusMap,
  SPRINT_CLOSED,
  SPRINT_DONE,
  SPRINT_PROG,
  summarize,
} from "./sprint";
import { bar } from "./bar";

// Story 8.1 — sprint/summary vocabulary tests. Two fixtures below are VERBATIM excerpts of live
// sprint files (core is pure — the test cannot read fs, so the real bytes are pasted as string
// literals). Expected values are written as hand-counted literals / arithmetic so a reader can verify
// them without running the suite. Fixtures are declared at column 0 so the yaml indentation is real.

// ── Fixture A: verbatim excerpt of std's own sprint-status.yaml (captured 2026-07-23) ──
// Carries the real pathologies: a `# ---` divider, a multi-line em-dash header comment, an
// `epic-N: done # <long trailing comment with a : colon and ✅ emoji>` row, several `N-M-slug`
// rows, a comment-only `# FOLLOW-UP` line, and an `epic-N-retrospective: optional` row.
const STD_FIXTURE = `development_status:
  # --- Phase 1 ---

  # Epic 1 — Enforcement Harness (lands FIRST; gates all of Phase 1)
  epic-1: done # all stories 1.1-1.5 done; 1.5 landed on GitHub main via PR #3 (2026-06-28)
  1-1-package-skeleton-bun-ts-strict-test-runner: done
  1-2-core-purity-ci-check: done
  1-3-dependency-root-no-cycle-ci-check: done
  # FOLLOW-UP (from 1.5 loom review, non-blocking): isTokenChar accepts '.'/'~' to bind path-like tokens
  epic-1-retrospective: done # epic-1-retrospective.md (2026-06-28)
  2-3-statusline-counts-stat-record: done # Counts promoted as Record<Severity,number>; kept caller-local: AD-2/OQ1 ✅ no speculative promotion
  epic-2-retrospective: optional
  8-1-promote-sprint-summary-vocabulary-to-core: ready-for-dev
`;

// ── Fixture B: verbatim excerpt of gen-image's sprint-status.yaml (captured 2026-07-23) ──
// The G1 witness: `2-0a-`/`2-0b-` keys reach the map but are dropped by isStoryKey/isOpsKey.
const GENIMAGE_FIXTURE = `development_status:
  # Epic 2: Per-Model Generation — Transport, Correctness & Compilation
  epic-2: done
  2-0-per-modelid-capability-record: done
  2-0a-direct-workers-ai-transport: done
  2-0b-cf-model-upgrade-flux-2-phoenix: done
  2-1-provider-correctness-fixes: done
  epic-2-retrospective: done
`;

describe("parseStatusMap", () => {
  test("parses the real std excerpt into every key:value (epics, stories, retros)", () => {
    const map = parseStatusMap(STD_FIXTURE);
    // hand-counted: 8 keys survive (comments / dividers / the blank line are skipped).
    expect(Object.keys(map)).toEqual([
      "epic-1",
      "1-1-package-skeleton-bun-ts-strict-test-runner",
      "1-2-core-purity-ci-check",
      "1-3-dependency-root-no-cycle-ci-check",
      "epic-1-retrospective",
      "2-3-statusline-counts-stat-record",
      "epic-2-retrospective",
      "8-1-promote-sprint-summary-vocabulary-to-core",
    ]);
    expect(map["epic-1"]).toBe("done");
    expect(map["epic-2-retrospective"]).toBe("optional");
    expect(map["8-1-promote-sprint-summary-vocabulary-to-core"]).toBe("ready-for-dev");
  });

  test("a trailing `# comment` with colons and emoji after the value is stripped", () => {
    const map = parseStatusMap(STD_FIXTURE);
    expect(map["2-3-statusline-counts-stat-record"]).toBe("done"); // comment not glued to the value
  });

  test("missing `development_status:` header → {} (graceful-empty, no throw)", () => {
    expect(parseStatusMap("just prose\n  1-1-x: done\n")).toEqual({});
    expect(() => parseStatusMap("")).not.toThrow();
  });

  test("two headers → only the text between the first two", () => {
    const raw = "development_status:\n  1-1-a: done\ndevelopment_status:\n  2-2-b: review\n";
    const map = parseStatusMap(raw);
    expect(map["1-1-a"]).toBe("done");
    expect(map["2-2-b"]).toBeUndefined();
  });

  test("duplicate key → last wins", () => {
    const map = parseStatusMap("development_status:\n  1-1-x: done\n  1-1-x: review\n");
    expect(map["1-1-x"]).toBe("review");
  });

  test("CRLF is tolerated (absorbed by the \\s* before $)", () => {
    const map = parseStatusMap("development_status:\r\n  1-1-x: done\r\n");
    expect(map["1-1-x"]).toBe("done");
  });

  test("tab indent is accepted (^\\s+ matches a tab)", () => {
    const map = parseStatusMap("development_status:\n\t1-1-x: done\n");
    expect(map["1-1-x"]).toBe("done");
  });

  test("a column-0 key inside the segment is ignored (indent required)", () => {
    const map = parseStatusMap("development_status:\n1-1-x: done\n  1-2-y: review\n");
    expect(map["1-1-x"]).toBeUndefined();
    expect(map["1-2-y"]).toBe("review");
  });

  test("an uppercase value is NOT normalized — captured as-written, so the sets miss it", () => {
    const map = parseStatusMap("development_status:\n  1-1-x: DONE\n");
    expect(map["1-1-x"]).toBe("DONE"); // not "done"
    expect(isDone("DONE")).toBe(false); // the sets are lower-case; /i only widens the CHARSET
  });
});

describe("parseSprint / parseOps", () => {
  test("parseSprint returns only story rows (N-M-…), in file order", () => {
    expect(parseSprint(STD_FIXTURE)).toEqual([
      { key: "1-1-package-skeleton-bun-ts-strict-test-runner", status: "done" },
      { key: "1-2-core-purity-ci-check", status: "done" },
      { key: "1-3-dependency-root-no-cycle-ci-check", status: "done" },
      { key: "2-3-statusline-counts-stat-record", status: "done" },
      { key: "8-1-promote-sprint-summary-vocabulary-to-core", status: "ready-for-dev" },
    ]);
  });

  test("parseSprint excludes epic-* and *-retrospective keys (they land in the map, not the rows)", () => {
    const keys = parseSprint(STD_FIXTURE).map((r) => r.key);
    expect(keys).not.toContain("epic-1");
    expect(keys).not.toContain("epic-1-retrospective");
    expect(keys).not.toContain("epic-2-retrospective");
  });

  test("parseOps returns only ops-N-… rows, in file order", () => {
    const raw = "development_status:\n  1-1-x: done\n  ops-3-nightly-mirror: review\n  ops-4-token-rotate: backlog\n";
    expect(parseOps(raw)).toEqual([
      { key: "ops-3-nightly-mirror", status: "review" },
      { key: "ops-4-token-rotate", status: "backlog" },
    ]);
    expect(parseSprint(raw)).toEqual([{ key: "1-1-x", status: "done" }]); // ops rows are not story rows
  });

  test("headerless input → [] for both (graceful-empty)", () => {
    expect(parseSprint("nope")).toEqual([]);
    expect(parseOps("nope")).toEqual([]);
  });
});

describe("summarize", () => {
  test("hand-counted summary of the real std excerpt", () => {
    // 5 story rows: 4 done + 1 ready-for-dev (prog). pct = round(4/5*100) = 80.
    expect(summarize(parseSprint(STD_FIXTURE))).toEqual({
      total: 5,
      done: 4,
      prog: 1,
      remaining: 0,
      pct: 80,
      closed: 0,
    });
  });

  test("an unknown/backlog status lands in `remaining` (the deliberate catch-all)", () => {
    const s = summarize([
      { key: "1-1-x", status: "done" },
      { key: "1-2-y", status: "backlog" },
      { key: "1-3-z", status: "zzz-brand-new-status" }, // genuinely unknown token, still active
    ]);
    // total 3, done 1, prog 0 → remaining = 3 - 1 - 0 = 2.
    expect(s).toEqual({ total: 3, done: 1, prog: 0, remaining: 2, pct: 33, closed: 0 });
  });

  test("all-rows-closed → {total:0, closed:N, pct:0} (no division)", () => {
    const s = summarize([
      { key: "1-1-a", status: "superseded" },
      { key: "1-2-b", status: "cancelled" },
      { key: "1-3-c", status: "wont-do" },
      { key: "1-4-d", status: "deferred" },
    ]);
    expect(s).toEqual({ total: 0, done: 0, prog: 0, remaining: 0, pct: 0, closed: 4 });
  });

  test("pct is Math.round HALF-UP — 1/8 → 13", () => {
    // 1 done + 7 remaining (backlog) = 8 active. 1/8 = 12.5% → round half-up → 13.
    const rows = [{ key: "0-0-done", status: "done" }];
    for (let i = 1; i <= 7; i++) rows.push({ key: `0-${i}-x`, status: "backlog" });
    expect(summarize(rows).pct).toBe(13);
  });

  test("pct is Math.round HALF-UP — 5/8 → 63", () => {
    const rows: { key: string; status: string }[] = [];
    for (let i = 0; i < 5; i++) rows.push({ key: `0-${i}-d`, status: "done" });
    for (let i = 5; i < 8; i++) rows.push({ key: `0-${i}-x`, status: "backlog" });
    // 5/8 = 62.5% → round half-up → 63.
    expect(summarize(rows).pct).toBe(63);
  });

  test("pct reports 100 while NOT complete — 199/200 → 100 (the false-complete, ported)", () => {
    const rows: { key: string; status: string }[] = [];
    for (let i = 0; i < 199; i++) rows.push({ key: `s-${i}`, status: "done" });
    rows.push({ key: "s-199", status: "backlog" }); // one row NOT done
    const s = summarize(rows);
    // 199/200 = 99.5% → round half-up → 100, even though done (199) < total (200).
    expect(s.pct).toBe(100);
    expect(s.done).toBe(199);
    expect(s.total).toBe(200);
    expect(s.done).not.toBe(s.total);
  });

  test("each SPRINT_CLOSED member excludes its row from active (asserted individually)", () => {
    // superseded/cancelled/wont-do/deferred — three of the four appear in ZERO live sprint files,
    // so this is their only coverage. Asserted behaviourally (via summarize), not `SET.has(x)`.
    for (const status of ["superseded", "cancelled", "wont-do", "deferred"]) {
      const s = summarize([{ key: "1-1-x", status }]);
      expect(s).toMatchObject({ total: 0, closed: 1 });
    }
  });

  test("each SPRINT_PROG member counts toward `prog`, not `done` (asserted individually)", () => {
    for (const status of ["in-progress", "review", "ready-for-dev"]) {
      const s = summarize([{ key: "1-1-x", status }]);
      expect(s).toMatchObject({ total: 1, done: 0, prog: 1, remaining: 0 });
    }
  });
});

describe("predicates", () => {
  test("isStoryKey matches N-M- and N-Ma-, and only those", () => {
    expect(isStoryKey("1-2-user-auth")).toBe(true);
    expect(isStoryKey("12-3-x")).toBe(true);
    expect(isStoryKey("2-0a-direct-workers-ai-transport")).toBe(true); // letter suffix (G1, closed)
    expect(isStoryKey("2-0b-cf-model-upgrade-flux-2-phoenix")).toBe(true);
    expect(isStoryKey("epic-1")).toBe(false);
    expect(isStoryKey("epic-1-retrospective")).toBe(false); // must stay a non-story
    expect(isStoryKey("ops-1-x")).toBe(false);
    expect(isStoryKey("2-0a")).toBe(false); // no trailing segment → not a story key
  });

  test("isOpsKey matches ops-N- and only ops-N-", () => {
    expect(isOpsKey("ops-3-nightly")).toBe(true);
    expect(isOpsKey("1-2-x")).toBe(false);
    expect(isOpsKey("ops-x")).toBe(false);
  });

  test("isDone / isProg / isClosed reflect the three sets", () => {
    expect(isDone("done")).toBe(true);
    expect(isDone("review")).toBe(false);
    expect(isProg("in-progress")).toBe(true);
    expect(isProg("done")).toBe(false);
    expect(isClosed("superseded")).toBe(true);
    expect(isClosed("done")).toBe(false);
  });

  test("the exported sets have exactly the ported membership", () => {
    expect([...SPRINT_DONE].sort()).toEqual(["done"]);
    expect([...SPRINT_PROG].sort()).toEqual(["in-progress", "ready-for-dev", "review"]);
    // FOUR members — `wont-do` is the one every AC omitted.
    expect([...SPRINT_CLOSED].sort()).toEqual(["cancelled", "deferred", "superseded", "wont-do"]);
  });
});

// ── KNOWN GAP tests (D-3 / AC9): today's behaviour is pinned, not fixed. Each name says the
// real-world consequence; each points at deferred-work.md. When 8.2 (or a dedicated fix) closes a
// gap, the matching test goes red in a way that reads "expected — update the pin", not "regression". ──

describe("KNOWN GAP pins (ported verbatim — see deferred-work.md §Deferred from 8-1)", () => {
  test("G1 numeric half CLOSED 2026-07-24 — gen-image's 2-0a-/2-0b- rows now reach the board", () => {
    const map = parseStatusMap(GENIMAGE_FIXTURE);
    expect(map["2-0a-direct-workers-ai-transport"]).toBe("done");
    expect(map["2-0b-cf-model-upgrade-flux-2-phoenix"]).toBe("done");
    // …and parseSprint now ADMITS them, in file order — the two real stories are visible again.
    const storyKeys = parseSprint(GENIMAGE_FIXTURE).map((r) => r.key);
    expect(storyKeys).toEqual([
      "2-0-per-modelid-capability-record",
      "2-0a-direct-workers-ai-transport",
      "2-0b-cf-model-upgrade-flux-2-phoenix",
      "2-1-provider-correctness-fixes",
    ]);
    expect(isStoryKey("2-0a-direct-workers-ai-transport")).toBe(true);
    // A letter-suffixed story is still a STORY, never an ops row.
    expect(isOpsKey("2-0a-direct-workers-ai-transport")).toBe(false);
    expect(parseOps(GENIMAGE_FIXTURE)).toEqual([]);
  });

  test("KNOWN GAP G1 (non-numeric half) — zsh-planning's issue-7- key is still dropped, deliberately", () => {
    // Widening for this shape (/^[a-z]+-\d+-/) would also match `epic-N-retrospective` and `ops-N-…`,
    // reclassifying every retro and ops row as a story on every dashboard. Needs its own key-shape
    // design, not a regex tweak — see deferred-work.md §"Deferred from 8-1".
    expect(isStoryKey("issue-7-remove-filetop-emulate")).toBe(false);
    expect(isOpsKey("issue-7-remove-filetop-emulate")).toBe(false);
    // The guardrail that makes the naive widening unsafe — these must NEVER become story rows:
    expect(isStoryKey("epic-1-retrospective")).toBe(false);
    expect(isStoryKey("ops-1-nightly")).toBe(false);
  });

  test("KNOWN GAP G2 — the segment runs to EOF, leaking a post-section `status: open` into the map", () => {
    const raw =
      "development_status:\n  1-1-x: done\n\naction_items:\n  status: open\n  owner: pedro\n";
    const map = parseStatusMap(raw);
    expect(map["1-1-x"]).toBe("done");
    // `status: open` lives under action_items:, AFTER the block — it should not be here, but is.
    expect(map["status"]).toBe("open");
    // Harmless for the row parsers: `status` fails both key filters, so the board is unaffected.
    expect(parseSprint(raw)).toEqual([{ key: "1-1-x", status: "done" }]);
  });

  test("KNOWN GAP G3 — a quoted or digit-bearing value silently drops the whole row", () => {
    const raw = `development_status:
  1-1-x: "done"
  1-2-y: done
  1-3-z: 'review'
  1-4-w: done2
  1-5-v: v2-done
  1-6-u: in-progress # comment
`;
    const map = parseStatusMap(raw);
    // Only the bare `[a-z-]+` values survive — 2 of 6 rows. Both quote styles AND both
    // digit-bearing values drop; the trailing `# comment` survives.
    expect(map).toEqual({ "1-2-y": "done", "1-6-u": "in-progress" });
  });
});

// ── bar geometry-parity oracle (AC8 / Task 7): `bar` is IMPORTED, never re-promoted. Reconstruct
// dashkit's barHtml inner run inline and prove byte-equality. barHtml emits NO brackets, so the
// fixture MUST pass { brackets: false } (core.bar defaults brackets:true). The oracle reconstructs
// the geometry inline — it does not import dashkit and does not read the vault. ──

describe("bar geometry — byte-parity vs dashkit's barHtml inner run", () => {
  // barHtml (dashkit.ts, live): fill = total ? round(done/total*10) : 0; then
  // '█'.repeat(fill) in one <span> + '░'.repeat(10 - fill) in another. Concatenated inner run:
  const innerRun = (done: number, total: number): string => {
    const fill = total ? Math.round((done / total) * 10) : 0;
    return "█".repeat(fill) + "░".repeat(10 - fill);
  };

  test("byte-identical to bar(done,total,{width:10,brackets:false}) over the in-domain range", () => {
    const cases: ReadonlyArray<readonly [number, number]> = [
      [0, 0], // total 0 → empty track
      [1, 2], // round(5) = 5
      [2, 2], // full
      [1, 3], // round(3.33) = 3
      [3, 7], // round(4.28) = 4
      [1, 20], // round(0.5) = 1 (half-up)
      [1, 21], // round(0.476) = 0
      [199, 200], // round(9.95) = 10
    ];
    for (const [done, total] of cases) {
      expect(bar(done, total, { width: 10, brackets: false })).toBe(innerRun(done, total));
    }
  });

  test("benign clamp delta: bar(3,2) yields a full track where barHtml's '░'.repeat(10-15) throws", () => {
    // done > total: core.bar CLAMPS to a full track (the fix); the vault's unclamped
    // '░'.repeat(10 - fill) with fill=15 does '░'.repeat(-5) → RangeError. This clamp is what 8.2
    // inherits — do NOT restore the unclamped behaviour.
    expect(bar(3, 2, { width: 10, brackets: false })).toBe("█".repeat(10));
    const vaultFill = Math.round((3 / 2) * 10); // 15
    expect(() => "░".repeat(10 - vaultFill)).toThrow(RangeError);
  });
});
