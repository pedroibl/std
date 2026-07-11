import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendToTarget,
  approve,
  approveAll,
  formatPayload,
  loadQueue,
  main,
  reject,
  reviewQueue,
  saveQueue,
  type Paths,
  type Proposal,
} from "./approve-current-state-entries";

// ── Hermetic tree: a synthetic CURRENT_STATE dir under a fresh mkdtemp root each build. ──
const roots: string[] = [];
function makePaths(): Paths {
  const root = mkdtempSync(join(tmpdir(), "approve-cs-"));
  roots.push(root);
  const currentStateDir = join(root, "CURRENT_STATE");
  mkdirSync(currentStateDir, { recursive: true });
  return { queueFile: join(currentStateDir, "proposals.jsonl"), currentStateDir };
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const FIXED = () => new Date("2026-07-12T03:04:05.000Z");

function prop(over: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    timestamp: "2026-07-12T00:00:00.000Z",
    source: "lifelog",
    target: "CONSUMPTION",
    payload: { category: "restaurant", name: "Papaya Thai", rating: 5 },
    status: "pending",
    ...over,
  };
}

describe("loadQueue / saveQueue round-trip (queue plumbing on std)", () => {
  test("missing queue file → empty array", () => {
    const paths = makePaths();
    expect(loadQueue(paths.queueFile)).toEqual([]);
  });

  test("save then load preserves records (NDJSON round-trip)", () => {
    const paths = makePaths();
    const queue = [prop(), prop({ id: "p2", target: "ACTIVITY" })];
    saveQueue(paths.queueFile, queue);
    expect(loadQueue(paths.queueFile)).toEqual(queue);
  });

  test("non-empty save uses one-object-per-line + trailing newline framing", () => {
    const paths = makePaths();
    saveQueue(paths.queueFile, [prop(), prop({ id: "p2" })]);
    const raw = readFileSync(paths.queueFile, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trimEnd().split("\n")).toHaveLength(2);
  });

  test("empty save writes empty file (no stray newline)", () => {
    const paths = makePaths();
    saveQueue(paths.queueFile, []);
    expect(readFileSync(paths.queueFile, "utf-8")).toBe("");
  });

  test("parseNdjson skips malformed lines gracefully (substrate hardening)", () => {
    const paths = makePaths();
    writeFileSync(paths.queueFile, `${JSON.stringify(prop())}\ngarbage{\n${JSON.stringify(prop({ id: "p2" }))}\n`);
    expect(loadQueue(paths.queueFile).map((p) => p.id)).toEqual(["p1", "p2"]);
  });
});

describe("status transitions: pending → approved", () => {
  test("approve commits payload + drops the proposal from the queue", () => {
    const paths = makePaths();
    writeFileSync(join(paths.currentStateDir, "CONSUMPTION.md"), "# Consumption\n");
    saveQueue(paths.queueFile, [prop(), prop({ id: "p2", status: "approved" })]);

    approve(paths, "p1", FIXED);

    // p1 removed; the pre-approved p2 record is untouched.
    expect(loadQueue(paths.queueFile).map((p) => p.id)).toEqual(["p2"]);
    expect(existsSync(join(paths.currentStateDir, "CONSUMPTION.md"))).toBe(true);
  });

  test("YAML-list commit output shape is byte-preserved", () => {
    const paths = makePaths();
    writeFileSync(join(paths.currentStateDir, "CONSUMPTION.md"), "# Consumption\n");
    approve(paths, "p1", FIXED); // no such proposal → nothing committed
    saveQueue(paths.queueFile, [prop()]);
    approve(paths, "p1", FIXED);

    const md = readFileSync(join(paths.currentStateDir, "CONSUMPTION.md"), "utf-8");
    expect(md).toBe(
      "# Consumption\n\n" +
        "<!-- approved 2026-07-12T03:04:05.000Z from lifelog -->\n" +
        '- category: "restaurant"\n' +
        '  name: "Papaya Thai"\n' +
        "  rating: 5\n",
    );
  });

  test("approve with unknown id leaves queue + target untouched", () => {
    const paths = makePaths();
    writeFileSync(join(paths.currentStateDir, "CONSUMPTION.md"), "# Consumption\n");
    saveQueue(paths.queueFile, [prop()]);

    approve(paths, "nope", FIXED);

    expect(loadQueue(paths.queueFile).map((p) => p.id)).toEqual(["p1"]);
    expect(readFileSync(join(paths.currentStateDir, "CONSUMPTION.md"), "utf-8")).toBe("# Consumption\n");
  });

  test("approveAll commits every pending + keeps non-pending records", () => {
    const paths = makePaths();
    writeFileSync(join(paths.currentStateDir, "CONSUMPTION.md"), "# C\n");
    writeFileSync(join(paths.currentStateDir, "ACTIVITY.md"), "# A\n");
    saveQueue(paths.queueFile, [
      prop({ id: "p1", target: "CONSUMPTION" }),
      prop({ id: "p2", target: "ACTIVITY" }),
      prop({ id: "p3", status: "rejected" }),
    ]);

    approveAll(paths, FIXED);

    // only the non-pending record survives.
    expect(loadQueue(paths.queueFile).map((p) => p.id)).toEqual(["p3"]);
    expect(readFileSync(join(paths.currentStateDir, "CONSUMPTION.md"), "utf-8")).toContain("<!-- approved");
    expect(readFileSync(join(paths.currentStateDir, "ACTIVITY.md"), "utf-8")).toContain("<!-- approved");
  });
});

