// dashkit tests (Story 8.2 AC10) — HERMETIC. The renderer moved out of the note-report vault into this
// slice; these lock its behaviour with zero contact to the live vault or the five external sprint repos.
//
// NO DOM DEPENDENCY, and no path-relative vault probing. `bun test` has no DOM and devDeps stay {@types/bun, typescript,
// yaml} — so DOM assertions run against a hand-rolled minimal `document` on globalThis (cn's precedent,
// src/cn/index.test.ts). Sprint fixtures are 8.1's ALREADY-CAPTURED literals from src/core/sprint.test.ts
// (verbatim excerpts of real sprint files) — never re-captured, never invented (Epic-15 retro §2).
//
// This file typechecks under src/dashkit/tsconfig.test.json (types: ["bun"] + DOM).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  barHtml,
  ensureStyles,
  epicRows,
  getDataview,
  icon,
  mirrorNotes,
  nextStory,
  pmStatus,
  type Project,
  project,
  projectsByGroup,
  relatedHtml,
  showcaseHtml,
  statCard,
  statGrid,
  storyNum,
  storyTitle,
} from "./index";
import { parseSprint, parseStatusMap, isOpsKey, isStoryKey, SPRINT_CLOSED, isDone } from "../core/sprint";
import { escapeHtml } from "../core";

// ── 8.1's captured fixtures (verbatim excerpts of live sprint files — src/core/sprint.test.ts). ──
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

// The G1 witness (gen-image): `2-0a-`/`2-0b-` keys reach the map but are dropped by isStoryKey/isOpsKey.
const GENIMAGE_FIXTURE = `development_status:
  # Epic 2: Per-Model Generation — Transport, Correctness & Compilation
  epic-2: done
  2-0-per-modelid-capability-record: done
  2-0a-direct-workers-ai-transport: done
  2-0b-cf-model-upgrade-flux-2-phoenix: done
  2-1-provider-correctness-fixes: done
  epic-2-retrospective: done
`;

// ── minimal DOM stub (cn precedent) — only what dashkit's DOM helpers touch. ──
interface StubEl {
  tag: string;
  className: string;
  textContent: string;
  id: string;
  style: Record<string, string>;
  children: StubEl[];
  appendChild(child: StubEl): StubEl;
}

function makeEl(tag: string): StubEl {
  const el: StubEl = {
    tag,
    className: "",
    textContent: "",
    id: "",
    style: {},
    children: [],
    appendChild(child: StubEl) {
      el.children.push(child);
      return child;
    },
  };
  return el;
}

function makeStubDoc() {
  const head = makeEl("head");
  return {
    head,
    createElement: (tag: string) => makeEl(tag),
    getElementById: (id: string) => head.children.find((c) => c.id === id) ?? null,
  };
}

const as = (el: unknown) => el as unknown as StubEl;

const prevDoc = (globalThis as Record<string, unknown>)["document"];
let doc: ReturnType<typeof makeStubDoc>;

beforeEach(() => {
  doc = makeStubDoc();
  (globalThis as Record<string, unknown>)["document"] = doc;
});
afterEach(() => {
  (globalThis as Record<string, unknown>)["document"] = prevDoc;
});

// ────────────────────────────── helpers over rows ──────────────────────────────

describe("row helpers", () => {
  test("storyNum handles two-digit + ops", () => {
    expect(storyNum("1-10-x")).toBe("1.10");
    expect(storyNum("ops-1-y")).toBe("ops.1");
  });
  test("icon maps each state", () => {
    expect(icon("done")).toBe("✅");
    expect(icon("review")).toBe("🟡");
    expect(icon("ready-for-dev")).toBe("🟡");
    expect(icon("superseded")).toBe("↪️");
    expect(icon("backlog")).toBe("⬜");
  });
  test("nextStory skips done AND closed; honours execution order when epics passed", () => {
    const rows = [
      { key: "1-1-a", status: "done" },
      { key: "1-2-b", status: "superseded" },
      { key: "1-3-c", status: "backlog" },
    ];
    expect(nextStory(rows)?.key).toBe("1-3-c");
    expect(nextStory([{ key: "1-1-a", status: "done" }])).toBeNull();
    const rows2 = [
      { key: "6-1-a", status: "done" },
      { key: "7-1-cn", status: "backlog" },
      { key: "9-1-kit", status: "backlog" },
    ];
    const execOrder = [{ n: "6" }, { n: "9" }, { n: "7" }] as unknown as Parameters<typeof nextStory>[1];
    expect(nextStory(rows2)?.key).toBe("7-1-cn"); // file order (back-compat)
    expect(nextStory(rows2, execOrder)?.key).toBe("9-1-kit"); // execution order
  });
  test("epicRows filters by epic prefix", () => {
    const rows = parseSprint(STD_FIXTURE);
    expect(epicRows(rows, "1").map((r) => r.key)).toEqual([
      "1-1-package-skeleton-bun-ts-strict-test-runner",
      "1-2-core-purity-ci-check",
      "1-3-dependency-root-no-cycle-ci-check",
    ]);
    expect(epicRows(rows, "2").map((r) => r.key)).toEqual(["2-3-statusline-counts-stat-record"]);
  });
  test("storyTitle uses curated map, else prettifies the slug (no registry default — caller passes titles)", () => {
    expect(storyTitle("1-1-x", { "1-1": "Curated Title" })).toBe("Curated Title");
    expect(storyTitle("9-9-some-new-thing", {})).toBe("Some New Thing");
  });
});

