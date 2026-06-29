import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { atomicWrite, ensureDir, loadJson, readIfExists, saveJson, walkFiles } from "./index";

/** Run `fn` against a throwaway temp dir, cleaned up after. */
function inTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "std-fsx-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("atomicWrite — tmp+rename torn-write-proof writer (FR5 fail-loud)", () => {
  test("writes content and creates missing parent dirs", () => {
    inTmp((dir) => {
      const path = join(dir, "nested", "deep", "out.txt");
      atomicWrite(path, "hello");
      expect(readFileSync(path, "utf-8")).toBe("hello");
    });
  });

  test("overwrites an existing file with the whole new content", () => {
    inTmp((dir) => {
      const path = join(dir, "out.txt");
      atomicWrite(path, "v1");
      atomicWrite(path, "v2");
      expect(readFileSync(path, "utf-8")).toBe("v2");
    });
  });

  test("leaves no stray .tmp sibling on success", () => {
    inTmp((dir) => {
      const path = join(dir, "out.txt");
      atomicWrite(path, "x");
      expect(existsSync(`${path}.tmp`)).toBe(false);
    });
  });
});

describe("loadJson — typed read with missing/corrupt → fallback", () => {
  test("returns the parsed typed object on a valid file", () => {
    inTmp((dir) => {
      const path = join(dir, "state.json");
      writeFileSync(path, JSON.stringify({ n: 7, tags: ["a"] }));
      const got = loadJson<{ n: number; tags: string[] }>(path, { n: 0, tags: [] });
      expect(got).toEqual({ n: 7, tags: ["a"] });
    });
  });

  test("returns the fallback on a missing file", () => {
    inTmp((dir) => {
      const got = loadJson(join(dir, "absent.json"), { default: true });
      expect(got).toEqual({ default: true });
    });
  });

  test("returns the fallback on malformed JSON", () => {
    inTmp((dir) => {
      const path = join(dir, "corrupt.json");
      writeFileSync(path, "{ not valid json ");
      const got = loadJson(path, { default: true });
      expect(got).toEqual({ default: true });
    });
  });
});

describe("saveJson — atomic, pretty-printed, trailing newline", () => {
  test("round-trips through loadJson", () => {
    inTmp((dir) => {
      const path = join(dir, "round.json");
      const value = { a: 1, b: { c: [2, 3] } };
      saveJson(path, value);
      expect(loadJson<typeof value | null>(path, null)).toEqual(value);
    });
  });

  test("on-disk form is 2-space pretty-printed with a trailing newline", () => {
    inTmp((dir) => {
      const path = join(dir, "pretty.json");
      saveJson(path, { a: 1 });
      const raw = readFileSync(path, "utf-8");
      expect(raw).toBe('{\n  "a": 1\n}\n');
    });
  });

  test("creates missing parent dirs (inherits atomicWrite)", () => {
    inTmp((dir) => {
      const path = join(dir, "sub", "s.json");
      saveJson(path, { ok: true });
      expect(loadJson<{ ok: boolean } | null>(path, null)).toEqual({ ok: true });
    });
  });
});

describe("readIfExists — contents when present, null when absent", () => {
  test("returns contents when the file exists", () => {
    inTmp((dir) => {
      const path = join(dir, "f.txt");
      writeFileSync(path, "body");
      expect(readIfExists(path)).toBe("body");
    });
  });

  test("returns null when the file is absent", () => {
    inTmp((dir) => {
      expect(readIfExists(join(dir, "nope.txt"))).toBeNull();
    });
  });
});

describe("ensureDir — idempotent recursive mkdir", () => {
  test("creates a nested directory", () => {
    inTmp((dir) => {
      const target = join(dir, "x", "y", "z");
      ensureDir(target);
      expect(existsSync(target)).toBe(true);
    });
  });

  test("a second call on an existing dir does not throw", () => {
    inTmp((dir) => {
      const target = join(dir, "x");
      ensureDir(target);
      expect(() => ensureDir(target)).not.toThrow();
    });
  });
});

