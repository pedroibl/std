import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  annotation,
  collapse,
  defaultPaths,
  existingPaths,
  isWorkTree,
  main,
  scan,
  walk,
  type Paths,
} from "./write-checkpoint-repos";

/** A throwaway root dir, cleaned up after `fn` runs. Canonicalized (realpath) up front — on macOS
 * `tmpdir()` lives under a `/var` symlink to `/private/var`, and the tool canonicalizes discovered
 * repo paths (`canonical()`), so a non-canonical `home` would make `collapse()`'s prefix match fail
 * for reasons that have nothing to do with the tool's own logic. */
function inTmpRoot(fn: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "std-wcr-")));
  try {
    fn(root);
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failure */
    }
  }
}

/** Init a git repo at `dir` (creating parents), optionally with one commit. */
function initRepo(dir: string, opts?: { commit?: boolean }): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
  if (opts?.commit) {
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "init"], { stdio: "ignore" });
  }
}

describe("isWorkTree — std/git routing", () => {
  test("true for a real work tree", () => {
    inTmpRoot((root) => {
      initRepo(root);
      expect(isWorkTree(root)).toBe(true);
    });
  });

  test("false for a plain (non-git) directory", () => {
    inTmpRoot((root) => {
      expect(isWorkTree(root)).toBe(false);
    });
  });

  test("false for a bare repo (no work tree)", () => {
    inTmpRoot((root) => {
      execFileSync("git", ["-C", root, "init", "-q", "--bare"], { stdio: "ignore" });
      expect(isWorkTree(root)).toBe(false);
    });
  });
});

describe("walk — repo-root discovery, stop-at-match semantics", () => {
  test("finds a single repo at the root", () => {
    inTmpRoot((root) => {
      const repo = join(root, "repoA");
      initRepo(repo);
      const found: string[] = [];
      walk(root, 4, found);
      expect(found).toEqual([repo]);
    });
  });

  test("does NOT descend into a matched repo — a nested repo inside it is never found", () => {
    inTmpRoot((root) => {
      const outer = join(root, "outer");
      const inner = join(outer, "nested", "inner");
      initRepo(outer);
      initRepo(inner); // a repo living inside another repo's tree (submodule-shaped)
      const found: string[] = [];
      walk(root, 6, found);
      expect(found).toEqual([outer]); // inner is never visited — walk stopped at outer's `.git`
    });
  });

  test("skips a SKIP-listed directory (node_modules) even though it holds a nested repo", () => {
    inTmpRoot((root) => {
      const hidden = join(root, "node_modules", "some-pkg");
      initRepo(hidden);
      const found: string[] = [];
      walk(root, 4, found);
      expect(found).toEqual([]);
    });
  });

  test("respects maxDepth — a repo deeper than depth is not found", () => {
    inTmpRoot((root) => {
      const deep = join(root, "a", "b", "c", "d", "repo");
      initRepo(deep);
      const found: string[] = [];
      walk(root, 1, found); // only 1 level of descent — repo is 5 levels down
      expect(found).toEqual([]);
    });
  });
});

describe("annotation — format shape (branch · remote · commit)", () => {
  test("no-commit repo reports 'no commits' and a branch or 'detached'", () => {
    inTmpRoot((root) => {
      initRepo(root);
      const line = annotation(root, false);
      expect(line.startsWith("# ")).toBe(true);
      expect(line).toContain("no commits");
      expect(line).toContain("(no remote)");
    });
  });

  test("committed repo reports a relative-time commit string, not 'no commits'", () => {
    inTmpRoot((root) => {
      initRepo(root, { commit: true });
      const line = annotation(root, false);
      expect(line).not.toContain("no commits");
    });
  });

  test("--dirty appends a clean/dirty marker", () => {
    inTmpRoot((root) => {
      initRepo(root, { commit: true });
      const clean = annotation(root, true);
      expect(clean).toContain("✓ clean");
      writeFileSync(join(root, "untracked.txt"), "x");
      const dirty = annotation(root, true);
      expect(dirty).toContain("✗ dirty");
    });
  });
});

describe("collapse — home-relative path rendering (pure)", () => {
  test("home itself → '~'", () => {
    expect(collapse("/Users/pedro", "/Users/pedro")).toBe("~");
  });
  test("a child of home → '~/…'", () => {
    expect(collapse("/Users/pedro/Dev/std", "/Users/pedro")).toBe("~/Dev/std");
  });
  test("outside home → unchanged", () => {
    expect(collapse("/opt/other", "/Users/pedro")).toBe("/opt/other");
  });
});

describe("existingPaths — ~/ and $HOME expansion, merge source", () => {
  test("missing file → []", () => {
    inTmpRoot((root) => {
      const paths: Paths = { home: root, staged: join(root, "staged.txt"), live: join(root, ".claude", "live.txt") };
      expect(existingPaths(paths)).toEqual([]);
    });
  });

  test("reads LIVE over STAGED, expands '~/' and blank/# lines are dropped", () => {
    inTmpRoot((root) => {
      mkdirSync(join(root, ".claude"), { recursive: true });
      const live = join(root, ".claude", "live.txt");
      const staged = join(root, "staged.txt");
      writeFileSync(staged, "~/should-not-be-read\n");
      writeFileSync(live, "# a comment\n\n~/Dev/repoX\n$HOME/Dev/repoY\n/abs/repoZ\n");
      const paths: Paths = { home: root, staged, live };
      expect(existingPaths(paths)).toEqual([
        join(root, "Dev", "repoX"),
        join(root, "Dev", "repoY"),
        "/abs/repoZ",
      ]);
    });
  });
});