// ────────────────────────── registry-as-argument (D4) ──────────────────────────

describe("project / projectsByGroup take the registry as an argument (D4)", () => {
  const registry: Record<string, Project> = {
    alpha: { id: "alpha", name: "Alpha", note: "a", group: "grp1", sprintPath: "", epics: [], storyTitles: {} },
    beta: { id: "beta", name: "Beta", note: "b", group: "grp2", sprintPath: "", epics: [], storyTitles: {} },
    gamma: { id: "gamma", name: "Gamma", note: "g", group: "grp1", sprintPath: "", epics: [], storyTitles: {} },
  };

  test("project(registry, id) resolves, throws with a clear message on unknown", () => {
    expect(project(registry, "beta").name).toBe("Beta");
    expect(() => project(registry, "nope")).toThrow(/Unknown project 'nope'/);
  });
  test("projectsByGroup(registry) groups in registry order, each project exactly once", () => {
    const grouped = projectsByGroup(registry);
    expect(grouped).toEqual([
      { group: "grp1", ids: ["alpha", "gamma"] },
      { group: "grp2", ids: ["beta"] },
    ]);
    const flat = grouped.flatMap((g) => g.ids);
    expect(flat.sort()).toEqual(Object.keys(registry).sort());
    expect(flat.length).toBe(new Set(flat).size);
  });
});

// ─────────────────────────── relatedHtml / showcaseHtml ───────────────────────────

describe("relatedHtml / showcaseHtml", () => {
  const sat: Project = {
    id: "x", name: "x", note: "x", sprintPath: "", epics: [], storyTitles: {},
    related: [{ name: "homebrew-tap", host: "gh", role: "delivery", story: "5.11", url: "https://example.com/t" }],
  };
  const show: Project = {
    id: "y", name: "y", note: "y", sprintPath: "", epics: [], storyTitles: {},
    showcase: [{ name: "n8n-linode-declarative", path: "showcase/n8n-linode-declarative", doc: "PLAYBOOK.md" }],
  };
  const bare: Project = { id: "z", name: "z", note: "z", sprintPath: "", epics: [], storyTitles: {} };

  test("relatedHtml renders name + host label + role + story; empty when none", () => {
    const h = relatedHtml(sat);
    expect(h).toContain("homebrew-tap");
    expect(h).toContain("GitHub"); // gh → GitHub
    expect(h).toContain("delivery");
    expect(h).toContain("via 5.11");
    expect(h).toContain('href="https://example.com/t"');
    expect(relatedHtml(bare)).toBe("");
  });
  test("showcaseHtml renders name + path + doc; empty when none", () => {
    const h = showcaseHtml(show);
    expect(h).toContain("n8n-linode-declarative");
    expect(h).toContain("PLAYBOOK.md");
    expect(showcaseHtml(bare)).toBe("");
  });
});

// ─────────────────────────── barHtml → core.bar (AC4) ───────────────────────────

