// glab — bun/TS wrapper around the `glab api` JSON calls a repo's Makefile needs.
//
// WHY: the Makefile used to pipe `glab api … | python3 -c "…"` inline. That is (a) Python in a
// bun/TypeScript-first estate and (b) brittle — the nested quoting + line continuations error out.
// This owns the JSON parsing in TS so each Makefile target is a one-liner.
//
// CONSUMER-AGNOSTIC (D4): the GitLab project path is never baked in. It resolves git-remote-first
// (the `origin` URL of whatever repo glab runs in), with an explicit `repo` option as override — so
// no consumer's identity lives in std source (FR13).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import { dispatch, flagValue, hasFlag, positional } from "../core/args";

interface Note {
  body?: string;
  resolvable?: boolean;
  resolved?: boolean;
  author?: { username?: string };
}
interface Discussion {
  id: string;
  notes?: Note[];
}
interface MergeRequest {
  iid: number;
}
interface Pipeline {
  id: number;
  status: string;
  sha: string;
  created_at?: string;
  web_url?: string;
}

/**
 * Parse a `glab api` stdout body into `T`. Pure (no I/O) so the fail-soft contract is unit-testable:
 * empty/whitespace → null, non-JSON → null, valid JSON → `T`. Never throws (Story 3.1).
 */