describe("scan — end-to-end discovery + rendered output", () => {
  test("finds a work tree, skips a non-worktree '.git' dir, renders header + body", () => {
    inTmpRoot((root) => {
      const good = join(root, "good-repo");
      // A directory carrying a `.git` MARKER so `walk()` treats it as a candidate repo root (its
      // discovery test is purely "does a `.git` entry exist"), but the marker is garbage — not a real
      // gitdir pointer — so `git -C dir rev-parse --is-inside-work-tree` fails and `isWorkTree` filters
      // it out post-discovery. (A real `git init --bare` dir has NO `.git` entry at all — HEAD/objects/
      // refs/ sit directly at its root — so `walk()` never even surfaces it as a candidate; this is the
      // realistic way `skippedBare` gets exercised: a broken/orphaned `.git` reference.)
      const broken = join(root, "broken-repo");
      mkdirSync(broken, { recursive: true });
      writeFileSync(join(broken, ".git"), "not a real gitdir pointer");
      initRepo(good);
      const paths = defaultPaths(root);
      const result = scan({
        roots: [root],
        maxDepth: 4,
        merge: false,
        dirty: false,
        annotate: false,
        paths,
      });
      expect(result.repos).toEqual([good]);
      expect(result.skippedBare).toBe(1);
      expect(result.output).toContain("checkpoint-repos.txt — ISC checkpoint allowlist");
      expect(result.output).toContain("1 work tree  (1 bare repo skipped)");
      expect(result.output).toContain(collapseRelative(good, root));
    });
  });

  function collapseRelative(p: string, home: string): string {
    return p.startsWith(home + "/") ? "~/" + p.slice(home.length + 1) : p;
  }
});

describe("main — CLI: dry-run writes nothing, real run writes atomically + backs up", () => {
  test("--dry-run performs no filesystem write", () => {
    inTmpRoot((root) => {
      const repo = join(root, "repo1");
      initRepo(repo);
      const paths: Paths = { home: root, staged: join(root, "checkpoint-repos.txt"), live: join(root, ".claude", "checkpoint-repos.txt") };
      const code = main(["--dry-run", "--no-annotate", repo], paths);
      expect(code).toBe(0);
      expect(existsSync(paths.staged)).toBe(false); // never created
    });
  });

  test("a real run writes the allowlist; a second run backs up the first to .bak", () => {
    inTmpRoot((root) => {
      const repo = join(root, "repo1");
      initRepo(repo);
      const paths: Paths = { home: root, staged: join(root, "checkpoint-repos.txt"), live: join(root, ".claude", "checkpoint-repos.txt") };

      const code1 = main(["--no-annotate", repo], paths);
      expect(code1).toBe(0);
      const first = readFileSync(paths.staged, "utf-8");
      expect(first).toContain(collapseRel(repo, root));
      expect(existsSync(paths.staged + ".bak")).toBe(false); // no prior file yet on first run

      const code2 = main(["--no-annotate", repo], paths);
      expect(code2).toBe(0);
      const bak = readFileSync(paths.staged + ".bak", "utf-8");
      expect(bak).toBe(first); // second run backed up the first run's exact bytes
    });
  });

  test("--merge keeps a repo outside the scanned roots", () => {
    inTmpRoot((root) => {
      const inRoot = join(root, "in-root");
      const outside = join(root, "elsewhere", "outside-repo");
      initRepo(inRoot);
      initRepo(outside);

      const paths: Paths = { home: root, staged: join(root, "checkpoint-repos.txt"), live: join(root, ".claude", "checkpoint-repos.txt") };
      // Seed LIVE with the outside repo (as if a prior run or hand-edit added it).
      mkdirSync(join(root, ".claude"), { recursive: true });
      writeFileSync(paths.live, `${outside}\n`);

      const code = main(["--merge", "--no-annotate", join(root, "in-root")], paths);
      expect(code).toBe(0);
      const written = readFileSync(paths.staged, "utf-8");
      expect(written).toContain(collapseRel(inRoot, root));
      expect(written).toContain(collapseRel(outside, root));
    });
  });

  test("main preserves first positional root when no flags are passed", () => {
    inTmpRoot((root) => {
      const repo = join(root, "repo1");
      initRepo(repo);
      const paths: Paths = { home: root, staged: join(root, "checkpoint-repos.txt"), live: join(root, ".claude", "checkpoint-repos.txt") };

      const code = main([repo], paths);
      expect(code).toBe(0);
      const written = readFileSync(paths.staged, "utf-8");
      expect(written).toContain(collapseRel(repo, root));
    });
  });

  function collapseRel(p: string, home: string): string {
    return p.startsWith(home + "/") ? "~/" + p.slice(home.length + 1) : p;
  }
});