describe("barHtml routes through core.bar", () => {
  const filled = (s: string) => (s.replace(/<[^>]+>/g, "").match(/█/g) || []).length;
  const cells = (s: string) => [...s.replace(/<[^>]+>/g, "")].filter((c) => c === "█" || c === "░").length;

  test("geometry parity over {0..10} × {0,1,5,10}: fill = core.bar's clamped round (== old Math.round when done≤total)", () => {
    for (let done = 0; done <= 10; done++) {
      for (const total of [0, 1, 5, 10]) {
        const expected = total ? Math.min(10, Math.round((done / total) * 10)) : 0;
        expect(filled(barHtml(done, total))).toBe(expected);
        expect(cells(barHtml(done, total))).toBe(10); // always exactly 10 cells
      }
    }
  });

  test("SANCTIONED DELTA #1 (AC4) — barHtml(11,10) returns a FULL track where the old body threw RangeError", () => {
    // Old body: fill = round(11/10*10) = 11; '░'.repeat(10 - 11) → RangeError. core.bar clamps to a full
    // track. This is the fix 8.2 inherits from 12.2 — NOT something to restore.
    expect(filled(barHtml(11, 10))).toBe(10);
    expect(cells(barHtml(11, 10))).toBe(10);
    const oldFill = Math.round((11 / 10) * 10); // 11
    expect(() => "░".repeat(10 - oldFill)).toThrow(RangeError);
  });

  test("green only when done === total (unchanged from the vault — no in-range colour moves)", () => {
    expect(barHtml(10, 10)).toContain("var(--color-green)");
    expect(barHtml(9, 10)).not.toContain("var(--color-green)"); // partial → accent
    // (199,200): core.bar fills all 10 cells, but done !== total, so still ACCENT, not green — identical
    // to the vault's old rule. The clamp changes overflow, never the complete-colour rule.
    expect(barHtml(199, 200)).not.toContain("var(--color-green)");
    expect(filled(barHtml(199, 200))).toBe(10);
  });
});

// ─────────────────── escapeHtml widening — SANCTIONED DELTA #2 (AC4b) ───────────────────