describe("status transitions: pending → rejected", () => {
  test("reject drops the proposal without committing to any target", () => {
    const paths = makePaths();
    writeFileSync(join(paths.currentStateDir, "CONSUMPTION.md"), "# Consumption\n");
    saveQueue(paths.queueFile, [prop(), prop({ id: "p2" })]);

    reject(paths, "p1");

    expect(loadQueue(paths.queueFile).map((p) => p.id)).toEqual(["p2"]);
    // target file never appended to.
    expect(readFileSync(join(paths.currentStateDir, "CONSUMPTION.md"), "utf-8")).toBe("# Consumption\n");
  });

  test("reject with unknown id is a no-op on the queue", () => {
    const paths = makePaths();
    saveQueue(paths.queueFile, [prop()]);
    reject(paths, "nope");
    expect(loadQueue(paths.queueFile).map((p) => p.id)).toEqual(["p1"]);
  });
});

describe("appendToTarget guard + formatPayload", () => {
  test("missing target file is a no-op (no throw, no write)", () => {
    const paths = makePaths();
    appendToTarget(paths.currentStateDir, "GHOST", { a: 1 }, "manual", FIXED);
    expect(existsSync(join(paths.currentStateDir, "GHOST.md"))).toBe(false);
  });

  test("formatPayload renders 4-space-indented key/value lines, strings quoted", () => {
    expect(formatPayload({ name: "Papaya", rating: 5 })).toBe('    name: "Papaya"\n    rating: 5');
  });
});

describe("main flag routing (dispatch)", () => {
  test("all known flags + usage fallback return exit 0", () => {
    const paths = makePaths();
    writeFileSync(join(paths.currentStateDir, "CONSUMPTION.md"), "# C\n");
    saveQueue(paths.queueFile, [prop()]);

    expect(main(["--review"], paths, FIXED)).toBe(0);
    expect(main(["--approve", "p1"], paths, FIXED)).toBe(0);
    expect(main(["--reject", "nope"], paths, FIXED)).toBe(0);
    expect(main(["--approve-all"], paths, FIXED)).toBe(0);
    expect(main([], paths, FIXED)).toBe(0);
  });

  test("--approve <id> via main routes the id through to a commit", () => {
    const paths = makePaths();
    writeFileSync(join(paths.currentStateDir, "CONSUMPTION.md"), "# C\n");
    saveQueue(paths.queueFile, [prop()]);

    main(["--approve", "p1"], paths, FIXED);

    expect(loadQueue(paths.queueFile)).toEqual([]);
    expect(readFileSync(join(paths.currentStateDir, "CONSUMPTION.md"), "utf-8")).toContain('name: "Papaya Thai"');
  });

  test("--approve-all beats --approve; --review beats both (priority order)", () => {
    const paths = makePaths();
    writeFileSync(join(paths.currentStateDir, "CONSUMPTION.md"), "# C\n");
    saveQueue(paths.queueFile, [prop()]);

    // --review present alongside others → review wins, nothing committed/removed.
    main(["--review", "--approve-all", "--approve", "p1"], paths, FIXED);
    expect(loadQueue(paths.queueFile).map((p) => p.id)).toEqual(["p1"]);
  });

  test("reviewQueue on empty queue does not throw", () => {
    const paths = makePaths();
    expect(() => reviewQueue(paths)).not.toThrow();
  });
});
