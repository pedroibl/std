// Story 4.4 — host auto-detect (AC2). The second consumer of the "adapter concept": a CLOSED, std-owned
// set selected by name. Here the selection is automatic — derived from the repo's `origin` remote — but
// still overridable (an explicit host wins over detection).
//
// SCOPE: 4.4 delivers host *detection* (which CLI binary backs this repo), NOT a provider abstraction
// (the pluggable glab|gh dispatch layer is deferred, FR13 note). So `detectHost` is a standalone resolver;
// wiring it into command dispatch comes later.
//
// This duplicates glab's ~5-line `git remote get-url origin` read deliberately: cross-slice imports are
// held until the Phase-6 `git` plumbing slice (AD-9) consolidates it. Until then each edge reads its own.
//
// This is a Bun edge (it spawns git), so it may use node:* — core stays pure (D1). No consumer identity
// is baked in (D4/NFR3): only the generic forge hostnames are matched, and the repo is read from git.

import { execFileSync } from "node:child_process";

/** The closed, std-owned host set — which forge CLI backs a repo. */
export const HOSTS = ["glab", "gh"] as const;
export type Host = (typeof HOSTS)[number];

/**
 * Map a git remote URL to its host CLI, or null if it's neither known forge. Pure (unit-testable).
 * Handles SSH (`git@gitlab.com:owner/repo.git`) and HTTP(S) (`https://github.com/owner/repo.git`).
 * Matches the hostname segment only. Anything else → null.
 */
export function hostFromRemoteUrl(url: string): Host | null {
  const u = url.trim();
  if (!u) return null;
  const ssh = u.match(/^[^@\s]+@([^:\s]+):/); //  git@HOST:owner/repo
  const http = u.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/:\s]+)/i); //  scheme://[user@]HOST/...
  const hostname = (ssh?.[1] ?? http?.[1])?.toLowerCase();
  if (!hostname) return null;
  if (isProviderHost(hostname, "gitlab")) return "glab";
  if (isProviderHost(hostname, "github")) return "gh";
  return null;
}

/**
 * Does `hostname` belong to `provider`? Accepts the SaaS domain (`<provider>.com`), a subdomain of it
 * (`*.<provider>.com`), or a self-hosted install whose LEADING label is the provider
 * (`<provider>.company.com`). A provider name in a MIDDLE label is NOT a match — `mirror.github.example.com`
 * and `proxy.gitlab.internal` are some other host that merely mentions the provider (→ null), not the
 * provider itself (tightened per CodeRabbit on PR #9).
 *
 * Three deliberate rules (kept zero-dep — no `tldts`/PSL, per std's Tier-1 ethos, D4): a bare
 * `=== provider` matches an SSH host alias (`git@github:owner/repo` from ~/.ssh/config); `<provider>.com`
 * is the SaaS domain (both forges ARE `.com`); leading-label / `.com`-subdomain cover self-hosted + SaaS
 * subdomains. Best-effort by design — anything unrecognized is null (a non-fatal, overridable fallback).
 */
function isProviderHost(hostname: string, provider: string): boolean {
  return (
    hostname === provider ||
    hostname.startsWith(`${provider}.`) ||
    hostname.endsWith(`.${provider}.com`)
  );
}

/** The `origin` remote URL of the cwd repo, or null if there's no git/origin (non-fatal). */
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

/** Options for {@link detectHost}: an explicit `override` (wins over detection) and an injectable
 *  `remoteUrl` (defaults to reading `origin`) so detection is unit-testable without a real repo. */
export interface DetectHostOptions {
  override?: Host;
  remoteUrl?: string | null;
}

/**
 * Resolve the host (AC2): an explicit `override` wins; otherwise auto-detect from the `origin` remote.
 * No git/origin (or an unrecognized host) → null — a clear, non-fatal fallback (a command that doesn't
 * need a host must not crash). std bakes in NO default host (D4): unresolved is null, never a guess.
 */
export function detectHost(opts: DetectHostOptions = {}): Host | null {
  if (opts.override) return opts.override;
  const url = opts.remoteUrl !== undefined ? opts.remoteUrl : gitRemoteUrl();
  return url ? hostFromRemoteUrl(url) : null;
}
