#!/usr/bin/env bun
/**
 * harvest-backup-positive.ts — Recover POSITIVE signal from old Claude Code
 * sessions in ~/Backups, so PAI's positive channels (loadRecentWins, WISDOM/FRAMES)
 * have real grounding instead of an empty slot at session start.
 *
 * Sibling to BackupHarvester.ts (biographical) and report-harvest.ts (repo state).
 * Same mould: scan extracted `.claude*` dirs AND `*claude*.tar.gz` archives, walk
 * OLDEST → NEWEST, dedupe the heavy overlap, attribute each hit to who said it and
 * which backup preserved it. It NEVER touches the live PAI memory store — everything
 * lands in a review dir (~/Backups/_positive-harvest/) for "dump now, merge later".
 *
 * WHY oldest→newest: the higher ratings live in the older sessions, before the
 * correction-heavy negative skew set in. Processing forward builds a real timeline
 * and dedupe keeps the EARLIEST preservation of each win.
 *
 * WHAT counts as positive — tiered by confidence (a win is only useful if it names
 * the behaviour that earned it, so praise is captured WITH the preceding assistant turn):
 *   • Tier 1  rated-win   — MEMORY/LEARNING/{ALGORITHM,SYSTEM}/**.md with `rating: >= N`
 *                           (default N=7) + its **Feedback:** line. Structured, high-confidence.
 *   • Tier 2  strong-praise — a USER turn with explicit 9/10·10/10, or unambiguous praise
 *                           ("exactly right", "that worked", "ship it"), negation/question filtered.
 *   • Tier 3  soft-positive — "thanks", "nice", "good" — counted for session score only,
 *                           never promoted to a win on its own.
 *
 * PHILOSOPHY (glab.ts mould): degrade to empty on any failure (never crash), runnable as a
 * one-liner, all reads read-only, ships a --self-test.
 *
 * Flags:
 *   --backups-dir <path>  Root to scan            (default: ~/Backups)
 *   --out <path>          Output dir              (default: <backups-dir>/_positive-harvest)
 *   --source <path>       Harvest ONE dir or tarball instead of auto-discovery
 *   --no-tarballs         Skip the .tar.gz archives (dirs only — much faster)
 *   --min-rating <n>      Min learning rating to keep as a Tier-1 win (default: 7)
 *   --order <oldest|newest>  Processing + dedup order (default: oldest)
 *   --limit <n>           Cap sessions parsed (testing)
 *   --dry-run             Discover + count only; write nothing
 *   --self-test           Run built-in unit assertions and exit
 *   --help
 */

import { parseArgs } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { contentHash, parseNdjson } from "std/core";
import { walkFiles, ensureDir, readIfExists, atomicWrite, loadJson, saveJson, resolveFrameworkDir } from "std/fsx";
import {
  CONTEXT_BLOB_RE,
  TARBALL_RE,
  flattenContent,
  dateOf,
  discoverBackupSources,
  extractTarball,
  dateFromLabel,
  type Source,
} from "./backup-harvest-common";

// ============================================================================
// Constants
// ============================================================================

const HOME = process.env.HOME!;
const DEFAULT_BACKUPS_DIR = path.join(HOME, "Backups");
const DEFAULT_PAI_DIR = process.env.LIFEOS_DIR || process.env.PAI_DIR || resolveFrameworkDir(HOME);

