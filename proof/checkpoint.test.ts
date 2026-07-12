import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cmdList,
  cmdRollback,
  cmdShow,
  expandPath,
  findCommit,
  loadAllowlist,
  loadState,
  main,
  slugPaths,
  type Paths,
} from "./checkpoint";

/** A throwaway root dir, cleaned up after `fn` runs. */
function inTmpRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "std-checkpoint-"));
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

/** Init a git repo at `dir` with one commit whose message is the ISC grep target. */
function initRepoWithCommit(dir: string, message: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", message], { stdio: "ignore" });
}

describe("expandPath — ~/ and $HOME expansion (pure)", () => {
  test("bare '~' → home", () => {
    expect(expandPath("~", "/Users/pedro")).toBe("/Users/pedro");
  });
  test("'~/x' → home/x", () => {
    expect(expandPath("~/Dev/std", "/Users/pedro")).toBe("/Users/pedro/Dev/std");
  });
  test("'$HOME/x' → home/x", () => {
    expect(expandPath("$HOME/Dev/std", "/Users/pedro")).toBe("/Users/pedro/Dev/std");
  });
  test("absolute path passes through unchanged", () => {
    expect(expandPath("/abs/repo", "/Users/pedro")).toBe("/abs/repo");
  });
  test("blank line stays blank", () => {
    expect(expandPath("   ", "/Users/pedro")).toBe("");
  });
});

describe("loadAllowlist — comment/blank filtering + expansion", () => {
  test("missing allowlist file → []", () => {
    inTmpRoot((root) => {
      const paths: Paths = { allowlist: join(root, "none.txt"), workDir: join(root, "WORK") };
      expect(loadAllowlist(paths, root)).toEqual([]);
    });
  });

  test("skips '#' comments and blank lines, expands '~/'", () => {
    inTmpRoot((root) => {
      const allowlist = join(root, "checkpoint-repos.txt");
      writeFileSync(allowlist, "# header\n\n~/Dev/repoA\n/abs/repoB\n");
      const paths: Paths = { allowlist, workDir: join(root, "WORK") };
      expect(loadAllowlist(paths, root)).toEqual([join(root, "Dev", "repoA"), "/abs/repoB"]);
    });
  });
});

