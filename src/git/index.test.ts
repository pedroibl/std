import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git } from "./index";

/** Run `fn` against a throwaway, freshly-`git init`'d repo, cleaned up after. */
function inRepo(fn: (repo: string) => void): void {
  const repo = mkdtempSync(join(tmpdir(), "std-git-"));
  try {
    // init only — no commit, so no user.email/user.name config is required (keeps the test hermetic).
    execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
    fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe("git — `git -C <repo> …args`, trimmed stdout", () => {
  test("returns stdout with surrounding whitespace trimmed", () => {
    inRepo((repo) => {
      const out = git(repo, ["rev-parse", "--is-inside-work-tree"]);
      expect(out).toBe("true"); // exact — proves the trailing newline is stripped
    });
  });

  test("honours the `-C repo` parameter — two repos report their own state (no baked path)", () => {
    inRepo((a) => {
      inRepo((b) => {
        // top-level dir of each repo resolves to that repo, proving -C targets the passed path.
        const topA = git(a, ["rev-parse", "--show-toplevel"]);
        const topB = git(b, ["rev-parse", "--show-toplevel"]);
        expect(topA.length).toBeGreaterThan(0);
        expect(topB.length).toBeGreaterThan(0);
        expect(topA).not.toBe(topB);
      });
    });
  });
});

describe("git — the git-dirty use case (the byte-identical pair's need)", () => {
  test("`diff --cached --name-only` lists a staged file", () => {
    inRepo((repo) => {
      writeFileSync(join(repo, "staged.txt"), "hello");
      execFileSync("git", ["-C", repo, "add", "staged.txt"], { stdio: "ignore" });
      const out = git(repo, ["diff", "--cached", "--name-only"]);
      expect(out).toBe("staged.txt");
    });
  });
});

describe("git — fail-soft contract (never throws → empty string)", () => {
  test("a nonzero git exit (bogus subcommand) returns '' and does not throw", () => {
    inRepo((repo) => {
      const out = git(repo, ["definitely-not-a-git-subcommand"]);
      expect(out).toBe("");
    });
  });

  test("a non-existent repo path returns '' and does not throw", () => {
    const out = git("/no/such/repo/std-git-missing", ["status"]);
    expect(out).toBe("");
  });
});
