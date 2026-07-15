import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  type GitRunner,
  commitInRepo,
  expandPath,
  hasChanges,
  isGitRepo,
  loadState,
  sanitizeMessage,
  saveState,
} from "./CheckpointPerISC.hook";

const HOOK = `${import.meta.dir}/CheckpointPerISC.hook.ts`;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

// ── git FAIL-SOFT RECONSTRUCTION (validator) — isGitRepo/hasChanges from output length, via a fake seam ──
describe("isGitRepo / hasChanges — success re-derived from output length (fail-soft std/git)", () => {
  const okRepo: GitRunner = (_repo, args) =>
    args[0] === "rev-parse" ? ".git" : args[0] === "status" ? " M file.ts\n" : "";
  const failSoft: GitRunner = () => ""; // std/git returns "" on ANY failure — never throws

  test("isGitRepo: non-empty rev-parse output → true", () => {
    expect(isGitRepo("/x", okRepo)).toBe(true);
  });
  test("isGitRepo: empty output (fail-soft) → false, never throws", () => {
    expect(isGitRepo("/x", failSoft)).toBe(false);
  });
  test("hasChanges: porcelain output present → true", () => {
    expect(hasChanges("/x", okRepo)).toBe(true);
  });
  test("hasChanges: empty porcelain (clean OR failed) → false", () => {
    expect(hasChanges("/x", failSoft)).toBe(false);
    expect(hasChanges("/x", () => "")).toBe(false);
  });
});

// ── commitInRepo CARVE-OUT (validator E1 — the silent-bug hazard) ────────────────────────────────────
describe("commitInRepo — a failed commit returns null, NEVER a stale pre-existing HEAD sha", () => {
  test("success path returns the fresh sha from rev-parse HEAD", () => {
    const run: GitRunner = (_repo, args) => (args[0] === "rev-parse" ? "newsha123\n" : "");
    expect(commitInRepo("/repo", "ISC-1", "slug", "did a thing", run)).toBe("newsha123");
  });

  test("a THROWING commit (the fail-soft hazard) → null, so the ISC is NOT wrongly marked committed", () => {
    // Simulates: `git commit` fails. Under a fail-soft runner the failure would be silent and a following
    // `rev-parse HEAD` would hand back the PRE-EXISTING sha (a false "success"). The throwing runner makes
    // the failure surface as an exception → null. If this returned the stale sha, the bug would be live.
    const staleHead = "OLDSHA_PREEXISTING";
    const run: GitRunner = (_repo, args) => {
      if (args[0] === "commit") throw new Error("nothing to commit / hook failed");
      if (args[0] === "rev-parse") return staleHead; // would be returned if the throw were swallowed
      return "";
    };
    expect(commitInRepo("/repo", "ISC-1", "slug", "desc", run)).toBeNull();
  });

  test("commit subject uses the verbatim ISC id + sanitized description", () => {
    const seen: string[][] = [];
    const run: GitRunner = (_repo, args) => {
      seen.push(args);
      return args[0] === "rev-parse" ? "sha" : "";
    };
    commitInRepo("/repo", "ISC-2", "my-slug", "fix the `thing` with $VAR", run);
    const commitArgs = seen.find((a) => a[0] === "commit")!;
    expect(commitArgs).toContain("ISC-2 (my-slug): fix the thing with VAR"); // backticks/$ stripped
    expect(commitArgs).toContain("--no-verify");
    expect(commitArgs).toContain("--no-gpg-sign");
  });
});

// ── sanitizeMessage KEEP-VERBATIM (validators E2 + ENH-3 — NOT core.collapse/truncate) ────────────────
describe("sanitizeMessage — collapse + strip backticks/$ + trim LAST + hard slice(200), no ellipsis", () => {
  test("collapses whitespace, strips ` and $, trims after the strip", () => {
    expect(sanitizeMessage("  hello   `world`  $x  ")).toBe("hello world x");
  });
  test("hard slice at 200 chars — NO ellipsis (core.truncate would append '...')", () => {
    const out = sanitizeMessage("a".repeat(500));
    expect(out.length).toBe(200);
    expect(out.endsWith("...")).toBe(false);
  });
});