describe("findCommit — std/git grep lookup + empty-string→null guard", () => {
  test("finds a commit whose subject matches the ISC grep pattern", () => {
    inTmpRoot((root) => {
      const repo = join(root, "repo");
      initRepoWithCommit(repo, "ISC-1 (my-slug): did the thing");
      const hit = findCommit(repo, "my-slug", "ISC-1");
      expect(hit).not.toBeNull();
      expect(hit?.subject).toBe("ISC-1 (my-slug): did the thing");
      expect(hit?.sha).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  test("no matching commit → null (genuine 'no match', not a git error)", () => {
    inTmpRoot((root) => {
      const repo = join(root, "repo");
      initRepoWithCommit(repo, "unrelated commit");
      expect(findCommit(repo, "my-slug", "ISC-1")).toBeNull();
    });
  });

  test("a non-existent repo path → null (std/git fail-soft, never throws)", () => {
    expect(findCommit("/no/such/repo/std-checkpoint-missing", "my-slug", "ISC-1")).toBeNull();
  });
});

describe("loadState — fsx.loadJson + the missing-vs-malformed sentinel", () => {
  test("missing state file → null", () => {
    inTmpRoot((root) => {
      expect(loadState(join(root, "no-state.json"))).toBeNull();
    });
  });

  test("malformed JSON (file exists, doesn't parse) → null", () => {
    inTmpRoot((root) => {
      const statePath = join(root, ".checkpoint-state.json");
      writeFileSync(statePath, "{not valid json");
      expect(loadState(statePath)).toBeNull();
    });
  });

  test("valid JSON with both fields → parsed as-is", () => {
    inTmpRoot((root) => {
      const statePath = join(root, ".checkpoint-state.json");
      writeFileSync(statePath, JSON.stringify({ committed_iscs: ["ISC-1", "ISC-2"], last_commit_sha: { repoA: "deadbeef" } }));
      expect(loadState(statePath)).toEqual({
        committed_iscs: ["ISC-1", "ISC-2"],
        last_commit_sha: { repoA: "deadbeef" },
      });
    });
  });

  test("valid JSON missing fields → defaults to [] / {}", () => {
    inTmpRoot((root) => {
      const statePath = join(root, ".checkpoint-state.json");
      writeFileSync(statePath, JSON.stringify({ unrelated: true }));
      expect(loadState(statePath)).toEqual({ committed_iscs: [], last_commit_sha: {} });
    });
  });
});

describe("commands — console output + exit codes", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    logs = [];
    errs = [];
    logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  test("cmdList — no state file → silent 'no checkpoints recorded', exit 0", () => {
    inTmpRoot((root) => {
      const paths: Paths = { allowlist: join(root, "cp.txt"), workDir: join(root, "WORK") };
      const code = cmdList(paths, "my-slug");
      expect(code).toBe(0);
      expect(logs).toEqual([`no checkpoints recorded for my-slug`]);
    });
  });

  test("cmdList — malformed state → loud error, exit 1", () => {
    inTmpRoot((root) => {
      const paths: Paths = { allowlist: join(root, "cp.txt"), workDir: join(root, "WORK") };
      const { slugDir, statePath } = slugPaths(paths, "my-slug");
      mkdirSync(slugDir, { recursive: true });
      writeFileSync(statePath, "{not json");
      const code = cmdList(paths, "my-slug");
      expect(code).toBe(1);
      expect(errs).toEqual([`error: malformed state at ${statePath}`]);
    });
  });

  test("cmdList — valid state renders ISC ids + last SHA per repo", () => {
    inTmpRoot((root) => {
      const paths: Paths = { allowlist: join(root, "cp.txt"), workDir: join(root, "WORK") };
      const { slugDir, statePath } = slugPaths(paths, "my-slug");
      mkdirSync(slugDir, { recursive: true });
      writeFileSync(statePath, JSON.stringify({ committed_iscs: ["ISC-1"], last_commit_sha: { "/repo/a": "abc123" } }));
      const code = cmdList(paths, "my-slug");
      expect(code).toBe(0);
      expect(logs).toContain("Checkpoints for my-slug");
      expect(logs.some((l) => l.startsWith("ISC-1"))).toBe(true);
      expect(logs).toContain("  /repo/a: abc123");
    });
  });

  test("cmdShow — no allowlist → loud error, exit 1", () => {
    inTmpRoot((root) => {
      const paths: Paths = { allowlist: join(root, "missing.txt"), workDir: join(root, "WORK") };
      const code = cmdShow(paths, "my-slug", "ISC-1");
      expect(code).toBe(1);
      expect(errs).toEqual([`no allowlist at ${paths.allowlist}`]);
    });
  });

  test("cmdShow — finds the commit across allowlist repos", () => {
    inTmpRoot((root) => {
      const repo = join(root, "repo");
      initRepoWithCommit(repo, "ISC-1 (my-slug): did the thing");
      const allowlist = join(root, "checkpoint-repos.txt");
      writeFileSync(allowlist, `${repo}\n`);
      const paths: Paths = { allowlist, workDir: join(root, "WORK") };
      const code = cmdShow(paths, "my-slug", "ISC-1");
      expect(code).toBe(0);
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain(repo);
      expect(logs[0]).toContain("did the thing");
    });
  });

  test("cmdShow — no matching commit reports 'no commit found'", () => {
    inTmpRoot((root) => {
      const repo = join(root, "repo");
      initRepoWithCommit(repo, "unrelated");
      const allowlist = join(root, "checkpoint-repos.txt");
      writeFileSync(allowlist, `${repo}\n`);
      const paths: Paths = { allowlist, workDir: join(root, "WORK") };
      const code = cmdShow(paths, "my-slug", "ISC-1");
      expect(code).toBe(0);
      expect(logs).toEqual([`no commit found for ISC-1 in my-slug`]);
    });
  });

  test("cmdRollback — PREVIEW ONLY: prints the reset command, never executes it", () => {
    inTmpRoot((root) => {
      const repo = join(root, "repo");
      initRepoWithCommit(repo, "ISC-1 (my-slug): did the thing");
      const shaBefore = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
      const allowlist = join(root, "checkpoint-repos.txt");
      writeFileSync(allowlist, `${repo}\n`);
      const paths: Paths = { allowlist, workDir: join(root, "WORK") };

      const code = cmdRollback(paths, "my-slug", "ISC-1");
      expect(code).toBe(0);
      expect(logs.some((l) => l.includes(`git -C ${repo} reset --hard`))).toBe(true);
      expect(logs.some((l) => l.includes("no destructive operation performed"))).toBe(true);

      // HEAD is unchanged — proves nothing was actually reset.
      const shaAfter = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
      expect(shaAfter).toBe(shaBefore);
    });
  });

  test("main — no subcommand → usage printed, exit 0", () => {
    inTmpRoot((root) => {
      const paths: Paths = { allowlist: join(root, "cp.txt"), workDir: join(root, "WORK") };
      const code = main([], paths);
      expect(code).toBe(0);
      expect(logs.some((l) => l.includes("Usage:"))).toBe(true);
    });
  });

  test("main — unknown subcommand → usage printed, exit 1", () => {
    inTmpRoot((root) => {
      const paths: Paths = { allowlist: join(root, "cp.txt"), workDir: join(root, "WORK") };
      const code = main(["frobnicate"], paths);
      expect(code).toBe(1);
      expect(logs.some((l) => l.includes("Usage:"))).toBe(true);
    });
  });

  test("main — 'list' without a slug → usage printed, exit 1", () => {
    inTmpRoot((root) => {
      const paths: Paths = { allowlist: join(root, "cp.txt"), workDir: join(root, "WORK") };
      const code = main(["list"], paths);
      expect(code).toBe(1);
    });
  });

  test("main — 'list <slug>' with no state routes to cmdList", () => {
    inTmpRoot((root) => {
      const paths: Paths = { allowlist: join(root, "cp.txt"), workDir: join(root, "WORK") };
      const code = main(["list", "my-slug"], paths);
      expect(code).toBe(0);
      expect(logs).toEqual([`no checkpoints recorded for my-slug`]);
    });
  });
});
