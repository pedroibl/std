import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendAudit, appendIfMissing, appendJsonlEvent, commitRename, safeWrite, stageWrite, writeIfAbsent } from "./write";

/** Run `fn` against a throwaway temp dir, cleaned up after. */
function inTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "std-report-write-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("safeWrite — atomic stage-then-rename with a render callback (FR9)", () => {
  test("first write: render receives null and the file is created", () => {
    inTmp((dir) => {
      const path = join(dir, "out.md");
      safeWrite(path, (current) => {
        expect(current).toBeNull();
        return "# fresh";
      });
      expect(readFileSync(path, "utf8")).toBe("# fresh");
    });
  });

  test("overwrite: render receives the current content", () => {
    inTmp((dir) => {
      const path = join(dir, "out.md");
      safeWrite(path, () => "v1");
      safeWrite(path, (current) => {
        expect(current).toBe("v1");
        return `${current}\nv2`;
      });
      expect(readFileSync(path, "utf8")).toBe("v1\nv2");
    });
  });

  test("creates parent directories", () => {
    inTmp((dir) => {
      const path = join(dir, "nested", "deep", "out.md");
      safeWrite(path, () => "x");
      expect(readFileSync(path, "utf8")).toBe("x");
    });
  });

  test("leaves no leftover .tmp after a successful write", () => {
    inTmp((dir) => {
      const path = join(dir, "out.md");
      safeWrite(path, () => "done");
      expect(existsSync(`${path}.tmp`)).toBe(false);
    });
  });
});

describe("stageWrite / commitRename — the atomic pair", () => {
  test("stageWrite stages to <path>.tmp; commitRename moves it over", () => {
    inTmp((dir) => {
      const path = join(dir, "out.md");
      const tmp = stageWrite(path, "staged");
      expect(tmp).toBe(`${path}.tmp`);
      expect(existsSync(tmp)).toBe(true);
      expect(existsSync(path)).toBe(false); // not yet committed
      commitRename(tmp, path);
      expect(existsSync(tmp)).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("staged");
    });
  });
});

describe("writeIfAbsent — O_CREAT|O_EXCL create-once (FR9)", () => {
  test("writes when absent and returns true", () => {
    inTmp((dir) => {
      const path = join(dir, "once.txt");
      expect(writeIfAbsent(path, "first")).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("first");
    });
  });

  test("skips when present (returns false, content untouched) — no EEXIST throw", () => {
    inTmp((dir) => {
      const path = join(dir, "once.txt");
      writeIfAbsent(path, "first");
      expect(writeIfAbsent(path, "second")).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("first");
    });
  });
});

describe("appendIfMissing — marker-gated, idempotent (FR9)", () => {
  test("appends when the marker is absent, then no-ops", () => {
    inTmp((dir) => {
      const path = join(dir, "log.md");
      writeFileSync(path, "head\n");
      expect(appendIfMissing(path, "<!--m-->", "<!--m-->\nblock\n")).toBe(true);
      expect(appendIfMissing(path, "<!--m-->", "<!--m-->\nblock\n")).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("head\n<!--m-->\nblock\n");
    });
  });

  test("absent file counts as marker-missing — the block becomes the first content", () => {
    inTmp((dir) => {
      const path = join(dir, "new.md");
      expect(appendIfMissing(path, "MARK", "MARK first")).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("MARK first");
    });
  });
});

describe("appendAudit — JSONL, size-rotated, best-effort (FR9)", () => {
  test("appends one parseable JSONL record per call", () => {
    inTmp((dir) => {
      const path = join(dir, "audit.jsonl");
      appendAudit(path, { event: "a", n: 1 });
      appendAudit(path, { event: "b", n: 2 });
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toEqual({ event: "a", n: 1 });
      expect(JSON.parse(lines[1]!)).toEqual({ event: "b", n: 2 });
    });
  });

  test("rotates to <path>.1 once the log reaches maxBytes", () => {
    inTmp((dir) => {
      const path = join(dir, "audit.jsonl");
      appendAudit(path, { big: "x".repeat(200) }, 50); // first line already exceeds 50 bytes
      const sizeAfterFirst = statSync(path).size;
      appendAudit(path, { next: true }, 50); // over threshold → rotate, then write fresh
      expect(existsSync(`${path}.1`)).toBe(true);
      expect(statSync(`${path}.1`).size).toBe(sizeAfterFirst); // prior content rolled intact
      expect(JSON.parse(readFileSync(path, "utf8").trim())).toEqual({ next: true });
    });
  });

  test("best-effort: never throws even on an impossible target", () => {
    inTmp((dir) => {
      const path = join(dir, "out.md");
      writeFileSync(path, "i am a file");
      // out.md is a file, so out.md/audit.jsonl can't be created — appendAudit must swallow, not throw.
      expect(() => appendAudit(join(path, "audit.jsonl"), { x: 1 })).not.toThrow();
    });
  });
});

describe("appendJsonlEvent — dir+file JSONL, ensureDir-first, best-effort (Story 13.2 / P2)", () => {
  test("creates the base dir when absent, then appends a parseable JSONL record", () => {
    inTmp((dir) => {
      const base = join(dir, "MEMORY", "OBSERVABILITY"); // does not exist yet
      appendJsonlEvent(base, "events.jsonl", { event: "a", n: 1 });
      const path = join(base, "events.jsonl");
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8").trim())).toEqual({ event: "a", n: 1 });
    });
  });

  test("appends a \\n-terminated JSON.stringify(record) per call (one line each)", () => {
    inTmp((dir) => {
      appendJsonlEvent(dir, "events.jsonl", { event: "a" });
      appendJsonlEvent(dir, "events.jsonl", { event: "b" });
      const raw = readFileSync(join(dir, "events.jsonl"), "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toEqual({ event: "a" });
      expect(JSON.parse(lines[1]!)).toEqual({ event: "b" });
    });
  });

  test("rotates to <file>.1 once the log reaches maxBytes (inherited from appendAudit)", () => {
    inTmp((dir) => {
      const path = join(dir, "events.jsonl");
      appendJsonlEvent(dir, "events.jsonl", { big: "x".repeat(200) }, 50);
      const sizeAfterFirst = statSync(path).size;
      appendJsonlEvent(dir, "events.jsonl", { next: true }, 50);
      expect(existsSync(`${path}.1`)).toBe(true);
      expect(statSync(`${path}.1`).size).toBe(sizeAfterFirst);
      expect(JSON.parse(readFileSync(path, "utf8").trim())).toEqual({ next: true });
    });
  });

  test("best-effort: swallows I/O errors, never throws (dir cannot be created)", () => {
    inTmp((dir) => {
      const asFile = join(dir, "not-a-dir");
      writeFileSync(asFile, "i am a file"); // using it as `dir` makes ensureDir/append impossible
      expect(() => appendJsonlEvent(asFile, "events.jsonl", { x: 1 })).not.toThrow();
    });
  });
});