export function parseApiOutput<T = unknown>(raw: string): T | null {
  const t = raw.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

/** Run `glab api <path>` and parse the JSON body. Empty/non-JSON/failure → null — never throws. */
export function api<T = unknown>(path: string): T | null {
  let out: string;
  try {
    out = execFileSync("glab", ["api", path], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null; // glab failed (auth/network/404) — degrade, never crash the Makefile target
  }
  return parseApiOutput<T>(out);
}

/** The current git branch name, or "" if it can't be resolved (detached HEAD, not a repo). */
export function currentBranch(): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

/** Expand a leading `~/` to the user's home dir (so the Makefile never passes `~` literally). */
function expandTilde(p: string): string {
  return p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
}

/** Run `glab <args>` with inherited stdio (porcelain). Returns the child's exit code. */
function glabRun(args: string[]): number {
  try {
    execFileSync("glab", args, { stdio: "inherit" });
    return 0;
  } catch (err) {
    const status = (err as { status?: number }).status;
    return typeof status === "number" ? status : 1;
  }
}

export interface GlabOptions {
  /** GitLab project path (e.g. "owner/repo"). Optional — resolves git-remote-first when omitted. */
  repo?: string;
}

/**
 * Parse an `owner/repo` slug out of a git remote URL. Pure (Story 3.4): handles both SSH
 * (`git@host:owner/repo.git`) and HTTP(S) (`https://host/owner/repo.git`) forms, tolerates nested
 * groups, strips a trailing `.git`. Anything without an `owner/repo` shape → null.
 */
export function parseRemoteUrl(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  const ssh = u.match(/^[^@\s]+@[^:\s]+:(.+)$/); //  git@host:owner/repo.git
  const http = u.match(/^[a-z][a-z0-9+.-]*:\/\/[^/\s]+\/(.+)$/i); //  scheme://host/owner/repo.git
  const path = ssh?.[1] ?? http?.[1];
  if (!path) return null;
  const slug = path.replace(/\.git$/, "").replace(/\/+$/, "");
  return slug.includes("/") ? slug : null;
}

/** The `origin` remote URL of the cwd repo, or null if there's no git/origin. */
function gitRemoteUrl(): string | null {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the GitLab project path: explicit `opts.repo` wins; otherwise git-remote-first off
 * `origin`. No hardcoded default — std bakes in no consumer identity (D4/FR13). Null ⇒ unresolvable.
 */
export function resolveRepo(opts: GlabOptions = {}): string | null {
  if (opts.repo) return opts.repo;
  const url = gitRemoteUrl();
  return url ? parseRemoteUrl(url) : null;
}

/**
 * Run a glab subcommand. `argv` is the command + its args (i.e. process.argv.slice(2)).
 * Returns the process exit code; the wrapper does `process.exit(run(...))`.
 */
export function run(argv: string[], opts: GlabOptions = {}): number {
  const resolved = resolveRepo(opts);
  if (!resolved) {
    console.error(
      "glab: could not resolve repo — pass { repo } or run inside a repo with an 'origin' remote",
    );
    return 2;
  }
  const REPO = resolved; // narrowed to string — captured by the nested handlers below
  const ENC = encodeURIComponent(REPO); // owner/repo → owner%2Frepo

  /** The open MR iid for a branch, or null. */
  function openMrIid(branch: string): number | null {
    const mrs = api<MergeRequest[]>(
      `projects/${ENC}/merge_requests?source_branch=${branch}&state=opened`,
    );
    return mrs && mrs.length > 0 ? mrs[0].iid : null;
  }

  /** `mr-threads` — list UNRESOLVED discussion threads on this branch's open MR (the merge blockers). */
  function mrThreads(): number {
    const branch = currentBranch();
    const iid = openMrIid(branch);
    if (iid == null) {
      console.log(`no open MR for branch '${branch}'`);
      return 0;
    }
    console.log(`Unresolved threads on MR !${iid}:`);
    const discussions = api<Discussion[]>(`projects/${ENC}/merge_requests/${iid}/discussions`) ?? [];
    const open = discussions.filter((d) => {
      const n = d.notes?.[0];
      return n?.resolvable && !n.resolved;
    });
    if (open.length === 0) {
      console.log("  (none — clear to merge)");
      return 0;
    }
    for (const d of open) {
      const n = d.notes?.[0];
      const who = n?.author?.username ?? "?";
      const body = (n?.body ?? "").replace(/\s+/g, " ").slice(0, 90);
      console.log(`  [${d.id.slice(0, 8)}] ${who}: ${body}`);
    }
    return 0;
  }

  /** `pipeline [ref]` — newest pipeline for ref (default: current branch): id, status, sha. */
  function pipeline(ref?: string): number {
    const r = ref || currentBranch();
    const ps = api<Pipeline[]>(`projects/${ENC}/pipelines?ref=${r}&per_page=1`);
    if (!ps || ps.length === 0) {
      console.log(`no pipeline for ref '${r}'`);
      return 0;
    }
    const p = ps[0];
    console.log(`#${p.id}  ${p.status}  ${p.sha.slice(0, 8)}  (${r})`);
    return 0;
  }

  /** `ci-stats <ref> <sinceIso>` — success/failure rate + failed runs over a window. */
  function ciStats(ref: string, sinceIso: string): number {
    const ps =
      api<Pipeline[]>(
        `projects/${ENC}/pipelines?ref=${ref}&updated_after=${sinceIso}&per_page=100`,
      ) ?? [];
    const total = ps.length;
    if (total === 0) {
      console.log("  no runs in window");
      return 0;
    }
    const counts = new Map<string, number>();
    for (const p of ps) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
    const ok = counts.get("success") ?? 0;
    const failed = counts.get("failed") ?? 0;
    console.log(
      `  runs: ${total}   success: ${Math.round((ok / total) * 100)}%   failure: ${Math.round((failed / total) * 100)}%`,
    );
    for (const [s, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${s.padEnd(10)}: ${n}`);
    }
    console.log("  failed runs:");
    for (const p of ps.filter((x) => x.status === "failed")) {
      console.log(
        `    #${p.id}  ${(p.created_at ?? "").slice(0, 16).replace("T", " ")}  ${p.web_url ?? ""}`,
      );
    }
    return 0;
  }

  // ── issues (porcelain) ──────────────────────────────────────────────────────
  // The `glab issue …` porcelain already does the right thing; this owns it so every Makefile
  // issue target is a one-liner AND the fragile bits (leading `~/` expansion + file-existence
  // check) live in TS, not in Make's whitespace-sensitive shell.

  function issueList(all: boolean): number {
    const args = ["issue", "list", "-R", REPO, "--per-page", "40"];
    if (all) args.push("--all");
    return glabRun(args);
  }

  function issueView(num: string, web: boolean): number {
    if (!num) {
      console.error("usage: glab issue-view <number> [--web]");
      return 2;
    }
    const args = ["issue", "view", num, "-R", REPO];
    if (web) args.push("--web");
    return glabRun(args);
  }

  function issueNew(o: { title?: string; file?: string; body?: string; label?: string }): number {
    if (!o.title) {
      console.error("usage: glab issue-new --title <t> [--file <f> | --body <b>] [--label <l>]");
      return 2;
    }
    let body: string;
    if (o.file) {
      const path = expandTilde(o.file);
      if (!existsSync(path)) {
        console.error(`no such file: ${path}`);
        return 1;
      }
      body = readFileSync(path, "utf-8");
    } else {
      body = o.body && o.body.length > 0 ? o.body : "_(brain-dump — flesh out later)_";
    }
    const args = ["issue", "create", "-R", REPO, "--title", o.title, "--description", body, "--yes"];
    if (o.label) args.push("--label", o.label);
    return glabRun(args);
  }

  function issueEdit(num: string): number {
    if (!num) {
      console.error("usage: glab issue-edit <number>");
      return 2;
    }
    return glabRun(["issue", "update", num, "-R", REPO, "--description", "-"]);
  }

  function issueClose(num: string): number {
    if (!num) {
      console.error("usage: glab issue-close <number>");
      return 2;
    }
    return glabRun(["issue", "close", num, "-R", REPO]);
  }

  // ── dispatch ────────────────────────────────────────────────────────────────
  const [cmd, ...rest] = argv;
  const handlers: Record<string, () => number> = {
    "mr-threads": () => mrThreads(),
    pipeline: () => pipeline(rest[0]),
    "ci-stats": () => ciStats(rest[0] ?? "main", rest[1] ?? ""),
    "issue-list": () => issueList(hasFlag(rest, "all")),
    "issue-view": () => issueView(positional(rest), hasFlag(rest, "web")),
    "issue-new": () =>
      issueNew({
        title: flagValue(rest, "title"),
        file: flagValue(rest, "file"),
        body: flagValue(rest, "body"),
        label: flagValue(rest, "label"),
      }),
    "issue-edit": () => issueEdit(positional(rest)),
    "issue-close": () => issueClose(positional(rest)),
  };

  const code = dispatch(cmd ?? "", handlers);
  if (code === undefined) {
    console.error(
      `glab: unknown command '${cmd ?? ""}'. Use: mr-threads | pipeline [ref] | ci-stats <ref> <sinceIso> | issue-list [--all] | issue-view <n> [--web] | issue-new --title <t> [--file <f> | --body <b>] [--label <l>] | issue-edit <n> | issue-close <n>`,
    );
    return 2;
  }
  return code;
}
