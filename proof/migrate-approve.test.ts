import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseNdjson, slugify } from "std/core";
import {
  type Ctx,
  cmdApprove,
  cmdApproveAll,
  cmdModify,
  cmdReject,
  commitProposal,
  defaultCtx,
  loadQueue,
  main,
  resolveTargetPath,
  saveQueue,
} from "./migrate-approve";

// ─── Fixtures ───

const NOW = new Date("2026-07-12T10:30:00.000Z");
const NOW_ISO = "2026-07-12T10:30:00.000Z";
const NOW_DATE = "2026-07-12";

type Proposal = {
  id: string;
  timestamp: string;
  source_file: string;
  source_section: string;
  content_preview: string;
  content_full: string;
  proposed_target: string;
  classification_confidence: number;
  classification_reasons: string[];
  alternatives: string[];
  status: "pending" | "approved" | "rejected" | "modified";
};

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: "abcd1234ef567890",
    timestamp: "2026-07-01T00:00:00.000Z",
    source_file: "/src/notes.md",
    source_section: "notes.md:My Section!",
    content_preview: "some preview text",
    content_full: "The full body of the chunk.",
    proposed_target: "TELOS/WISDOM.md",
    classification_confidence: 0.82,
    classification_reasons: ["matched /wisdom/"],
    alternatives: ["TELOS/BELIEFS.md"],
    status: "pending",
    ...over,
  };
}

