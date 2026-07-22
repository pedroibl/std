import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { atomicWrite, ensureDir, exists, loadJson, readIfExists, resolveFrameworkDir, saveJson, statMtime, walkFiles } from "./index";

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

  test("leaves no stray temp sibling on success (name-agnostic — readdir the dir, not a fixed name)", () => {
    inTmp((dir) => {
      // Write into a dedicated subdir so the assertion can be "exactly the target, nothing else" — this
      // catches a stray temp under ANY name (the per-write-unique name is no longer a fixed `${path}.tmp`).
      const sub = join(dir, "out");
      const path = join(sub, "out.txt");
      atomicWrite(path, "x");
      expect(readdirSync(sub)).toEqual(["out.txt"]);
    });
  });
});

describe("atomicWrite — concurrency-safe per-write-unique temp (Story 18.1)", () => {
  test("two+ concurrent writers on ONE path → final file is exactly one full payload, never torn, no temp left (AC3)", async () => {
    // The real risk this story fixes is CROSS-PROCESS: `--watch` (Story 8.3) made two resident std writers
    // on one target dir realistic. Single-threaded sync calls cannot actually interleave, so genuine
    // concurrency needs real processes. Several children each atomicWrite a DISTINCT large payload to the
    // same path at once; with a per-write-unique temp the invariant holds under every interleaving.
    const dir = mkdtempSync(join(tmpdir(), "std-fsx-conc-"));
    try {
      const targetDir = join(dir, "out");
      mkdirSync(targetDir, { recursive: true });
      const path = join(targetDir, "target.txt");
      const N = 400_000; // large enough that a shared temp would tear across write() syscalls
      const labels = ["A", "B", "C", "D"];
      const fsxIndex = join(import.meta.dir, "index.ts");
      const runner = join(dir, "runner.ts"); // lives OUTSIDE targetDir, so it never pollutes the readdir
      writeFileSync(
        runner,
        `import { atomicWrite } from ${JSON.stringify(fsxIndex)};\n` +
          `atomicWrite(process.argv[2], process.argv[3].repeat(${N}));\n`,
      );
      const procs = labels.map((label) => Bun.spawn(["bun", runner, path, label]));
      const codes = await Promise.all(procs.map((p) => p.exited));
      // (c) Neither call throws — a shared temp would surface as an ENOENT on the rename (one writer
      // deleting another's in-flight temp) → a nonzero exit.
      expect(codes).toEqual(labels.map(() => 0));
      const final = readFileSync(path, "utf-8");
      // (a) The whole file equals exactly ONE payload in full — never an interleaved/torn mix.
      expect(final.length).toBe(N);
      expect(labels.map((label) => label.repeat(N)).includes(final)).toBe(true);
      // (b) No `*.tmp*` sibling remains in the target dir.
      expect(readdirSync(targetDir)).toEqual(["target.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("scratch proof: a FIXED shared temp tears/collides under interleave; a per-writer UNIQUE temp does not (AC3 mutation proof)", () => {
    // Deterministic (no timing): interleave two writers as A.write, B.write, A.rename, B.rename using LOCAL
    // reimplementations. This proves the DESIGN difference crisply; the shipped code is proven by the real
    // concurrent test above. It must NOT weaken that shipped test.
    inTmp((dir) => {
      // --- OLD behavior: one FIXED shared temp name for both writers ---
      const fixedPath = join(dir, "fixed.txt");
      const sharedTmp = `${fixedPath}.tmp`;
      writeFileSync(sharedTmp, "AAAA"); // writer A stages
      writeFileSync(sharedTmp, "BBBB"); // writer B stages — OVERWRITES A's temp (they share the name)
      renameSync(sharedTmp, fixedPath); // A "commits" — but moves B's bytes: A silently wrote the wrong content
      expect(readFileSync(fixedPath, "utf-8")).toBe("BBBB"); // A intended "AAAA" — corruption of intent
      // B "commits" — its temp is already gone (A consumed the shared file): the second writer throws ENOENT.
      expect(() => renameSync(sharedTmp, fixedPath)).toThrow();

      // --- FIX: each writer stages its OWN per-write-unique temp ---
      const uniquePath = join(dir, "unique.txt");
      const tmpA = `${uniquePath}.tmp.1.0`;
      const tmpB = `${uniquePath}.tmp.1.1`;
      writeFileSync(tmpA, "AAAA"); // A stages its own temp
      writeFileSync(tmpB, "BBBB"); // B stages its own temp — no collision
      renameSync(tmpA, uniquePath); // A commits its own bytes
      expect(readFileSync(uniquePath, "utf-8")).toBe("AAAA"); // A wrote exactly what it intended
      renameSync(tmpB, uniquePath); // B commits its own bytes — atomic last-writer-wins, no throw
      expect(readFileSync(uniquePath, "utf-8")).toBe("BBBB");
      // No temp siblings remain for either writer.
      expect(readdirSync(dir).filter((f) => f.startsWith("unique.txt.tmp"))).toEqual([]);
    });
  });

  test("cleans up the temp sibling when the write fails, and still throws (AC4 fail-loud + cleanup-on-throw)", () => {
    inTmp((dir) => {
      const targetDir = join(dir, "out");
      mkdirSync(targetDir, { recursive: true });
      // Make the TARGET an existing directory: ensureDir(dirname) succeeds and the temp write succeeds, but
      // renameSync(tmp, <existing dir>) fails (EISDIR/ENOTDIR) — the "temp created, rename fails" path that
      // would LEAK a temp without cleanup.
      const path = join(targetDir, "target");
      mkdirSync(path, { recursive: true });
      expect(() => atomicWrite(path, "x")).toThrow(); // fail-loud: the real I/O error surfaces
      // cleanup-on-throw: the failed write left no `*.tmp*` sibling behind (only the target dir remains).
      expect(readdirSync(targetDir).filter((f) => f.includes(".tmp"))).toEqual([]);
    });
  });
});

describe("statMtime — fail-soft mtime read (0 on absent/unreadable)", () => {
  test("returns the real mtimeMs for an existing file", () => {
    inTmp((dir) => {
      const path = join(dir, "f.txt");
      writeFileSync(path, "x");
      const mtime = statMtime(path);
      expect(mtime).toBeGreaterThan(0);
      expect(mtime).toBe(statSync(path).mtimeMs);
    });
  });

  test("a more-recently-written file has a >= mtime (sorts newer)", () => {
    inTmp((dir) => {
      const older = join(dir, "older.txt");
      writeFileSync(older, "a");
      const omt = statMtime(older);
      const newer = join(dir, "newer.txt");
      writeFileSync(newer, "b");
      // same-second writes can tie at ms granularity; never older
      expect(statMtime(newer)).toBeGreaterThanOrEqual(omt);
    });
  });

  test("returns 0 for a missing path (fail-soft → sorts last)", () => {
    inTmp((dir) => {
      expect(statMtime(join(dir, "does-not-exist.txt"))).toBe(0);
    });
  });

  test("returns 0 for a broken symlink (unstatable → fail-soft)", () => {
    inTmp((dir) => {
      const link = join(dir, "dangling");
      symlinkSync(join(dir, "no-target"), link);
      expect(statMtime(link)).toBe(0);
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

describe("exists — fail-soft existence probe (sibling to statMtime)", () => {
  test("returns true for an existing file", () => {
    inTmp((dir) => {
      const path = join(dir, "f.txt");
      writeFileSync(path, "x");
      expect(exists(path)).toBe(true);
    });
  });

  test("returns true for an existing directory", () => {
    inTmp((dir) => {
      expect(exists(dir)).toBe(true);
    });
  });

  test("returns false for a missing path", () => {
    inTmp((dir) => {
      expect(exists(join(dir, "nope.txt"))).toBe(false);
    });
  });

  test("returns false for a broken symlink (unstatable → fail-soft)", () => {
    inTmp((dir) => {
      const link = join(dir, "dangling");
      try {
        symlinkSync(join(dir, "no-target"), link);
      } catch {
        return; // platform can't create symlinks — skip
      }
      expect(exists(link)).toBe(false);
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

  test("prune skips a whole subtree — the directory is never descended (Story 12.3 AC4)", () => {
    inTmp((dir) => {
      mkdirSync(join(dir, "keep"), { recursive: true });
      mkdirSync(join(dir, "node_modules", "deep"), { recursive: true });
      writeFileSync(join(dir, "keep", "a.md"), "");
      writeFileSync(join(dir, "node_modules", "b.md"), "");
      writeFileSync(join(dir, "node_modules", "deep", "c.md"), "");
      const found = walkFiles(dir, undefined, {
        prune: (d) => d.split("/").pop() === "node_modules",
      }).sort();
      expect(found).toEqual([join(dir, "keep", "a.md")]);
    });
  });

  test("prune composes with the file predicate", () => {
    inTmp((dir) => {
      mkdirSync(join(dir, "skipme"), { recursive: true });
      writeFileSync(join(dir, "keep.md"), "");
      writeFileSync(join(dir, "keep.txt"), "");
      writeFileSync(join(dir, "skipme", "x.md"), "");
      const found = walkFiles(dir, (p) => p.endsWith(".md"), {
        prune: (d) => d.endsWith("/skipme"),
      });
      expect(found).toEqual([join(dir, "keep.md")]);
    });
  });

  test("no prune (opts omitted) descends everything, as before", () => {
    inTmp((dir) => {
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "sub", "x.md"), "");
      expect(walkFiles(dir)).toEqual([join(dir, "sub", "x.md")]);
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

describe("resolveFrameworkDir — two-axis probe, fail-soft to the preferred default (AD-9.3 keystone)", () => {
  // Framework-dir axis (axis 2): under a resolved claude-home, first-existing framework dir wins.
  test("resolves LIFEOS when only <home>/.claude/LIFEOS exists", () => {
    inTmp((dir) => {
      mkdirSync(join(dir, ".claude", "LIFEOS"), { recursive: true });
      expect(resolveFrameworkDir(dir)).toBe(join(dir, ".claude", "LIFEOS"));
    });
  });

  test("resolves PAI (fallback order) when only <home>/.claude/PAI exists", () => {
    inTmp((dir) => {
      mkdirSync(join(dir, ".claude", "PAI"), { recursive: true });
      expect(resolveFrameworkDir(dir)).toBe(join(dir, ".claude", "PAI"));
    });
  });

  test("LIFEOS wins over PAI when BOTH exist (first-exists precedence)", () => {
    inTmp((dir) => {
      mkdirSync(join(dir, ".claude", "LIFEOS"), { recursive: true });
      mkdirSync(join(dir, ".claude", "PAI"), { recursive: true });
      expect(resolveFrameworkDir(dir)).toBe(join(dir, ".claude", "LIFEOS"));
    });
  });

  // Claude-home axis (axis 1): the second candidate `.config/claude` is probed when `.claude` is absent.
  test("resolves via the second claude-home candidate when <home>/.claude is absent", () => {
    inTmp((dir) => {
      mkdirSync(join(dir, ".config", "claude", "LIFEOS"), { recursive: true });
      // no <dir>/.claude at all — axis 1 must fall through to .config/claude
      expect(resolveFrameworkDir(dir)).toBe(join(dir, ".config", "claude", "LIFEOS"));
    });
  });

  test("fresh tree → <home>/.claude/LIFEOS (first-of-each-axis default), no throw", () => {
    inTmp((dir) => {
      expect(resolveFrameworkDir(dir)).toBe(join(dir, ".claude", "LIFEOS"));
    });
  });

  test("partial tree — <home>/.claude exists but no framework dir → <home>/.claude/LIFEOS", () => {
    inTmp((dir) => {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      expect(resolveFrameworkDir(dir)).toBe(join(dir, ".claude", "LIFEOS"));
    });
  });

  test("never returns empty on a fresh tree", () => {
    inTmp((dir) => {
      expect(resolveFrameworkDir(dir)).not.toBe("");
    });
  });

  // Custom candidate lists are honored (the D4 injection contract — nothing is baked).
  test("custom frameworkDirs list — only [\"PAI\"] resolves/falls back to PAI", () => {
    inTmp((dir) => {
      // fresh tree, custom framework list → falls back to the first custom candidate
      expect(resolveFrameworkDir(dir, undefined, ["PAI"])).toBe(join(dir, ".claude", "PAI"));
      // and when it exists it is found
      mkdirSync(join(dir, ".claude", "PAI"), { recursive: true });
      expect(resolveFrameworkDir(dir, undefined, ["PAI"])).toBe(join(dir, ".claude", "PAI"));
    });
  });

  test("custom claudeHomes list is honored", () => {
    inTmp((dir) => {
      mkdirSync(join(dir, "custom-home", "LIFEOS"), { recursive: true });
      expect(resolveFrameworkDir(dir, ["custom-home"])).toBe(join(dir, "custom-home", "LIFEOS"));
    });
  });

  test("empty candidate lists do NOT throw — fall back to the safe .claude/LIFEOS defaults (PR #40 nit)", () => {
    inTmp((dir) => {
      // With no candidates the resolver must still honor its "never throws" contract, resolving to the
      // structural defaults rather than crashing on a non-null assertion over an empty array.
      expect(() => resolveFrameworkDir(dir, [], [])).not.toThrow();
      expect(resolveFrameworkDir(dir, [], [])).toBe(join(dir, ".claude", "LIFEOS"));
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