// ── expandPath (DEFER — kept caller-local) ───────────────────────────────────────────────────────────
describe("expandPath — ~ / $HOME expansion (DEFER, verbatim)", () => {
  test("expands ~/, bare ~, and $HOME", () => {
    expect(expandPath("~/foo")).toBe(join(homedir(), "foo"));
    expect(expandPath("~")).toBe(homedir());
    expect(expandPath("$HOME/bar")).toBe(homedir() + "/bar");
  });
  test("leaves an absolute path untouched", () => {
    expect(expandPath("/abs/path")).toBe("/abs/path");
  });
});

// ── loadState / saveState — fsx.loadJson + fsx.atomicWrite round-trip ─────────────────────────────────
describe("loadState / saveState — JSON sidecar via fsx", () => {
  test("missing file → empty state", () => {
    const dir = tempDir("cp-state-");
    expect(loadState(join(dir, "nope.json"))).toEqual({ committed_iscs: [], last_commit_sha: {} });
  });

  test("round-trips a written state", () => {
    const dir = tempDir("cp-state-");
    const f = join(dir, "state.json");
    const state = { committed_iscs: ["ISC-1"], last_commit_sha: { "/r": "sha1" } };
    saveState(f, state);
    expect(existsSync(f)).toBe(true);
    expect(loadState(f)).toEqual(state);
  });

  test("malformed JSON → silent reset to empty (shape guards re-applied)", () => {
    const dir = tempDir("cp-state-");
    const f = join(dir, "bad.json");
    writeFileSync(f, "{not valid json");
    expect(loadState(f)).toEqual({ committed_iscs: [], last_commit_sha: {} });
  });

  test("partial/typo'd fields normalize via the shape guards", () => {
    const dir = tempDir("cp-state-");
    const f = join(dir, "partial.json");
    writeFileSync(f, JSON.stringify({ committed_iscs: "not-an-array", last_commit_sha: 42 }));
    expect(loadState(f)).toEqual({ committed_iscs: [], last_commit_sha: {} });
  });
});

// ── Fire the dormant hook via stdin pipe (door resolves + fail-open envelope) ─────────────────────────
// SAFETY: every fire uses an ALL-UNCHECKED ISA (or a non-matching path), so `newlyChecked` is empty and the
// allowlist loop is NEVER entered — no real repo is ever committed to, regardless of ~/.claude/checkpoint-
// repos.txt. The commit path itself is proven hermetically above with the fake runner.
async function fire(input: string, env?: Record<string, string>): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

describe("fail-OPEN posture — null stdin → exit 0 + door resolves", () => {
  test("empty stdin → exit 0", async () => {
    expect((await fire("")).code).toBe(0);
  });
  test("malformed JSON → exit 0, std/* imports resolved", async () => {
    const { code, stderr } = await fire("{not json");
    expect(code).toBe(0);
    expect(stderr).not.toContain("Cannot find module");
  });
});

describe("dormant-hook runtime path — an all-unchecked ISA is parsed but commits nothing", () => {
  test(
    "reaches parseCriteriaList (collapsed facade) + loadState (fsx), no state written, no crash",
    async () => {
      const root = tempDir("cp-fire-");
      const paiDir = join(root, "PAI");
      const slug = "cp-sess";
      const slugDir = join(paiDir, "MEMORY", "WORK", slug);
      mkdirSync(slugDir, { recursive: true });
      const isaPath = join(slugDir, "ISA.md");
      writeFileSync(
        isaPath,
        `---\nisa: true\nslug: ${slug}\nphase: build\n---\n\n## ISC Criteria\n- [ ] ISC-1: not done\n- [ ] ISC-2: also not done\n`,
      );
      const input = JSON.stringify({ tool_input: { file_path: isaPath } });
      const { code, stderr } = await fire(input, { PAI_DIR: paiDir });
      expect(code).toBe(0);
      expect(stderr).not.toContain("Cannot find module");
      // newlyChecked empty → returns before saveState → no sidecar written (idempotency intact).
      expect(existsSync(join(slugDir, ".checkpoint-state.json"))).toBe(false);
    },
    20000,
  );
});