describe("walkFiles — recursive, predicate-filtered, files-not-dirs, cycle-safe", () => {
  test("finds nested files and returns absolute paths", () => {
    inTmp((dir) => {
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "a.md"), "");
      writeFileSync(join(dir, "sub", "b.ts"), "");
      const found = walkFiles(dir).sort();
      expect(found).toEqual([join(dir, "a.md"), join(dir, "sub", "b.ts")].sort());
    });
  });

  test("returns absolute paths even when root is given relative (AC2 contract)", () => {
    inTmp((dir) => {
      writeFileSync(join(dir, "x.md"), "");
      const rel = relative(process.cwd(), dir); // a relative root for the same dir
      const found = walkFiles(rel);
      expect(found.every(isAbsolute)).toBe(true);
      expect(found).toEqual([join(dir, "x.md")]);
    });
  });

  test("returns [] when root is a file (walks dirs, not a file handed in as root)", () => {
    inTmp((dir) => {
      const f = join(dir, "afile.txt");
      writeFileSync(f, "x");
      expect(walkFiles(f)).toEqual([]); // fail-soft: a file root is not special-cased (D2)
    });
  });

  test("returns [] when root does not exist (fail-soft)", () => {
    inTmp((dir) => {
      expect(walkFiles(join(dir, "no-such-dir"))).toEqual([]);
    });
  });

  test("returns [] when root is a broken symlink (fail-soft)", () => {
    inTmp((dir) => {
      const link = join(dir, "dangling");
      try {
        symlinkSync(join(dir, "missing-target"), link); // points at nothing
      } catch {
        return; // platform can't create symlinks — skip
      }
      expect(walkFiles(link)).toEqual([]); // realpathSync throws on the dead link → skipped
    });
  });

  test("honors the predicate", () => {
    inTmp((dir) => {
      writeFileSync(join(dir, "keep.md"), "");
      writeFileSync(join(dir, "drop.txt"), "");
      const found = walkFiles(dir, (p) => p.endsWith(".md"));
      expect(found).toEqual([join(dir, "keep.md")]);
    });
  });

  test("returns files, never directories", () => {
    inTmp((dir) => {
      mkdirSync(join(dir, "emptydir"), { recursive: true });
      writeFileSync(join(dir, "file.txt"), "");
      const found = walkFiles(dir);
      expect(found).toEqual([join(dir, "file.txt")]);
    });
  });

  test("terminates on a symlink cycle (the load-bearing case)", () => {
    inTmp((dir) => {
      const a = join(dir, "a");
      const b = join(dir, "b");
      mkdirSync(a, { recursive: true });
      mkdirSync(b, { recursive: true });
      writeFileSync(join(a, "file.txt"), "");
      // a/→b and b/loop→a forms a cycle; the realpath visited-set must break it.
      let symlinked = false;
      try {
        symlinkSync(b, join(a, "toB"));
        symlinkSync(a, join(b, "loop"));
        symlinked = true;
      } catch {
        // platform can't create symlinks — skip the cycle assertion, the rest still ran.
      }
      // The load-bearing assertion: this RETURNS rather than hanging on the cycle.
      const found = walkFiles(dir);
      if (symlinked) {
        // The realpath visited-set walks each real directory once, so the single real file is
        // enumerated EXACTLY once — reached via whichever symlink path the LIFO stack hits first.
        expect(found.filter((p) => p.endsWith("file.txt"))).toHaveLength(1);
      } else {
        // No symlinks created — plain walk still finds the file at its real path.
        expect(found).toContain(join(a, "file.txt"));
      }
    });
  });
});

describe("fail-loud contract (FR5) — the loud half of Decision 2", () => {
  // A regular file in the parent slot forces a real, non-ENOENT I/O error portably: mkdir over a file
  // throws EEXIST, and reading a path UNDER a file throws ENOTDIR. The loud helpers must surface it; the
  // soft `loadJson` must still swallow the same error and return its fallback.
  test("ensureDir re-throws when a path component is an existing file", () => {
    inTmp((dir) => {
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "i am a file, not a dir");
      expect(() => ensureDir(blocker)).toThrow();
    });
  });

  test("atomicWrite re-throws on a real I/O error (parent slot is a file)", () => {
    inTmp((dir) => {
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "file");
      // ensureDir(dirname) tries to mkdir over the existing file → surfaces, no torn write.
      expect(() => atomicWrite(join(blocker, "child.txt"), "x")).toThrow();
    });
  });

  test("saveJson inherits atomicWrite's loud contract", () => {
    inTmp((dir) => {
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "file");
      expect(() => saveJson(join(blocker, "child.json"), { a: 1 })).toThrow();
    });
  });

  test("readIfExists propagates a non-ENOENT read error (not just absence)", () => {
    inTmp((dir) => {
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "file");
      // Reading UNDER a file is ENOTDIR — a real error, not absence — so it must throw, not return null.
      expect(() => readIfExists(join(blocker, "child.txt"))).toThrow();
    });
  });

  test("loadJson SURFACES a genuine fs error (only missing/corrupt soften to fallback)", () => {
    inTmp((dir) => {
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "file");
      // Reading UNDER a file is ENOTDIR — a real fs fault, not absence or bad JSON — so it must throw,
      // not masquerade as an empty state. (Decision 2 amendment, Sourcery review 2026-06-29.)
      expect(() => loadJson(join(blocker, "child.json"), { fallback: true })).toThrow();
    });
  });
});