describe("escapeHtml is core's 5-char version — SANCTIONED DELTA #2 (AC4b)", () => {
  test("the second sanctioned delta of this story — a strict widening, adopted deliberately, not restored", () => {
    // The vault's local escapeHtml (dashkit.ts:1071-1072) escaped 4 chars (& < > "); it is DELETED and
    // dashkit now imports core.escapeHtml (src/core/text.ts), which also escapes ' → &#39;. Every renderer
    // call site (issueBoard labels/title, nameHtml, sessionsTable cells) feeds TEXT-content context, never
    // an attribute/JS context, so the extra entity only encodes — it never changes meaning.
    expect(escapeHtml("it's")).toBe("it&#39;s");
    expect(escapeHtml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });
});

// ───────────── KNOWN GAP pins — ported verbatim from 8.1; do NOT "fix" here (AC5) ─────────────

describe("KNOWN GAP pins (pinned by 8.1, do not fix here — see deferred-work.md §Deferred from 8-1)", () => {
  test("KNOWN GAP G1 — isStoryKey drops N-Ma- keys; BOTH live shapes stay rejected (2-0a-… AND issue-7-…)", () => {
    const map = parseStatusMap(GENIMAGE_FIXTURE);
    expect(map["2-0a-direct-workers-ai-transport"]).toBe("done"); // reaches the map…
    const storyKeys = parseSprint(GENIMAGE_FIXTURE).map((r) => r.key);
    expect(storyKeys).toEqual(["2-0-per-modelid-capability-record", "2-1-provider-correctness-fixes"]);
    expect(storyKeys).not.toContain("2-0a-direct-workers-ai-transport"); // …but the board drops it
    // 8.1 names TWO live shapes, not one — pin BOTH:
    expect(isStoryKey("2-0a-direct-workers-ai-transport")).toBe(false);
    expect(isOpsKey("2-0a-direct-workers-ai-transport")).toBe(false);
    expect(isStoryKey("issue-7-remove-filetop-emulate")).toBe(false); // zsh-planning's non-numeric prefix
    expect(isOpsKey("issue-7-remove-filetop-emulate")).toBe(false);
  });

  test("KNOWN GAP G2 — the segment runs to EOF, leaking a post-section `status: open` into the map", () => {
    const raw = "development_status:\n  1-1-x: done\n\naction_items:\n  status: open\n  owner: pedro\n";
    const map = parseStatusMap(raw);
    expect(map["1-1-x"]).toBe("done");
    expect(map["status"]).toBe("open"); // leaked from action_items: — pinned, not fixed
    expect(parseSprint(raw)).toEqual([{ key: "1-1-x", status: "done" }]); // harmless for the board
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
    // Only the bare `[a-z-]+` values survive — 2 of 6 rows; both quote styles AND both digit-bearing drop.
    expect(map).toEqual({ "1-2-y": "done", "1-6-u": "in-progress" });
  });
});

// ─────────────────────── PM_STATUS re-expressed over core's sets (AC5b / D-8) ───────────────────────

describe("pmStatus derives from core/sprint's promoted sets, not a second enumeration (AC5b / D-8)", () => {
  test("isDone(t) ⟺ pmStatus(t) === 'done' for every token in the AC10 fixtures", () => {
    const tokens = new Set<string>();
    for (const fx of [STD_FIXTURE, GENIMAGE_FIXTURE]) {
      for (const v of Object.values(parseStatusMap(fx))) tokens.add(v);
    }
    // fixtures carry: done, ready-for-dev, optional — plus the common live states below.
    for (const t of [...tokens, "in-progress", "review", "backlog", "superseded", "wont-do", "deferred"]) {
      expect(pmStatus(t) === "done").toBe(isDone(t));
    }
  });
  test("every SPRINT_CLOSED member collapses to 'todo' — the missing-wont-do class cannot recur", () => {
    for (const s of SPRINT_CLOSED) expect(pmStatus(s)).toBe("todo");
  });
  test("output is byte-identical to the vault's old PM_STATUS table (no third delta)", () => {
    expect(pmStatus("done")).toBe("done");
    expect(pmStatus("in-progress")).toBe("in-progress");
    expect(pmStatus("review")).toBe("review");
    expect(pmStatus("ready-for-dev")).toBe("todo");
    expect(pmStatus("backlog")).toBe("backlog");
    expect(pmStatus("something-weird")).toBe("todo"); // safe fallback
  });
});

// ─────────────────────── mirrorNotes takes mirrorDir as an argument (D4) ───────────────────────

describe("mirrorNotes — pure emitter, mirrorDir injected (D4)", () => {
  const cfg: Project = {
    id: "demo", name: "Demo", note: "demo", sprintPath: "/tmp/demo.yaml",
    epics: [{ n: "1", title: "E1", blurb: "" }],
    storyTitles: { "1-1": "First", "1-2": "Second" },
  };
  const rows = [
    { key: "1-1-first", status: "done" },
    { key: "1-2-second", status: "ready-for-dev" },
    { key: "1-3-third", status: "backlog" },
  ];
  const MIRROR = "Projects/_bmad-mirror";
  const { project: proj, tasks } = mirrorNotes(cfg, rows, MIRROR, "2026-01-01T00:00:00.000Z");

  test("paths are built from the injected mirrorDir, not a baked-in constant", () => {
    expect(proj.path).toBe("Projects/_bmad-mirror/demo/_demo.md");
    for (const t of tasks) expect(t.path.startsWith("Projects/_bmad-mirror/demo/")).toBe(true);
    // a different mirrorDir flows straight through — proves it is an argument, not a constant:
    const { project: p2 } = mirrorNotes(cfg, rows, "Vault2/mirror", "2026-01-01T00:00:00.000Z");
    expect(p2.path).toBe("Vault2/mirror/demo/_demo.md");
  });
  test("project note carries taskIds for every row; tasks carry status + provenance + read-only marker", () => {
    expect(proj.frontmatter["pm-project"]).toBe(true);
    expect((proj.frontmatter.taskIds as string[]).length).toBe(rows.length);
    expect(tasks.length).toBe(rows.length);
    expect(tasks[0].frontmatter.status).toBe("done");
    expect(tasks[0].frontmatter.progress).toBe(100);
    expect(tasks[0].frontmatter["source-key"]).toBe("1-1-first");
    expect(tasks[0].body).toContain("AUTO-GENERATED");
    expect(tasks[1].frontmatter.status).toBe("todo"); // ready-for-dev → todo (board column)
    expect(tasks[1].frontmatter.progress).toBe(50); // …but ready-for-dev is prog-class → 50
    expect(tasks[2].frontmatter.status).toBe("backlog");
  });
  test("stamp is injected (deterministic), never a module-scope Date.now()", () => {
    expect(proj.frontmatter.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

// ────────────────────────────── DOM helpers (stub) ──────────────────────────────

describe("DOM helpers render into the stub document", () => {
  test("getDataview resolves the api or null", () => {
    expect(getDataview({ plugins: { plugins: { dataview: { api: { q: 1 } } } } })).toEqual({ q: 1 });
    expect(getDataview({})).toBeNull();
    expect(getDataview(null)).toBeNull();
  });
  test("statCard + statGrid append dk- cards; ensureStyles is id-guarded", () => {
    const container = as(doc.createElement("div"));
    const grid = as(statGrid(container as unknown as HTMLElement, [
      { label: "Done", value: 4 },
      { label: "Total", value: 5, accent: true },
    ]));
    expect(grid.className).toBe("dk-stat-grid");
    expect(grid.children.length).toBe(2);
    expect(grid.children[0].className).toBe("dk-stat-card");

    const single = as(statCard(container as unknown as HTMLElement, { label: "X", value: 1, tone: "--color-red-rgb" }));
    expect(single.className).toBe("dk-stat-card");

    ensureStyles();
    ensureStyles(); // id-guarded — a second call must NOT append a second <style>
    expect(doc.head.children.filter((c) => c.id === "dk-base-styles").length).toBe(1);
  });
});
