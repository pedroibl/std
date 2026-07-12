#!/usr/bin/env bun
/**
 * Recommend — Story 12.4 rewrite onto the std substrate (proof/ consumer; live cutover to
 * ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). Behavior preserved; re-rolled plumbing now
 * imports tested std primitives:
 *   - readIf(existsSync+readFileSync) → fsx.readIfExists
 *   - Math.floor((Date.now()-new Date(x))/86400000) → core.daysSince(iso, now)  [now injected]
 *   - 6 args.indexOf("--flag")+args[i+1] copies → core.hasFlag / core.flagValue
 *   - readIf(...).split("## Blocklist")[1] → core.extractSection(content, "## Blocklist")
 *   - console.log(JSON.stringify(x, null, 2)) → report.emitJson  (byte-identical)
 *
 * Kept caller-local (D4): the TELOS/CURRENT_STATE path roots, the `parseEntries` YAML-ish line
 * parser, the `parseRecencyDays` `Nd` regex, and the per-category ranking rules (rating desc, then
 * recency). Tests inject roots + a fixed `now` for hermetic fixtures.
 *
 * Usage:
 *   bun recommend.ts --category restaurant [--cuisine thai] [--not-visited 30d]
 *   bun recommend.ts --category movie [--genre sci-fi] [--not-watched 90d]
 *   bun recommend.ts --category book [--theme philosophy]
 *   bun recommend.ts --json (add to any command for JSON output)
 */

import { join } from "path";
import { daysSince, extractSection, flagValue, hasFlag } from "std/core";
import { readIfExists, resolveFrameworkDir } from "std/fsx";
import { emitJson } from "std/report";

// ── Caller-local identity (D4): path roots ──────────────────────────────────
export type Roots = { telosDir: string; currentDir: string };

export function defaultRoots(): Roots {
  const HOME = process.env.HOME || "";
  const PAI_DIR = process.env.LIFEOS_DIR || process.env.PAI_DIR || resolveFrameworkDir(HOME);
  const telosDir = join(PAI_DIR, "USER", "TELOS");
  return { telosDir, currentDir: join(telosDir, "CURRENT_STATE") };
}

export type Category = "restaurant" | "movie" | "book";

export type Candidate = {
  name: string;
  attrs: Record<string, unknown>;
  last_consumed?: string;
  days_since?: number;
  rating?: number;
  source_file: string;
  confidence: number;
  confidence_note?: string;
};

export type RankOpts = {
  cuisine?: string;
  genre?: string;
  theme?: string;
  notVisitedDays?: number | null;
};

// std/fsx.readIfExists returns null when absent; the origin `readIf` returned "".
function readOrEmpty(path: string): string {
  return readIfExists(path) ?? "";
}

// Caller-local: `Nd` recency-window parser (30 / 30d / "30 d").
export function parseRecencyDays(input?: string): number | null {
  if (!input) return null;
  const m = input.match(/^(\d+)\s*d?$/i);
  if (!m) return null;
  return Number(m[1]);
}

// Caller-local: simple YAML-ish line parser for `- name: "X"` / `cuisine: thai` / etc.
export function parseEntries(markdown: string): Array<Record<string, string>> {
  const entries: Array<Record<string, string>> = [];
  let current: Record<string, string> = {};
  for (const line of markdown.split("\n")) {
    const nameMatch = line.match(/^\s*-\s+name:\s*"?([^"]+)"?\s*$/);
    const attrMatch = line.match(/^\s+(\w+):\s*"?([^"]+)"?\s*$/);
    if (nameMatch) {
      if (Object.keys(current).length) entries.push(current);
      current = { name: nameMatch[1] };
    } else if (attrMatch && Object.keys(current).length) {
      current[attrMatch[1]] = attrMatch[2];
    }
  }
  if (Object.keys(current).length) entries.push(current);
  return entries;
}

