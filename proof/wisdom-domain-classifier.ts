#!/usr/bin/env bun
/**
 * wisdom-domain-classifier — Story 12.4 rewrite onto the std substrate (proof/ consumer; live cutover
 * to ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). Was `~/.claude/PAI/Tools/WisdomDomainClassifier.ts`.
 *
 * Behavior preserved to the byte. Re-rolled plumbing now imports tested std primitives:
 *   - frame-file discovery  → `fsx.walkFiles` (+ `fsx.exists` for the per-domain frame probe)
 *   - arg parsing           → `core.flagValue` / `core.hasFlag`
 *   - `**Confidence:**` read → `core.getMetaField` (replaces the local `(\d+%)` regex; original captured
 *                              a bare `NN%` and frames carry `**Confidence:** NN%`, so remainder-of-line
 *                              is byte-identical — no strip needed)
 *   - JSON emit             → `report.emitJson` / `report.log`
 *
 * DELIBERATELY NOT adopted — `core.scoreRules`. This tool's `classifyDomains` is OCCURRENCE-weighted:
 * it counts how many times each regex matches (`text.match(/…/gi)?.length`) and adds
 * `count × 2` (primary) / `count × 1` (secondary), gating on `primaryHits >= 1 OR secondaryHits >= 2`,
 * then `relevance = min(score/10, 1)`. `scoreRules` is BOOLEAN-per-pattern (one hit per pattern, not a
 * count) — swapping it in would change every ranking. So the two-tier occurrence loop stays HERE,
 * verbatim, at the edge. This divergence is an intentional, recorded defer.
 *
 * Kept caller-local (D4): the `MEMORY/WISDOM/FRAMES` path + `PAI_DIR`/`HOME` roots, the entire
 * `DOMAIN_MAP` keyword table (primary/secondary regexes per domain), the help text, and the
 * occurrence-weighting logic itself. Roots + the domain map are injected so tests stay hermetic.
 */

import { flagValue, hasFlag, getMetaField } from "std/core";
import { walkFiles, exists, resolveFrameworkDir } from "std/fsx";
import { emitJson, log } from "std/report";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";

// ── Roots (caller-local identity, D4) ──

/** Default frames dir off PAI_DIR|~/.claude. Injected into `main`/functions so tests never read real ~/.claude. */
export function defaultFramesDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const baseDir = env.LIFEOS_DIR || env.PAI_DIR || resolveFrameworkDir(env.HOME ?? "");
  return join(baseDir, "MEMORY", "WISDOM", "FRAMES");
}

// ── Domain Keyword Map (caller-local, injected) ──

export interface DomainKeywords {
  domain: string;
  /** Primary keywords — strong match */
  primary: RegExp[];
  /** Secondary keywords — weaker match, needs 2+ to trigger */
  secondary: RegExp[];
}

export const DOMAIN_MAP: DomainKeywords[] = [
  {
    domain: "communication",
    primary: [
      /\b(response|format|output|verbose|concise|summary|explain)\b/i,
      /\b(tone|voice|style|wording|phrasing)\b/i,
      /\b(greeting|rating|feedback)\b/i,
    ],
    secondary: [
      /\b(short|long|brief|detail)\b/i,
      /\b(say|tell|write|read)\b/i,
    ],
  },
  {
    domain: "development",
    primary: [
      /\b(code|function|class|module|import|export)\b/i,
      /\b(bug|fix|refactor|implement|build|create|add)\b/i,
      /\b(typescript|javascript|python|bun|npm|git)\b/i,
      /\b(test|lint|type.?check|compile)\b/i,
      /\b(hook|skill|tool|agent|algorithm)\b/i,
    ],
    secondary: [
      /\b(file|path|directory|folder)\b/i,
      /\b(error|crash|broken|issue)\b/i,
    ],
  },
  {
    domain: "deployment",
    primary: [
      /\b(deploy|push|ship|release|publish)\b/i,
      /\b(cloudflare|worker|pages|wrangler|vercel)\b/i,
      /\b(production|staging|live|remote)\b/i,
      /\b(git\s+push|git\s+remote)\b/i,
    ],
    secondary: [
      /\b(build|compile|bundle)\b/i,
      /\b(url|domain|dns|ssl)\b/i,
    ],
  },
  {
    domain: "content-creation",
    primary: [
      /\b(blog|post|article|newsletter|write)\b/i,
      /\b(draft|edit|proofread|publish)\b/i,
      /\b(social|tweet|linkedin)\b/i,
      /\b(video|podcast|youtube)\b/i,
    ],
    secondary: [
      /\b(header|image|thumbnail)\b/i,
      /\b(audience|reader|subscriber)\b/i,
    ],
  },
  {
    domain: "system-architecture",
    primary: [
      /\b(architecture|design|system|infrastructure)\b/i,
      /\b(memory|state|hook|skill|algorithm)\b/i,
      /\b(pai|framework|platform)\b/i,
    ],
    secondary: [
      /\b(pattern|structure|flow|pipeline)\b/i,
      /\b(integration|component|module)\b/i,
    ],
  },
];