let root: string;
let ctx: Ctx;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "migrate-approve-"));
  const paiDir = join(root, "PAI");
  const home = join(root, "home");
  ctx = {
    home,
    paiDir,
    queueFile: join(paiDir, "MEMORY", "MIGRATION", "migration-proposals.jsonl"),
    committedLog: join(paiDir, "MEMORY", "MIGRATION", "committed.jsonl"),
    now: NOW,
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function readAudit(): Record<string, unknown>[] {
  return parseNdjson<Record<string, unknown>>(readFileSync(ctx.committedLog, "utf-8"));
}

// ─── Wire-format round-trip ───

describe("wire format round-trip", () => {
  test("saveQueue → loadQueue preserves the Proposal records", () => {
    const q = [proposal({ id: "aaaa1111" }), proposal({ id: "bbbb2222", status: "modified" })];
    saveQueue(ctx, q);
    expect(loadQueue(ctx)).toEqual(q);
  });

  test("NDJSON framing: one JSON object per line + trailing newline", () => {
    const q = [proposal({ id: "aaaa1111" }), proposal({ id: "bbbb2222" })];
    saveQueue(ctx, q);
    const raw = readFileSync(ctx.queueFile, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    const linesArr = raw.split("\n").filter((l) => l.trim());
    expect(linesArr.length).toBe(2);
    expect(JSON.parse(linesArr[0]).id).toBe("aaaa1111");
  });

  test("empty queue writes an empty file (no trailing newline)", () => {
    saveQueue(ctx, []);
    expect(readFileSync(ctx.queueFile, "utf-8")).toBe("");
  });

  test("loadQueue on absent file returns []", () => {
    expect(loadQueue(ctx)).toEqual([]);
  });

  test("loadQueue skips malformed lines (parseNdjson robustness)", () => {
    mkdirSync(join(ctx.paiDir, "MEMORY", "MIGRATION"), { recursive: true });
    writeFileSync(ctx.queueFile, `${JSON.stringify(proposal({ id: "ok1" }))}\n{ broken json\n`);
    const loaded = loadQueue(ctx);
    expect(loaded.length).toBe(1);
    expect(loaded[0].id).toBe("ok1");
  });
});

// ─── resolveTargetPath (frozen mapping) ───

describe("resolveTargetPath", () => {
  test("TELOS/USER/MEMORY labels map under paiDir", () => {
    expect(resolveTargetPath(ctx, "TELOS/WISDOM.md")).toBe(join(ctx.paiDir, "TELOS/WISDOM.md"));
    expect(resolveTargetPath(ctx, "USER/PRINCIPAL_IDENTITY.md")).toBe(join(ctx.paiDir, "USER/PRINCIPAL_IDENTITY.md"));
  });

  test("memory/feedback resolves under home projects dir", () => {
    expect(resolveTargetPath(ctx, "memory/feedback")).toBe(
      join(ctx.home, ".claude", "projects", "${HARNESS_USER_DIR}", "memory"),
    );
  });
});

// ─── Status transitions ───

describe("status transitions", () => {
  test("pending → approved: append to existing TELOS file + drop from queue + audit line", () => {
    const targetPath = join(ctx.paiDir, "TELOS", "WISDOM.md");
    mkdirSync(join(ctx.paiDir, "TELOS"), { recursive: true });
    writeFileSync(targetPath, "existing wisdom\n");

    const p = proposal({ id: "app12345678" });
    saveQueue(ctx, [p]);

    cmdApprove(ctx, "app1");

    // queue emptied
    expect(loadQueue(ctx)).toEqual([]);
    // target appended with provenance + full content
    const after = readFileSync(targetPath, "utf-8");
    expect(after.startsWith("existing wisdom\n")).toBe(true);
    expect(after).toContain(`<!-- migrated ${NOW_ISO} from /src/notes.md :: notes.md:My Section! -->`);
    expect(after).toContain("The full body of the chunk.");
    // audit line shape
    const audit = readAudit();
    expect(audit.length).toBe(1);
    expect(audit[0].id).toBe("app12345678");
    expect(audit[0].committed_at).toBe(NOW_ISO);
    expect(audit[0].target_path).toBe(targetPath);
  });

  test("pending → rejected: dropped with no commit + no audit", () => {
    const p = proposal({ id: "rej12345678" });
    saveQueue(ctx, [p]);

    cmdReject(ctx, "rej1");

    expect(loadQueue(ctx)).toEqual([]);
    expect(existsSync(ctx.committedLog)).toBe(false);
  });

  test("pending → modified: retarget then commit as new knowledge file", () => {
    const p = proposal({ id: "mod12345678", proposed_target: "UNCLEAR" });
    saveQueue(ctx, [p]);

    cmdModify(ctx, "mod1", "MEMORY/KNOWLEDGE/Ideas");

    // committed → removed from queue
    expect(loadQueue(ctx)).toEqual([]);
    const slug = slugify("notes.md:My Section!", 40);
    const filePath = join(ctx.paiDir, "MEMORY/KNOWLEDGE/Ideas", `migrated_${slug}_mod12345.md`);
    expect(existsSync(filePath)).toBe(true);
    const body = readFileSync(filePath, "utf-8");
    expect(body).toContain("title: notes.md:My Section!");
    expect(body).toContain("type: idea");
    expect(body).toContain(`created: ${NOW_DATE}`);
    expect(body).toContain('source: "/src/notes.md"');
    // audit records the modified target + full timestamp
    const audit = readAudit();
    expect(audit[0].target_path).toBe(filePath);
    expect(audit[0].proposed_target).toBe("MEMORY/KNOWLEDGE/Ideas");
    expect(audit[0].status).toBe("modified");
    expect(audit[0].committed_at).toBe(NOW_ISO);
  });
});

// ─── Commit branches ───

describe("commit branches", () => {
  test("feedback branch writes a new file with feedback frontmatter", () => {
    const p = proposal({ id: "fed12345678", proposed_target: "memory/feedback" });
    expect(commitProposal(ctx, p)).toBe(true);

    const slug = slugify("notes.md:My Section!", 40);
    const dir = join(ctx.home, ".claude", "projects", "${HARNESS_USER_DIR}", "memory");
    const filePath = join(dir, `feedback_migrated_${slug}_fed12345.md`);
    expect(existsSync(filePath)).toBe(true);
    const body = readFileSync(filePath, "utf-8");
    expect(body).toContain(`name: ${slug}`);
    expect(body).toContain("description: Migrated from /src/notes.md");
    expect(body).toContain("type: feedback");
    expect(body).toContain(`created: ${NOW_DATE}`);
    expect(body).toContain("The full body of the chunk.");
  });

  test("knowledge branch derives type from the last path segment (singularized)", () => {
    const p = proposal({ id: "know1234abcd", proposed_target: "MEMORY/KNOWLEDGE/People" });
    expect(commitProposal(ctx, p)).toBe(true);
    const slug = slugify("notes.md:My Section!", 40);
    const filePath = join(ctx.paiDir, "MEMORY/KNOWLEDGE/People", `migrated_${slug}_know1234.md`);
    const body = readFileSync(filePath, "utf-8");
    expect(body).toContain("type: people"); // "People" → "people" → strip trailing s → "people"
  });

  test("UNCLEAR proposal refuses to commit", () => {
    const p = proposal({ proposed_target: "UNCLEAR" });
    expect(commitProposal(ctx, p)).toBe(false);
    expect(existsSync(ctx.committedLog)).toBe(false);
  });

  test("append branch fails when target file is absent (chunk not lost)", () => {
    const p = proposal({ proposed_target: "TELOS/WISDOM.md" });
    expect(commitProposal(ctx, p)).toBe(false);
  });
});

// ─── Bulk approve: failed commits stay pending ───

describe("cmdApproveAll", () => {
  test("commits committable proposals, keeps failed ones pending, skips UNCLEAR", () => {
    // WISDOM target does not exist → append fails → stays pending.
    // Knowledge target creates a new file → commits.
    const good = proposal({ id: "good1111aaaa", proposed_target: "MEMORY/KNOWLEDGE/Ideas" });
    const failing = proposal({ id: "fail2222bbbb", proposed_target: "TELOS/WISDOM.md" });
    const unclear = proposal({ id: "uncl3333cccc", proposed_target: "UNCLEAR" });
    saveQueue(ctx, [good, failing, unclear]);

    cmdApproveAll(ctx);

    const remaining = loadQueue(ctx);
    const ids = remaining.map((p) => p.id).sort();
    // good committed & dropped; failing + unclear remain
    expect(ids).toEqual(["fail2222bbbb", "uncl3333cccc"]);
    const audit = readAudit();
    expect(audit.length).toBe(1);
    expect(audit[0].id).toBe("good1111aaaa");
  });
});

// ─── main() dispatch ladder ───

describe("main dispatch", () => {
  test("unknown / no command → usage, exit 0", () => {
    expect(main([], ctx)).toBe(0);
    expect(main(["--wat"], ctx)).toBe(0);
  });

  test("--modify with a valueless trailing --target → exit 1", () => {
    // Faithful to the source's indexOf(--target) quirk: exit 1 fires only when --target is
    // present but has no following value (trailing). Byte-preserved from MigrateApprove.ts:284-289.
    expect(main(["--modify", "abc", "--target"], ctx)).toBe(1);
  });

  test("--review routes and exits 0", () => {
    saveQueue(ctx, [proposal()]);
    expect(main(["--review"], ctx)).toBe(0);
  });

  test("--reset clears the queue and exits 0", () => {
    saveQueue(ctx, [proposal(), proposal({ id: "second" })]);
    expect(main(["--reset"], ctx)).toBe(0);
    expect(loadQueue(ctx)).toEqual([]);
  });

  test("--approve via main commits (precedence over --approve-all absence)", () => {
    const targetPath = join(ctx.paiDir, "TELOS", "WISDOM.md");
    mkdirSync(join(ctx.paiDir, "TELOS"), { recursive: true });
    writeFileSync(targetPath, "seed\n");
    saveQueue(ctx, [proposal({ id: "mainapp1234" })]);
    expect(main(["--approve", "mainapp1"], ctx)).toBe(0);
    expect(loadQueue(ctx)).toEqual([]);
  });
});

// ─── defaultCtx sanity (no real ~/.claude read) ───

describe("defaultCtx", () => {
  test("derives queue + committed paths under PAI dir", () => {
    const c = defaultCtx(NOW);
    expect(c.queueFile.endsWith(join("MEMORY", "MIGRATION", "migration-proposals.jsonl"))).toBe(true);
    expect(c.committedLog.endsWith(join("MEMORY", "MIGRATION", "committed.jsonl"))).toBe(true);
    expect(c.now).toBe(NOW);
  });
});