// Tier-2 strong praise — unambiguous, reusable. Explicit ratings handled separately.
const STRONG_RE =
  /\b(exactly (right|what i (wanted|needed|meant))|that(?:'s| is| was)? (it|perfect|exactly right)|that worked|works perfectly|ship it|nailed it|spot[- ]on|flawless|brilliant|love (it|this)|perfect[.!]?$|amazing work|exactly the)\b/i;
const RATING_PRAISE_RE = /\b(?:rate[ds]?\s*(?:it|this)?\s*)?(9|10)\s*\/\s*10\b/i;
// Tier-3 soft positive — encouraging but weak; score only.
const SOFT_RE = /\b(thanks|thank you|nice(?:ly)?|good (job|work|stuff|call)|great|awesome|cool|spot on|helpful|that helps|works)\b/i;
// Negation / hedge / question guards — drop "not perfect", "isn't quite right", "is that perfect?"
const NEGATION_RE =
  /\b(not|isn'?t|wasn'?t|aren'?t|ain'?t|never|hardly|barely|don'?t|doesn'?t|didn'?t|can'?t|won'?t|no longer|far from|less than|kind of|sort of|almost|nearly)\b/i;

// Portuguese (PT-BR) — Pedro is bilingual and reacts in Portuguese mid-session, so an
// English-only matcher silently drops half his real praise. Mirrors the EN tiers.
const PT_STRONG_RE =
  /\b(perfeito|perfeita|exatamente|isso mesmo|é isso( aí)?|era isso|funcionou|ficou (ótim[oa]|perfeit[oa]|excelente)|excelente|maravilh(a|oso|osa)|mandou bem|show de bola|ótimo trabalho)\b/i;
const PT_SOFT_RE = /\b(valeu|obrigad[oa]|boa|legal|ótim[oa]|bacana|ajudou|gostei|isso a[íi]|tá (ótimo|bom|certo))\b/i;
const PT_NEGATION_RE = /\b(não|nao|nunca|nem|sem|longe de|quase|meio que|nada|nenhum)\b/i;

const LEARNING_SUBDIRS = ["ALGORITHM", "SYSTEM"];
const RATING_RE = /^\s*rating:\s*(\d+)/m;
const FEEDBACK_RE = /\*\*Feedback:\*\*\s*(.+)/;

// ============================================================================
// Types
// ============================================================================

export type Tier = 1 | 2 | 3;
export type Kind = "rated-win" | "strong-praise" | "soft-positive";

export interface PosHit {
  tier: Tier;
  kind: Kind;
  date: string; // YYYY-MM-DD or "undated"
  rating?: number;
  text: string; // the win/feedback/praise itself
  earnedBy?: string; // the assistant behaviour that earned the praise (Tier 2/3)
  speaker: "pedro" | "system";
  origin: string; // file/session it came from
  sourceBackup: string; // which backup preserved it
}

// ============================================================================
// Helpers
// ============================================================================

/** Pull {role,text,ts} from one transcript entry. role: 'user' | 'assistant' | 'other'. */
export function eventOf(entry: any): { role: "user" | "assistant" | "other"; text: string; ts?: string } | null {
  if (!entry || typeof entry !== "object") return null;
  const ts: string | undefined = entry.timestamp || entry.message?.timestamp;
  const msg = entry.message;
  if (msg && msg.content != null) {
    const text = flattenContent(msg.content);
    if (!text || text.trim().length < 4) return null;
    if (entry.type === "assistant" || msg.role === "assistant") return { role: "assistant", text, ts };
    if (entry.type === "user" || msg.role === "user") {
      if (CONTEXT_BLOB_RE.test(text)) return { role: "other", text, ts }; // injected context, not Pedro
      return { role: "user", text, ts };
    }
  }
  return null;
}

/** Classify a single user line. Returns the tier/kind or null. Negation + question filtered. */
export function classifyPraise(line: string, lang: "en" | "pt" | "both" = "both"): { tier: Tier; kind: Kind } | null {
  const s = line.trim();
  if (s.length < 3 || s.length > 140) return null; // a real reaction is short, not a pasted block
  if (s.endsWith("?")) return null; // "is that perfect?" is not praise
  if (/^([#>*\-]|\d+[.)]\s|\||\/|`)/.test(s)) return null; // markdown / list / command / code line, not Pedro's words
  const en = lang !== "pt";
  const pt = lang !== "en";
  if ((en && NEGATION_RE.test(s)) || (pt && PT_NEGATION_RE.test(s))) return null; // "not quite right" / "não ficou bom"
  if (RATING_PRAISE_RE.test(s) || (en && STRONG_RE.test(s)) || (pt && PT_STRONG_RE.test(s))) return { tier: 2, kind: "strong-praise" };
  if ((en && SOFT_RE.test(s)) || (pt && PT_SOFT_RE.test(s))) return { tier: 3, kind: "soft-positive" };
  return null;
}

/** Parse a learning .md: returns {rating, feedback} when both present. */
export function parseLearning(content: string): { rating: number; feedback: string } | null {
  const r = content.match(RATING_RE);
  const f = content.match(FEEDBACK_RE);
  if (!r || !f) return null;
  const rating = parseInt(r[1], 10);
  if (!Number.isFinite(rating)) return null;
  return { rating, feedback: f[1].trim().slice(0, 200) };
}

/** Recursively collect learning *.md under the {ALGORITHM,SYSTEM} subtrees of a LEARNING dir. */
function collectLearningMd(learningRoot: string): string[] {
  const out: string[] = [];
  for (const sub of LEARNING_SUBDIRS) {
    const base = path.join(learningRoot, sub);
    if (fs.existsSync(base)) {
      out.push(...walkFiles(base, (p) => p.endsWith(".md")));
    }
  }
  return out;
}

/** Find the LEARNING dir inside a source dir. LifeOS layouts preferred, PAI kept for pre-migration backups. */
function learningDirIn(root: string): string | null {
  for (const c of [
    path.join(root, "LIFEOS", "MEMORY", "LEARNING"),
    path.join(root, ".claude", "LIFEOS", "MEMORY", "LEARNING"),
    path.join(root, "PAI", "MEMORY", "LEARNING"),
    path.join(root, ".claude", "PAI", "MEMORY", "LEARNING"),
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ============================================================================
// Extraction
// ============================================================================

/** Pull Tier-1 rated wins from a set of learning .md files. */
function harvestLearning(files: string[], minRating: number, sourceBackup: string): PosHit[] {
  const hits: PosHit[] = [];
  for (const f of files) {
    const content = readIfExists(f);
    if (!content) continue;
    const parsed = parseLearning(content);
    if (!parsed || parsed.rating < minRating) continue;
    const dm = path.basename(f).match(/(\d{4}-\d{2}-\d{2})/);
    hits.push({
      tier: 1,
      kind: "rated-win",
      date: dm ? dm[1] : "undated",
      rating: parsed.rating,
      text: parsed.feedback,
      speaker: "system",
      origin: path.basename(f),
      sourceBackup,
    });
  }
  return hits;
}

/** Pull Tier-2/3 praise from one transcript file, pairing each with the preceding assistant turn. */
function harvestTranscript(file: string, sourceBackup: string, lang: "en" | "pt" | "both"): PosHit[] {
  const hits: PosHit[] = [];
  const raw = readIfExists(file);
  if (!raw) return hits;

  const events: { role: "user" | "assistant" | "other"; text: string; ts?: string }[] = [];
  const entries = parseNdjson<any>(raw);
  for (const entry of entries) {
    const ev = eventOf(entry);
    if (ev) events.push(ev);
  }

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.role !== "user") continue;
    // Skip injected skill/command bodies and long pastes — a genuine reaction is brief.
    if (ev.text.length > 400) continue;
    if (/(Base directory for this skill|<command-name>|<command-message>|ARGUMENTS:|^\s*\/[a-z])/i.test(ev.text)) continue;
    // A user turn can carry the praise on any of its lines — classify the first matching line.
    for (const ln of ev.text.split("\n")) {
      const cls = classifyPraise(ln, lang);
      if (!cls) continue;
      // earnedBy: nearest preceding assistant turn, first meaningful line.
      let earnedBy: string | undefined;
      for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
        if (events[j].role === "assistant") {
          earnedBy = events[j].text.split("\n").map((s) => s.trim()).find((s) => s.length > 12)?.slice(0, 200);
          break;
        }
      }
      hits.push({
        tier: cls.tier,
        kind: cls.kind,
        date: dateOf(ev.ts),
        text: ln.trim().slice(0, 280),
        earnedBy,
        speaker: "pedro",
        origin: path.basename(file, ".jsonl"),
        sourceBackup,
      });
      break; // one praise hit per user turn is enough
    }
  }
  return hits;
}

// ============================================================================
// Output
// ============================================================================

function writeOutputs(outDir: string, hits: PosHit[], sources: Source[], minRating: number) {
  ensureDir(path.join(outDir, "wins"));

  // wins.jsonl — every hit, structured.
  atomicWrite(
    path.join(outDir, "wins", "wins.jsonl"),
    hits.map((h) => JSON.stringify(h)).join("\n") + (hits.length ? "\n" : ""),
  );

  const t1 = hits.filter((h) => h.tier === 1);
  const t2 = hits.filter((h) => h.tier === 2);
  const t3 = hits.filter((h) => h.tier === 3);

  // timeline.md — chronological wins (Tier 1 + 2 only; soft positives are score-only).
  const promotable = [...t1, ...t2].sort((a, b) => a.date.localeCompare(b.date));
  const timeline = ["# Positive Harvest — Timeline (Tier 1 + 2)", ""];
  for (const h of promotable) {
    const tag = h.kind === "rated-win" ? `rated ${h.rating}/10` : "praise";
    timeline.push(`- **${h.date}** _(${tag})_ — ${h.text}`);
    if (h.earnedBy) timeline.push(`  - earned by: ${h.earnedBy}`);
    timeline.push(`  - \`${h.sourceBackup}\` · ${h.origin}`);
  }
  atomicWrite(path.join(outDir, "wins", "timeline.md"), timeline.join("\n") + "\n");

  // index.md — ranked summary + how to merge.
  const idx = [
    "# Positive Harvest — Index",
    "",
    `> Generated ${new Date().toISOString()} · min-rating ${minRating} · ${sources.length} backup source(s) scanned.`,
    "> Read-only harvest; merge nothing automatically. Promote Tier 1/2 below into the live channels.",
    "",
    "## Tally",
    "",
    `- **Tier 1 rated-wins:** ${t1.length}`,
    `- **Tier 2 strong-praise:** ${t2.length}`,
    `- **Tier 3 soft-positive (score only):** ${t3.length}`,
    "",
    "## Top promotable wins (Tier 1 + 2, most recent first)",
    "",
  ];
  for (const h of promotable.slice().reverse().slice(0, 25)) {
    const tag = h.kind === "rated-win" ? `rated ${h.rating}/10` : "praise";
    idx.push(`- **${h.date}** _(${tag})_ — ${h.text}${h.earnedBy ? `  ←  ${h.earnedBy}` : ""}`);
  }
  idx.push(
    "",
    "## Merge (deliberate, manual)",
    "",
    "- **Wins → live channel:** write a chosen win as `MEMORY/LEARNING/SYSTEM/<YYYY-MM>/<ts>_LEARNING_win.md`",
    "  with `rating: 8` frontmatter + a `**Feedback:**` line — `loadRecentWins()` then surfaces it.",
    "- **Principle → WISDOM/FRAMES:** distil a recurring win into `### <principle> [CRYSTAL: <n>%]`",
    "  in `MEMORY/WISDOM/FRAMES/<domain>.md` (n ≥ 85 to be injected).",
    "",
    "## Sources scanned (processing order)",
    "",
    ...sources.map((s) => `- \`${s.sortKey}\` ${s.kind} — ${s.label}`),
  );
  atomicWrite(path.join(outDir, "index.md"), idx.join("\n") + "\n");

  // manifest.json — provenance.
  saveJson(path.join(outDir, "manifest.json"), {
    generatedAt: new Date().toISOString(),
    minRating,
    sources: sources.map((s) => ({ label: s.label, kind: s.kind, sortKey: s.sortKey })),
    counts: { tier1: t1.length, tier2: t2.length, tier3: t3.length, total: hits.length },
  });
}

// ============================================================================
// Promote to live (opt-in, additive — never overwrites, easily reversible)
// ============================================================================

/**
 * Write promotable wins INTO the live positive channel so loadRecentWins() surfaces them.
 * Additive only: new files under MEMORY/LEARNING/SYSTEM/<current-month>/, each tagged
 * `source: backup-harvest` (one `rg` to undo). Idempotent — re-runs skip files whose
 * content hash already landed. Tier-1 by default; Tier-2 needs includePraise.
 */
function promoteToLive(hits: PosHit[], paiDir: string, includePraise: boolean): number {
  const promotable = hits.filter((h) => h.tier === 1 || (includePraise && h.tier === 2));
  if (promotable.length === 0) return 0;
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const dir = path.join(paiDir, "MEMORY", "LEARNING", "SYSTEM", month);
  ensureDir(dir);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let written = 0;
  for (const h of promotable) {
    const rating = h.rating ?? 8; // praise promoted at 8 so loadRecentWins (>=8) surfaces it
    const hash = contentHash(h.text + h.origin, 300).slice(0, 8);
    const file = path.join(dir, `${stamp}_LEARNING_harvested-win_${hash}.md`);
    if (fs.existsSync(file)) continue; // additive, never clobber
    const fb = h.earnedBy ? `${h.text}  ← earned by: ${h.earnedBy}` : h.text;
    const body =
      `---\nrating: ${rating}\nsource: backup-harvest\norigin: ${h.origin}\nsource_backup: ${h.sourceBackup}\noriginal_date: ${h.date}\n---\n` +
      `**Feedback:** ${fb}\n`;
    try {
      atomicWrite(file, body);
      written++;
    } catch {}
  }
  return written;
}

// ============================================================================
// Harvest
// ============================================================================

export async function harvest(opts: {
  backupsDir: string;
  outDir: string;
  source?: string;
  includeTarballs: boolean;
  minRating: number;
  order: "oldest" | "newest";
  limit?: number;
  dryRun: boolean;
  promote: boolean;
  promotePraise: boolean;
  paiDir: string;
  lang: "en" | "pt" | "both";
}) {
  let sources: Source[];
  if (opts.source) {
    const label = path.basename(opts.source);
    const kind: "dir" | "tarball" = TARBALL_RE.test(label) ? "tarball" : "dir";
    sources = [{ label, sortKey: dateFromLabel(label), kind, pathOnDisk: opts.source }];
  } else {
    const d = discoverBackupSources(opts.backupsDir, opts.includeTarballs, opts.outDir, true);
    sources = d.sources;
  }
  sources.sort((a, b) => (opts.order === "oldest" ? a.sortKey.localeCompare(b.sortKey) : b.sortKey.localeCompare(a.sortKey)));

  console.error(`[positive-harvest] ${sources.length} source(s), order=${opts.order}, min-rating=${opts.minRating}${opts.dryRun ? " (dry-run)" : ""}`);

  const seen = new Set<string>();
  const hits: PosHit[] = [];
  let sessionsParsed = 0;
  const tmpBase = path.join(opts.outDir, ".tmp");

  for (const src of sources) {
    let projectsDir: string | null = null;
    let learningFiles: string[] = [];
    let tmpDir: string | null = null;

    if (src.kind === "dir") {
      const p = path.join(src.pathOnDisk, "projects");
      projectsDir = fs.existsSync(p) ? p : null;
      const ld = learningDirIn(src.pathOnDisk);
      if (ld) learningFiles = collectLearningMd(ld);
    } else {
      if (opts.dryRun) {
        console.error(`[positive-harvest] (dry-run) would extract ${src.label}`);
        continue;
      }
      const td = path.join(tmpBase, src.label.replace(/[^a-z0-9]/gi, "_"));
      tmpDir = td;
      const ex = await extractTarball(src.pathOnDisk, td, ["*projects*/*.jsonl", "*MEMORY/LEARNING*/*.md"]);
      projectsDir = ex.projects;
      if (ex.learning) learningFiles = collectLearningMd(ex.learning);
    }

    // Tier 1 — rated wins (dedup by feedback+origin across backups)
    for (const h of harvestLearning(learningFiles, opts.minRating, src.label)) {
      const key = "L:" + contentHash(h.text + h.origin, 300);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(h);
    }

    // Tier 2/3 — transcript praise
    if (projectsDir) {
      const files = walkFiles(projectsDir, (p) => p.endsWith(".jsonl"));
      for (const f of files) {
        if (opts.limit && sessionsParsed >= opts.limit) break;
        sessionsParsed++;
        if (opts.dryRun) continue;
        for (const h of harvestTranscript(f, src.label, opts.lang)) {
          const key = "P:" + contentHash(h.text, 300) + ":" + h.origin;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push(h);
        }
      }
    }

    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }

  if (opts.dryRun) {
    console.error(`[positive-harvest] dry-run: ${sources.length} sources, ~${sessionsParsed} sessions discoverable. No output written.`);
    return;
  }

  ensureDir(opts.outDir);
  writeOutputs(opts.outDir, hits, sources, opts.minRating);
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {}

  if (opts.promote) {
    const n = promoteToLive(hits, opts.paiDir, opts.promotePraise);
    console.error(`[positive-harvest] promoted ${n} win(s) into live MEMORY/LEARNING/SYSTEM (source: backup-harvest — 'rg backup-harvest' to undo)`);
  }

  const t1 = hits.filter((h) => h.tier === 1).length;
  const t2 = hits.filter((h) => h.tier === 2).length;
  const t3 = hits.filter((h) => h.tier === 3).length;
  console.error(`[positive-harvest] wins: ${t1} rated · ${t2} strong-praise · ${t3} soft · ${sessionsParsed} sessions`);
  console.log(path.join(opts.outDir, "index.md"));
}

// ============================================================================
// CLI
// ============================================================================

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "backups-dir": { type: "string" },
      out: { type: "string" },
      source: { type: "string" },
      "no-tarballs": { type: "boolean", default: false },
      "min-rating": { type: "string", default: "7" },
      order: { type: "string", default: "oldest" },
      lang: { type: "string", default: "both" },
      limit: { type: "string" },
      promote: { type: "boolean", default: false },
      "promote-praise": { type: "boolean", default: false },
      "pai-dir": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(
      "harvest-backup-positive.ts — recover positive signal from ~/Backups (oldest→newest), EN+PT.\n" +
        "Flags: --backups-dir --out --source --no-tarballs --min-rating <n> --order <oldest|newest>\n" +
        "       --lang <en|pt|both> --limit <n> --promote --promote-praise --pai-dir <path> --dry-run --self-test --help\n" +
        "  --promote        write Tier-1 wins INTO live MEMORY/LEARNING/SYSTEM (additive; loadRecentWins surfaces them)\n" +
        "  --promote-praise also promote Tier-2 strong praise (incl. PT). Undo any promote: rg -l backup-harvest <pai>/MEMORY/LEARNING",
    );
    process.exit(0);
  }

  const backupsDir = (values["backups-dir"] as string) || DEFAULT_BACKUPS_DIR;
  const outDir = (values.out as string) || path.join(backupsDir, "_positive-harvest");
  const order = values.order === "newest" ? "newest" : "oldest";
  const lang = values.lang === "en" ? "en" : values.lang === "pt" ? "pt" : "both";
  const minRating = parseInt((values["min-rating"] as string) || "7", 10) || 7;
  const limit = values.limit ? parseInt(values.limit as string, 10) : undefined;

  harvest({
    backupsDir,
    outDir,
    source: values.source as string | undefined,
    includeTarballs: !values["no-tarballs"],
    minRating,
    order,
    lang,
    limit,
    dryRun: !!values["dry-run"],
    promote: !!values.promote,
    promotePraise: !!values["promote-praise"],
    paiDir: (values["pai-dir"] as string) || DEFAULT_PAI_DIR,
  }).catch((e) => {
    console.error("harvest-backup-positive failed:", e);
    process.exit(1);
  });
}

if (import.meta.main) {
  main();
}
