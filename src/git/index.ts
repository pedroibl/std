// git — the Bun-edge `git -C <repo>` wrapper (AD-9 plumbing topology), sibling to `glab`.
//
// WHY: across the estate, read-only git calls are hand-rolled the same way — a checkpoint repo
// scan, a doc-dirty check, a reference-dirty check — each re-spawning `git` with the repo as `-C`.
// `git(repo, args)` is the one tested edge they collapse onto. It mirrors `glab`'s read helpers
// (sync `execFileSync`, fail-soft, never throws) — the closest analog is `glab.currentBranch()`,
// itself a `git`-CLI wrapper that returns "" on failure.
//
// CONSUMER-AGNOSTIC (D4): `repo` is the only path input and is caller-supplied. No baked repo path,
// no `~/.claude`/work-dir/root constant, no owner/slug, no env. This edge only runs git and trims.
//
// SYNC, by design: `execFileSync` like the sibling `glab` and every git consumer. NOT built on
// 10.2's async `proc.spawnCapture` — that would make this `Promise<string>` and force `await` on the
// byte-identical sync call sites. The two slices are AD-9 siblings on different sync/async axes.

import { execFileSync } from "node:child_process";

/** Safety bound so a wedged git invocation can't hang the (synchronous) caller. Not consumer identity. */
const GIT_TIMEOUT_MS = 5000;

/**
 * Run `git -C <repo> <...args>` and return its stdout, trimmed.
 *
 * **Fail-soft — never throws.** Any failure (nonzero git exit, a missing/non-repo path, `git` not on
 * PATH, or the timeout) returns `""`. Callers branch on the string; they never need a try/catch. This
 * matches the sibling `glab` read helpers and every existing git consumer, which all swallow git
 * errors. (A caller that must distinguish "git failed" from "empty output" wants a future `gitResult`
 * variant built on `core/result` — deliberately not built here, as no current caller needs it.)
 *
 * No shell: args are passed as an array, so nothing in `args` is re-parsed by a shell.
 */
export function git(repo: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"], // ignore child stdin + stderr; capture stdout only
    }).trim();
  } catch {
    // Every failure funnels here identically: nonzero git exit, missing/non-repo path, `git` not on
    // PATH (ENOENT), and the timeout. The nonzero-exit and missing-repo paths are unit-tested; the
    // timeout (no deterministic >5s hang fixture) and the ENOENT path (git is always on CI's PATH)
    // are covered structurally by this single catch rather than by a dedicated test (AC6).
    return "";
  }
}
