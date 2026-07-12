#!/usr/bin/env bun
/**
 * youtube-api — proof/ rewrite of `~/.claude/PAI/TOOLS/YouTubeApi.ts` (Story 12.5, HTTP cluster part B)
 * onto the std substrate. YouTube Data API v3 client: channel stats, recent videos, single-video
 * lookup, search.
 *
 * `apiGet` (source :67-79) now goes through `std/http`'s `httpJson` — the source's console-only
 * `err.error?.message` extraction (source :74-75) is DROPPED. It was never a machine-consumed contract,
 * just a string handed to `console.error`, and `httpJson`'s thrown `Error` already folds the
 * error-response body into its message (`readBodySnippet`), so the failure TEXT is functionally
 * preserved without a bespoke re-parse of the JSON error envelope.
 *
 * dotenv (source :39-54) → `fsx.readIfExists` (one syscall, ENOENT-soft — see `fsx`'s docstring). This
 * differs from the source in exactly one respect: a genuine read error on an EXISTING `.env` file (e.g.
 * EACCES) now surfaces (fail-loud, FR5) instead of being silently swallowed by the source's bare
 * `catch {}` — a strict improvement, not a behavior any real caller depended on.
 *
 * The ANSI `colors` table + every statusline STAY caller-local (D4) — `std/report` has no `paint`/color
 * helper (`report/p.ts`'s `lines()` is a plain push-lines line-builder, no ANSI). RECORDED FINDING: this
 * is the only consumer in this cluster wanting terminal color, below the Rule-of-Three trigger — no
 * `core`/`report` promotion here; defer until a 2nd caller wants ANSI color.
 *
 * SUBSTRATE FINDING: `core/args.dispatch` requires SYNCHRONOUS handlers (`Record<string, () => number>`).
 * Every command here is async (network I/O), and `args.ts`'s own doc comment already flags the gap ("an
 * async/richer-result variant is left for when a real consumer needs it — D2, no speculative
 * generalization"). This tool (and its cluster-mate `tlp-archive.ts`) IS that real consumer. Since this
 * story stays out of `src/**`, the CLI edge below routes with a plain `if`/`switch` instead of
 * `dispatch`; `positional()` still does the subcommand extraction.
 *
 * STAYS caller-local (D4): API-key / channel env resolution, the default channel ID, `BASE_URL` — each
 * overridable via an env var so tests can point at a local `Bun.serve` mock instead of the real API (no
 * baked prod URL reachable from a test).
 *
 * Usage:
 *   bun youtube-api.ts <command> [options]
 *
 * Commands:
 *   channel              Get channel statistics
 *   videos [count]       Get recent videos with stats (default: 10)
 *   video <id|title>     Get stats for specific video
 *   search <query>       Search channel videos
 *
 * Environment:
 *   YOUTUBE_API_KEY          API key (required)
 *   YOUTUBE_CHANNEL_ID       Channel ID (default: UCnCikd0s4i9KoDtaHPlK-JA)
 *   YOUTUBE_API_BASE_URL     API base URL (default: https://www.googleapis.com/youtube/v3) — test hook
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { positional } from "std/core";
import { readIfExists } from "std/fsx";
import { httpJson } from "std/http";

// ─── ANSI colors — caller-local (D4), see header note ───
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
};

const DEFAULT_CHANNEL_ID = "UCnCikd0s4i9KoDtaHPlK-JA";
const DEFAULT_BASE_URL = "https://www.googleapis.com/youtube/v3";

export interface YouTubeConfig {
  apiKey: string;
  channelId: string;
  baseUrl: string;
}

/** Parse a simple `KEY=value` `.env` file. Absent file → `{}` (fsx.readIfExists is ENOENT-soft). */
export function loadEnv(envPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  const content = readIfExists(envPath);
  if (content === null) return env;
  for (const line of content.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

// Config-dir root: prefer the new LIFEOS_CONFIG_DIR stem, keep PAI_CONFIG_DIR for the pre-migration
// transition window (AD-9.3 Rule 4), then the claude-home .env fallback (.claude never renames — 16.2
// non-goal). `||` (not `??`) so an explicitly-empty LIFEOS_CONFIG_DIR="" falls through — matches the
// file's truthy-ternary style and the 16.2 arthur.ts review patch (empty-string-override correctness).
// Exported so youtube-api.test.ts can assert the resolved path shape directly (RT-6).
export function defaultEnvPath(): string {
  const configDir = process.env.LIFEOS_CONFIG_DIR || process.env.PAI_CONFIG_DIR;
  return configDir ? join(configDir, ".env") : join(homedir(), ".claude", ".env");
}

/** Resolve API key / channel / base URL from `process.env`, falling back to a loaded `.env`. */
export function resolveConfig(envPath: string): YouTubeConfig | null {
  const env = loadEnv(envPath);
  const apiKey = process.env.YOUTUBE_API_KEY || env.YOUTUBE_API_KEY;
  if (!apiKey) return null;
  const channelId = process.env.YOUTUBE_CHANNEL_ID || env.YOUTUBE_CHANNEL_ID || DEFAULT_CHANNEL_ID;
  const baseUrl = process.env.YOUTUBE_API_BASE_URL || DEFAULT_BASE_URL;
  return { apiKey, channelId, baseUrl };
}

// ─── API helper (source :67-79 → std/http) ───

export async function apiGet<T>(
  cfg: Pick<YouTubeConfig, "apiKey" | "baseUrl">,
  endpoint: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(`${cfg.baseUrl}${endpoint}`);
  url.searchParams.set("key", cfg.apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return httpJson<T>(url.toString());
}

/** Format numbers with thousands separators (source :82-84, unchanged). */
export function formatNum(n: string | number): string {
  return Number(n).toLocaleString();
}

// ─── Commands (source :87-228, unchanged logic; now cfg-parametrized instead of module constants) ───

interface ChannelResponse {
  items: Array<{
    snippet: { title: string; description: string; customUrl: string };
    statistics: { subscriberCount: string; viewCount: string; videoCount: string };
  }>;
}

export async function getChannel(cfg: YouTubeConfig): Promise<void> {
  const data = await apiGet<ChannelResponse>(cfg, "/channels", {
    part: "snippet,statistics",
    id: cfg.channelId,
  });

  const ch = data.items[0];
  console.log(`\n${colors.bold}${colors.cyan}Channel: ${ch.snippet.title}${colors.reset}`);
  console.log(`${colors.dim}${ch.snippet.customUrl}${colors.reset}\n`);
  console.log(`${colors.green}Subscribers:${colors.reset} ${formatNum(ch.statistics.subscriberCount)}`);
  console.log(`${colors.green}Total Views:${colors.reset} ${formatNum(ch.statistics.viewCount)}`);
  console.log(`${colors.green}Videos:${colors.reset}      ${formatNum(ch.statistics.videoCount)}`);
}

interface SearchResponse {
  items: Array<{
    id: { videoId: string };
    snippet: { title: string; publishedAt: string };
  }>;
}

interface VideosResponse {
  items: Array<{
    id: string;
    statistics: { viewCount: string; likeCount: string; commentCount: string };
  }>;
}

export async function getRecentVideos(cfg: YouTubeConfig, count: number = 10): Promise<void> {
  // Get recent videos
  const search = await apiGet<SearchResponse>(cfg, "/search", {
    part: "snippet",
    channelId: cfg.channelId,
    order: "date",
    maxResults: count.toString(),
    type: "video",
  });

  const videoIds = search.items.map((v) => v.id.videoId).join(",");

  // Get stats
  const stats = await apiGet<VideosResponse>(cfg, "/videos", {
    part: "statistics",
    id: videoIds,
  });

  const statsMap = new Map(stats.items.map((v) => [v.id, v.statistics]));

  console.log(`\n${colors.bold}${colors.cyan}Recent Videos${colors.reset}\n`);
  console.log(
    `${colors.dim}${"Title".padEnd(50)} ${"Views".padStart(10)} ${"Likes".padStart(8)}${colors.reset}`,
  );
  console.log("-".repeat(70));

  for (const video of search.items) {
    const s = statsMap.get(video.id.videoId);
    const title = video.snippet.title.slice(0, 48).padEnd(50);
    const views = formatNum(s?.viewCount || 0).padStart(10);
    const likes = formatNum(s?.likeCount || 0).padStart(8);
    console.log(`${title} ${colors.green}${views}${colors.reset} ${colors.yellow}${likes}${colors.reset}`);
  }
}

interface VideoResponse {
  items: Array<{
    id: string;
    snippet: { title: string; publishedAt: string; description: string };
    statistics: { viewCount: string; likeCount: string; commentCount: string };
    contentDetails: { duration: string };
  }>;
}

/** Returns the process exit code (0 ok, 1 not-found) — the source called `process.exit` inline. */
export async function getVideoStats(cfg: YouTubeConfig, query: string): Promise<number> {
  let videoId = query;

  // If not a video ID, search for it
  if (!query.match(/^[a-zA-Z0-9_-]{11}$/)) {
    const search = await apiGet<SearchResponse>(cfg, "/search", {
      part: "snippet",
      channelId: cfg.channelId,
      q: query,
      type: "video",
      maxResults: "1",
    });
    if (!search.items.length) {
      console.error(`${colors.red}No video found matching: ${query}${colors.reset}`);
      return 1;
    }
    videoId = search.items[0].id.videoId;
  }

  const data = await apiGet<VideoResponse>(cfg, "/videos", {
    part: "snippet,statistics,contentDetails",
    id: videoId,
  });

  if (!data.items.length) {
    console.error(`${colors.red}Video not found: ${videoId}${colors.reset}`);
    return 1;
  }

  const v = data.items[0];
  console.log(`\n${colors.bold}${colors.cyan}${v.snippet.title}${colors.reset}`);
  console.log(`${colors.dim}https://youtube.com/watch?v=${v.id}${colors.reset}\n`);
  console.log(`${colors.green}Views:${colors.reset}    ${formatNum(v.statistics.viewCount)}`);
  console.log(`${colors.green}Likes:${colors.reset}    ${formatNum(v.statistics.likeCount)}`);
  console.log(`${colors.green}Comments:${colors.reset} ${formatNum(v.statistics.commentCount)}`);
  console.log(`${colors.green}Published:${colors.reset} ${new Date(v.snippet.publishedAt).toLocaleDateString()}`);
  return 0;
}

export async function searchVideos(cfg: YouTubeConfig, query: string): Promise<void> {
  const data = await apiGet<SearchResponse>(cfg, "/search", {
    part: "snippet",
    channelId: cfg.channelId,
    q: query,
    type: "video",
    maxResults: "10",
  });

  console.log(`\n${colors.bold}${colors.cyan}Search: "${query}"${colors.reset}\n`);

  for (const v of data.items) {
    console.log(`${colors.green}${v.snippet.title}${colors.reset}`);
    console.log(`  ${colors.dim}https://youtube.com/watch?v=${v.id.videoId}${colors.reset}`);
  }
}

function showHelp(): void {
  console.log(`
${colors.bold}YouTubeApi${colors.reset} - YouTube Data API v3 client

${colors.cyan}Usage:${colors.reset}
  bun youtube-api.ts <command> [options]

${colors.cyan}Commands:${colors.reset}
  channel              Get channel statistics
  videos [count]       Get recent videos with stats (default: 10)
  video <id|title>     Get stats for specific video
  search <query>       Search channel videos

${colors.cyan}Examples:${colors.reset}
  bun youtube-api.ts channel
  bun youtube-api.ts videos 5
  bun youtube-api.ts video "ThreatLocker"
  bun youtube-api.ts search "AI agents"
`);
}

// ─── CLI edge (source :251-284) — async routing, see SUBSTRATE FINDING above ───

export async function main(
  argv: string[] = process.argv.slice(2),
  envPath: string = defaultEnvPath(),
): Promise<number> {
  const cmd = positional(argv);
  const rest = argv.slice(1);

  if (!cmd || cmd === "--help" || cmd === "-h") {
    showHelp();
    return 0;
  }

  if (cmd !== "channel" && cmd !== "videos" && cmd !== "video" && cmd !== "search") {
    console.error(`${colors.red}Unknown command: ${cmd}${colors.reset}`);
    showHelp();
    return 1;
  }

  const cfg = resolveConfig(envPath);
  if (!cfg) {
    console.error(`${colors.red}Error: YOUTUBE_API_KEY not set${colors.reset}`);
    return 1;
  }

  switch (cmd) {
    case "channel":
      await getChannel(cfg);
      return 0;
    case "videos":
      await getRecentVideos(cfg, parseInt(rest[0]) || 10);
      return 0;
    case "video":
      if (!rest[0]) {
        console.error(`${colors.red}Error: video ID or title required${colors.reset}`);
        return 1;
      }
      return await getVideoStats(cfg, rest.join(" "));
    case "search":
      if (!rest[0]) {
        console.error(`${colors.red}Error: search query required${colors.reset}`);
        return 1;
      }
      await searchVideos(cfg, rest.join(" "));
      return 0;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