// ── Classification ──

export interface ClassificationResult {
  domain: string;
  path: string;
  relevance: number; // 0-1
}

/**
 * Occurrence-weighted two-tier classifier. Kept verbatim from the original — see the file header for
 * why `core.scoreRules` (boolean-per-pattern) is NOT used here.
 *
 * @param framesDir directory holding `<domain>.md` frame files (injected, D4)
 * @param domainMap keyword table (injected so tests can supply a fixture map)
 */
export function classifyDomains(
  text: string,
  framesDir: string,
  domainMap: DomainKeywords[] = DOMAIN_MAP,
): ClassificationResult[] {
  const results: ClassificationResult[] = [];

  for (const entry of domainMap) {
    let score = 0;
    let primaryHits = 0;
    let secondaryHits = 0;

    for (const pattern of entry.primary) {
      const matches = text.match(new RegExp(pattern, "gi"));
      if (matches) {
        primaryHits += matches.length;
        score += matches.length * 2; // Primary keywords worth 2x
      }
    }

    for (const pattern of entry.secondary) {
      const matches = text.match(new RegExp(pattern, "gi"));
      if (matches) {
        secondaryHits += matches.length;
        score += matches.length;
      }
    }

    // Need at least 1 primary hit OR 2+ secondary hits
    if (primaryHits >= 1 || secondaryHits >= 2) {
      const framePath = join(framesDir, `${entry.domain}.md`);
      const frameExists = exists(framePath);

      results.push({
        domain: entry.domain,
        path: frameExists ? framePath : "",
        relevance: Math.min(score / 10, 1), // Normalize to 0-1
      });
    }
  }

  // Sort by relevance descending
  results.sort((a, b) => b.relevance - a.relevance);

  return results;
}

/**
 * Load and return the content of relevant frames for a given text.
 */
export function loadRelevantFrames(
  text: string,
  framesDir: string,
  maxFrames: number = 3,
  domainMap: DomainKeywords[] = DOMAIN_MAP,
): { domain: string; content: string }[] {
  const classified = classifyDomains(text, framesDir, domainMap);
  const loaded: { domain: string; content: string }[] = [];

  for (const result of classified.slice(0, maxFrames)) {
    if (result.path && exists(result.path)) {
      loaded.push({
        domain: result.domain,
        content: readFileSync(result.path, "utf-8"),
      });
    }
  }

  return loaded;
}

/**
 * List all available frames. Discovery via `fsx.walkFiles`; the `**Confidence:**` value via
 * `core.getMetaField` (remainder-of-line trim, byte-identical to the old `(\d+%)` capture for
 * `**Confidence:** NN%` frames).
 */
export function listFrames(
  framesDir: string,
): { domain: string; path: string; confidence: string }[] {
  if (!exists(framesDir)) return [];

  return walkFiles(framesDir, (p) => p.endsWith(".md")).map((path) => {
    const content = readFileSync(path, "utf-8");
    return {
      domain: basename(path, ".md"),
      path,
      confidence: getMetaField(content, "Confidence") || "unknown",
    };
  });
}

// ── CLI ──

const HELP = `
WisdomDomainClassifier - Route requests to relevant Wisdom Frames

Usage:
  echo "deploy the worker" | bun WisdomDomainClassifier.ts
  bun WisdomDomainClassifier.ts --text "fix the login bug"
  bun WisdomDomainClassifier.ts --list

Output: JSON array of { domain, path, relevance }
`;

/** Synchronous stdin read (fd 0) so `main` stays sync. Empty string when no pipe is attached. */
function readStdinSync(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

/**
 * @param argv defaults to process args
 * @param opts.framesDir injected frames root (hermetic tests)
 * @param opts.readStdin injected stdin reader (hermetic tests)
 */
export function main(
  argv: string[] = process.argv.slice(2),
  opts: { framesDir?: string; readStdin?: () => string } = {},
): number {
  const framesDir = opts.framesDir ?? defaultFramesDir();

  // help / list / short aliases (-h/-l/-t preserved from the original parseArgs contract)
  if (hasFlag(argv, "help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }

  if (hasFlag(argv, "list") || argv.includes("-l")) {
    emitJson(listFrames(framesDir));
    return 0;
  }

  let text = flagValue(argv, "text") ?? shortValue(argv, "-t") ?? "";
  if (!text) {
    text = (opts.readStdin ?? readStdinSync)();
  }

  if (!text.trim()) {
    log("No text provided");
    return 1;
  }

  emitJson(classifyDomains(text.trim(), framesDir));
  return 0;
}

/** value after a short flag `-x value` (the one arg-shape `core.flagValue` can't see). */
function shortValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

if (import.meta.main) {
  process.exit(main());
}