export function loadCandidates(category: Category, roots: Roots, now: Date): Candidate[] {
  const { telosDir, currentDir } = roots;
  if (category === "restaurant") {
    const restaurantsMd = readOrEmpty(join(telosDir, "RESTAURANTS.md"));
    const prefs = parseEntries(restaurantsMd);
    const consumption = parseEntries(readOrEmpty(join(currentDir, "CONSUMPTION.md")));
    const blocklist = new Set(
      parseEntries(extractSection(restaurantsMd, "## Blocklist") ?? "").map((e) =>
        e.name.toLowerCase(),
      ),
    );
    return prefs
      .filter((p) => !blocklist.has(p.name.toLowerCase()))
      .map((p) => {
        const visit = consumption.find(
          (c) => c.name?.toLowerCase() === p.name.toLowerCase() && c.category === "restaurant",
        );
        return {
          name: p.name,
          attrs: p,
          last_consumed: visit?.visited,
          days_since: visit?.visited ? daysSince(visit.visited, now) : undefined,
          rating: p.rating ? Number(p.rating) : undefined,
          source_file: "TELOS/RESTAURANTS.md",
          confidence: 0.8,
        };
      });
  }
  if (category === "movie") {
    const prefs = parseEntries(readOrEmpty(join(telosDir, "MOVIES.md")));
    const consumption = parseEntries(readOrEmpty(join(currentDir, "CONSUMPTION.md")));
    return prefs.map((p) => {
      const seen = consumption.find(
        (c) => c.title?.toLowerCase() === p.title?.toLowerCase() && c.category === "movie",
      );
      return {
        name: p.title || p.name,
        attrs: p,
        last_consumed: seen?.watched,
        days_since: seen?.watched ? daysSince(seen.watched, now) : undefined,
        rating: p.rating ? Number(p.rating) : undefined,
        source_file: "TELOS/MOVIES.md",
        confidence: 0.75,
      };
    });
  }
  // book
  const prefs = parseEntries(readOrEmpty(join(telosDir, "BOOKS.md")));
  return prefs.map((p) => ({
    name: p.title || p.name,
    attrs: p,
    rating: p.rating ? Number(p.rating) : undefined,
    source_file: "TELOS/BOOKS.md",
    confidence: 0.7,
  }));
}

// Caller-local: per-category ranking rules (rating desc, then longest-since-consumed).
export function rank(candidates: Candidate[], opts: RankOpts): Candidate[] {
  let filtered = candidates;

  if (opts.cuisine) {
    filtered = filtered.filter(
      (c) => (c.attrs.cuisine as string)?.toLowerCase() === opts.cuisine?.toLowerCase(),
    );
  }
  if (opts.genre) {
    filtered = filtered.filter((c) =>
      (c.attrs.genre as string)?.toLowerCase().includes(opts.genre?.toLowerCase() || ""),
    );
  }
  if (opts.theme) {
    filtered = filtered.filter((c) =>
      (c.attrs.themes as string)?.toLowerCase().includes(opts.theme?.toLowerCase() || ""),
    );
  }
  if (opts.notVisitedDays != null) {
    const n = opts.notVisitedDays;
    filtered = filtered.filter((c) => c.days_since == null || c.days_since >= n);
  }

  // Adjust confidence: filter specificity drops confidence if match set is tiny
  const withConfidence = filtered.map((c) => ({
    ...c,
    confidence:
      filtered.length === 0
        ? 0
        : Math.max(
            0.3,
            c.confidence -
              (opts.cuisine ? 0.05 : 0) -
              (opts.notVisitedDays != null ? 0.05 : 0),
          ),
    confidence_note:
      filtered.length < 3 ? "Narrow candidate pool — low confidence" : undefined,
  }));

  return withConfidence.sort((a, b) => {
    const ra = a.rating || 5;
    const rb = b.rating || 5;
    if (rb !== ra) return rb - ra;
    const da = a.days_since || Infinity;
    const db = b.days_since || Infinity;
    return db - da;
  });
}

// ─── Main ───

export function main(argv: string[] = process.argv.slice(2), now: Date = new Date()): number {
  const args = argv;

  // std args helpers take the flag NAME (no `--` prefix); they prepend it internally.
  if (!hasFlag(args, "category")) {
    console.error("Required: --category restaurant|movie|book");
    return 1;
  }
  const category = flagValue(args, "category") as Category;
  if (!["restaurant", "movie", "book"].includes(category)) {
    console.error("Invalid category. Choose: restaurant, movie, book");
    return 1;
  }

  const opts: RankOpts = {
    cuisine: flagValue(args, "cuisine"),
    genre: flagValue(args, "genre"),
    theme: flagValue(args, "theme"),
    notVisitedDays: parseRecencyDays(
      flagValue(args, "not-visited") || flagValue(args, "not-watched"),
    ),
  };

  const candidates = loadCandidates(category, defaultRoots(), now);
  const ranked = rank(candidates, opts);

  if (hasFlag(args, "json")) {
    emitJson(ranked.slice(0, 5));
    return 0;
  }

  if (ranked.length === 0) {
    console.log(`No candidates match. Preference file may be unseeded — run the interview.`);
    return 0;
  }
  const top = ranked[0];
  console.log(`🎯 Recommend: ${top.name}`);
  if (top.attrs.cuisine) console.log(`   Cuisine: ${top.attrs.cuisine}`);
  if (top.attrs.location) console.log(`   Location: ${top.attrs.location}`);
  if (top.rating) console.log(`   Rating: ${top.rating}`);
  if (top.days_since != null) console.log(`   Last: ${top.days_since}d ago`);
  else console.log(`   Last: never (or not tracked)`);
  console.log(`   Confidence: ${Math.round(top.confidence * 100)}%`);
  if (top.confidence_note) console.log(`   Note: ${top.confidence_note}`);
  if (ranked.length > 1) {
    console.log(`\nAlso: ${ranked.slice(1, 4).map((c) => c.name).join(", ")}`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
