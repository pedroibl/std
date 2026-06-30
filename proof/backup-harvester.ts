#!/usr/bin/env bun
/**
 * BackupHarvester — Recover precious personal/biographical data from old
 * Claude Code session transcripts stored in ~/Backups.
 *
 * Sibling to SessionHarvester.ts. Where SessionHarvester mines the LIVE
 * ~/.claude/projects store for terse learning lines, BackupHarvester reaches
 * into the *backups* — both extracted `.claude*` directories and the compressed
 * `*claude*.tar.gz` / `.zip` archives — aggregates across all of them, dedupes
 * the heavy overlap by session UUID, and pulls out the autobiographical
 * material (family, past events, places, health, finances, relationships,
 * identity) recorded in Pedro's own words and Tomé's, attributing each passage
 * to who said it and which backup preserved it.
 *
 * It NEVER touches the live PAI memory store. Everything lands in a separate
 * review dir (default ~/Backups/_personal-harvest/) — "dump now, merge later".
 *
 * Commands / flags:
 *   --backups-dir <path>   Root to scan          (default: ~/Backups)
 *   --out <path>           Output dir            (default: <backups-dir>/_personal-harvest)
 *   --source <path>        Harvest ONE dir or tarball instead of auto-discovery
 *   --no-tarballs          Skip the .tar.gz/.zip archives (dirs only)
 *   --min-score <n>        Min personal-theme hits to keep a session (default: 1)
 *   --limit <n>            Cap sessions parsed (testing)
 *   --dry-run              Scan + report; parse dirs only, count tarball members; write nothing
 *   --self-test            Run built-in unit assertions and exit
 *   --help
 *
 * Examples:
 *   bun BackupHarvester.ts --dry-run
 *   bun BackupHarvester.ts                          # full harvest -> ~/Backups/_personal-harvest
 *   bun BackupHarvester.ts --source ~/Backups/claude-full-backup-2026-05-27-204416.tar.gz
 *   bun BackupHarvester.ts --self-test
 */

import { parseArgs } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { contentHash, parseNdjson } from "std/core";
import { walkFiles, ensureDir, readIfExists, atomicWrite, loadJson, saveJson } from "std/fsx";
import {
  CONTEXT_BLOB_RE,
  flattenContent,
  dateOf,
  discoverBackupSources,
  extractTarball,
  type Source,
} from "./backup-harvest-common";

// ============================================================================
// Configuration
// ============================================================================

const HOME = process.env.HOME!;
const DEFAULT_BACKUPS_DIR = path.join(HOME, "Backups");

// ----------------------------------------------------------------------------
// Biographical theme patterns — RECALL-first. Over-match on purpose; the dump
// is for human review. Each key becomes a by-theme file + a tag on the passage.
// ----------------------------------------------------------------------------
const THEME_PATTERNS: Record<string, RegExp> = {
  family:
    /\b(my|our|his|her|their)\s+(mother|father|mom|mum|dad|parents?|brother|sister|son|daughter|kids?|child(ren)?|wife|husband|family|siblings?)\b|\bmy\s+family\b|\b(grand(mother|father|ma|pa|parents?)|cousins?|nephews?|nieces?|in-?laws?|step(mother|father|brother|sister|son|daughter))\b/i,
  relationships:
    /\bleo\b(?![-_])|\b(leo\s+tan|partner|boyfriend|girlfriend|husband|married|marriage|met\s+(him|at|in)|mardi\s+gras|together\s+(for|since)|fell\s+in\s+love|broke\s+up|break-?up|my\s+ex|divorce)\b/i,
  events:
    /\b(when\s+i\s+was|years?\s+ago|back\s+in|in\s+(19|20)\d\d|moved\s+to|immigrat|migrat|relocat|citizenship|graduat|dropped\s+out|got\s+(my|the)\s+job|quit|got\s+fired|laid\s+off|left\s+(brazil|australia|the\s+job)|passed\s+away|funeral|wedding|accident|diagnos|first\s+time|grew\s+up|childhood|i\s+was\s+born|born\s+in)\b/i,
  places:
    /\b(brazil|brazilian|australia|australian|melbourne|sydney|noble\s+park|s[ãa]o\s+paulo|rio\s+de\s+janeiro|bangkok|seoul|china|malaysia|fortaleza|cear[áa])\b/i,
  health:
    /\b(adhd|diagnos|mental\s+health|anxiety|depress|therapy|therapist|medication|surgery|hospital|illness|condition|burnout|insomnia|panic)\b/i,
  finance:
    /\b(my\s+(salary|income|wage|debt|savings|super(annuation)?)|in\s+debt|(i'?m|i\s+was|we'?re|going|flat|dead|stone)\s+broke|can'?t\s+afford|couldn'?t\s+afford|rent\b|mortgage|bills?\b|financially|paycheck|pay\s+cheque)\b/i,
  identity:
    /\b(my\s+name\s+is|i\s+was\s+born|i'?m\s+from|my\s+background|my\s+journey|date\s+of\s+birth|\bdob\b|passport|dual\s+citizen|pronoun)\b/i,
  life:
    /\b(my\s+(first\s+|previous\s+|last\s+|old\s+)?(job|jobs|role|career|boss|payslip|workplace)|i\s+(worked|work)\s+(at|as|in|for)|(hired|fired|laid\s+off)\s+me|i\s+(got|was)\s+(hired|fired|promoted|laid\s+off|let\s+go)|i\s+(quit|resigned)|my\s+first\s+(job|business|company)|i\s+(taught|teach)\s+myself|self-?taught|grew\s+up|growing\s+up|as\s+a\s+kid|when\s+i\s+was\s+(a\s+kid|young|little|\d)|i\s+(moved|migrated|immigrated|relocated|came)\s+to|i\s+used\s+to\s+(work|live|sell|drive|clean|cook|study|teach|be)|i\s+had\s+to\s+(work|live|sell|drive|clean|cook|leave|start)|back\s+(in\s+brazil|home|then)|receptionist|recepcionist|cleaner(?!\s+(?:path|than|here|approach|architecture|code|way|route|option|solution|version|to|build|setup|fix|cut))|barista|waiter|cashier|tutor|graduated|studied\s+at|cert(ificate)?\s+iv|eu\s+trabalh(ava|ei|o)|meu\s+(emprego|trabalho|chefe)|minha\s+fun[çc][ãa]o|me\s+contrataram|quando\s+eu\s+(era|cheguei|comecei|trabalhava|morava)|eu\s+morava|eu\s+larguei)\b/i,
  emotion:
    /\b(i\s+feel|i\s+felt|i'?m\s+afraid|i\s+was\s+afraid|i\s+regret|i'?m\s+proud|i\s+was\s+proud|ashamed|i\s+struggled|i'?m\s+worried|i'?m\s+scared|i\s+was\s+scared|lonely|grief|i\s+miss|overwhelmed|exhausted)\b/i,
};

export type Role = "pedro" | "tome" | "context" | "subagent" | "other";

export interface Event {
  role: Role;
  text: string;
  ts?: string;
}

export interface SessionDoc {
  uuid: string;
  slug: string;
  sourceLabel: string;
  startTs?: string;
  events: Event[];
}

export interface Passage {
  uuid: string;
  date: string;
  slug: string;
  role: Role;
  themes: string[];
  text: string;
  sourceLabel: string;
}

export interface FileRef {
  uuid: string;
  filePath: string;
  size: number;
  sourceLabel: string;
  isSubagent: boolean;
}

// ============================================================================
// Pure helpers
// ============================================================================

/** Pull text + role out of a single transcript event, across all line shapes. */
export function extractEventText(entry: any, isSubagent = false): Event | null {
  if (!entry || typeof entry !== "object") return null;
  const ts: string | undefined = entry.timestamp || entry.message?.timestamp;

  // Shape A: standard user/assistant turns with message.content
  const msg = entry.message;
  if (msg && msg.content != null) {
    const text = flattenContent(msg.content);
    if (!text || text.trim().length < 12) return null;
    const isCtx = CONTEXT_BLOB_RE.test(text);
    let role: Role;
    if (entry.type === "assistant" || msg.role === "assistant") {
      role = isSubagent ? "subagent" : "tome";
    } else if (entry.type === "user" || msg.role === "user") {
      role = isCtx ? "context" : isSubagent ? "context" : "pedro";
    } else {
      role = "other";
    }
    return { role, text, ts };
  }

  // Shape B: top-level content string (queue-operation, summary, hook blobs)
  if (typeof entry.content === "string" && entry.content.trim().length >= 12) {
    return { role: "context", text: entry.content, ts };
  }

  // Shape C: summary entries
  if (entry.type === "summary" && typeof entry.summary === "string") {
    return { role: "context", text: entry.summary, ts };
  }

  return null;
}

/** Which biographical themes does this text touch? */
export function themesFor(text: string): string[] {
  const hits: string[] = [];
  for (const [key, re] of Object.entries(THEME_PATTERNS)) {
    if (re.test(text)) hits.push(key);
  }
  return hits;
}

// ---- Precision gates: keep first-person disclosure, drop structural noise ----

// Structural / machine lines: markdown headers, tables, quotes, banners, skill docs.
const NOISE_RE =
  /^(\s*([#>|*\-]|\d+\.)|base directory|entering the pai|♻|━|═|⎯|🗒|🎯|🔎|🚦|📃|✅|🔧|🗣|\[\d|<system-reminder)/i;
// Code-ish lines: paths, identifiers, urls, tags, raw JSON transcript leaks — never narrative.
const CODEY_RE =
  /(~\/?\.claude|\/users\/|\.tsx?\b|\.jsonl?\b|\.md\b|function\s|const\s|=>|https?:\/\/|workers\.dev|<\/?[a-z]|`{1,3}|\bcommit\b|\bSHA-?256\b|\{"[a-z_]+":|"(parentUuid|stop_reason|tool_use|usage|cache_read_input_tokens|input_tokens|isSidechain)")/i;
// First/second person — the signature of a real disclosure ("my father", "you grew up…").
const PERSON_RE = /\b(i|i'?m|i'?ve|i'?d|i'?ll|my|me|myself|we|we'?re|our|you|you'?re|you'?ve|your)\b/i;
// Disclosure signals — catch Tomé reflecting Pedro's heart-opening in 3rd person
// ("He's providing a vulnerable response…", "Pedro is restating a deeply personal account…"),
// which PERSON_RE misses because it says he/Pedro, not I/you.
const DISCLOSURE_RE =
  /\b(vulnerable|deeply personal|emotionally (heavy|hard|loaded|charged)|opened? up|open(ed|ing)?\s+(my|his|her)\s+heart|personal (account|story|disclosure|history)|family dynamics|heartfelt|confided|grief|trauma|emotionally raw|feeling\s+'?off'?)\b/i;

/** Split an event into review-sized segments (lines, then long lines into sentences). */
export function extractSegments(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.length <= 320) {
      out.push(line);
    } else {
      for (const s of line.split(/(?<=[.!?])\s+/)) {
        const t = s.trim();
        if (t) out.push(t.length > 600 ? t.slice(0, 600) : t);
      }
    }
  }
  return out;
}

export function isNoise(seg: string): boolean {
  return NOISE_RE.test(seg) || CODEY_RE.test(seg);
}

export function isPersonal(seg: string): boolean {
  return PERSON_RE.test(seg);
}

export function isDisclosure(seg: string): boolean {
  return DISCLOSURE_RE.test(seg);
}

/** Keep the most-complete copy (largest file) per session UUID. */
export function pickBestPerUuid(refs: FileRef[]): Map<string, FileRef> {
  const best = new Map<string, FileRef>();
  for (const r of refs) {
    const key = r.isSubagent ? `${r.uuid}::sub` : r.uuid;
    const cur = best.get(key);
    if (!cur || r.size > cur.size) best.set(key, r);
  }
  return best;
}

function uuidFromFile(filePath: string): string {
  return path.basename(filePath, ".jsonl");
}

function slugFromPath(filePath: string): string {
  const m = filePath.split(/\/projects\//);
  if (m.length < 2) return "unknown";
  const after = m[1];
  const first = after.split("/")[0] || "unknown";
  return first.replace(/^-+/, "");
}

// ============================================================================
// Parsing
// ============================================================================

export function parseSession(filePath: string, sourceLabel: string, isSubagent: boolean): SessionDoc {
  const uuid = uuidFromFile(filePath);
  const slug = slugFromPath(filePath);
  const events: Event[] = [];
  let startTs: string | undefined;

  const raw = readIfExists(filePath);
  if (!raw) {
    return { uuid, slug, sourceLabel, events };
  }

  const entries = parseNdjson<any>(raw);
  for (const entry of entries) {
    const ev = extractEventText(entry, isSubagent);
    if (ev) {
      events.push(ev);
      if (ev.ts && !startTs) startTs = ev.ts;
    }
  }
  return { uuid, slug, sourceLabel, startTs, events };
}

// ============================================================================
// Source discovery
// ============================================================================

/** Recursively collect *.jsonl under a projects/ tree. */
function collectJsonl(projectsDir: string, sourceLabel: string): FileRef[] {
  const files = walkFiles(projectsDir, (p) => p.endsWith(".jsonl"));
  return files.map((full) => {
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {}
    return {
      uuid: uuidFromFile(full),
      filePath: full,
      size,
      sourceLabel,
      isSubagent: full.includes("/subagents/"),
    };
  });
}

/** Selectively extract projects/*.jsonl from a tarball into tmpRoot; return its projects dir. */
async function extractTarballJsonl(tarFile: string, tmpRoot: string): Promise<string | null> {
  const ex = await extractTarball(tarFile, tmpRoot, ["*projects*/*.jsonl"]);
  return ex.projects;
}

/** Count projects/*.jsonl members without extracting (fast dry-run preview). */
async function countTarballMembers(tarFile: string): Promise<number> {
  const { stdout } = await spawnCapture("tar", ["-tzf", tarFile]);
  if (!stdout) return 0;
  let n = 0;
  for (const line of stdout.split("\n")) {
    if (/projects\/.*\.jsonl$/.test(line) && !line.includes("/subagents/")) n++;
  }
  return n;
}

// ============================================================================
// Output writers
// ============================================================================

function roleLabel(role: Role): string {
  switch (role) {
    case "pedro":
      return "Pedro";
    case "tome":
      return "Tomé";
    case "subagent":
      return "Subagent";
    case "context":
      return "Context";
    default:
      return "—";
  }
}

function writeSessionTranscript(
  outDir: string,
  doc: SessionDoc,
  seenIn: string[],
  exclusive: boolean,
): string {
  const date = dateOf(doc.startTs);
  const short = doc.uuid.slice(0, 8);
  const fname = `${date}__${doc.slug}__${short}.md`;
  const dest = path.join(outDir, "sessions", fname);
  const lines: string[] = [
    `# Session ${short} — ${doc.slug}`,
    ``,
    `- **Date:** ${date}`,
    `- **Session UUID:** ${doc.uuid}`,
    `- **Extracted from (best copy):** ${doc.sourceLabel}`,
    `- **Also present in:** ${seenIn.filter((s) => s !== doc.sourceLabel).join(", ") || "— (this backup only)"}`,
    exclusive ? `- **⚠ EXCLUSIVE:** this session survives in **one backup only** (${doc.sourceLabel}).` : ``,
    `- **Events:** ${doc.events.length}`,
    ``,
    `---`,
    ``,
  ].filter((l) => l !== "");
  for (const ev of doc.events) {
    const t = ev.text.length > 8000 ? `${ev.text.slice(0, 8000)}\n…[truncated]` : ev.text;
    lines.push(`**${roleLabel(ev.role)}**${ev.ts ? ` · ${ev.ts.slice(0, 19)}` : ""}:`);
    lines.push("");
    lines.push(t);
    lines.push("");
  }
  atomicWrite(dest, lines.join("\n"));
  return fname;
}

// ============================================================================
// Main harvest
// ============================================================================

export interface Stats {
  sources: number;
  filesSeen: number;
  uniqueSessions: number;
  personalSessions: number;
  passages: number;
  themeCounts: Record<string, number>;
  dropNoise: number; // segments dropped as structural/code noise
  dropImpersonal: number; // segments dropped for lacking a 1st/2nd-person pronoun
}

export async function harvest(opts: {
  backupsDir: string;
  outDir: string;
  source?: string;
  includeTarballs: boolean;
  minScore: number;
  limit?: number;
  dryRun: boolean;
  loose: boolean;
}): Promise<Stats> {
  const stats: Stats = {
    sources: 0,
    filesSeen: 0,
    uniqueSessions: 0,
    personalSessions: 0,
    passages: 0,
    themeCounts: {},
    dropNoise: 0,
    dropImpersonal: 0,
  };
  const tmpExtractRoot = path.join(opts.outDir, ".tmp-extract");

  // ---- 1. Resolve sources -------------------------------------------------
  let dirSources: Source[] = [];
  let tarballSources: Source[] = [];
  let skipped: string[] = [];

  if (opts.source) {
    const s = opts.source;
    const label = path.basename(s);
    if (TARBALL_RE.test(s) || /\.zip$/i.test(s)) {
      tarballSources = [{ label, sortKey: dateOf(label), kind: "tarball", pathOnDisk: s }];
    } else {
      const projects = fs.existsSync(path.join(s, "projects"))
        ? path.join(s, "projects")
        : s;
      dirSources = [{ label, sortKey: dateOf(label), kind: "dir", pathOnDisk: projects === s ? s : path.dirname(projects) }];
    }
  } else {
    const d = discoverBackupSources(opts.backupsDir, opts.includeTarballs, opts.outDir, false);
    dirSources = d.sources.filter((s) => s.kind === "dir");
    tarballSources = d.sources.filter((s) => s.kind === "tarball");
    skipped = d.skipped;
  }
  stats.sources = dirSources.length + tarballSources.length;

  console.log(`\n📦 Sources discovered under ${opts.backupsDir}`);
  console.log(`   • ${dirSources.length} extracted dir(s) with projects/`);
  for (const s of dirSources) console.log(`     - ${s.label}`);
  console.log(`   • ${tarballSources.length} tarball(s)`);
  for (const s of tarballSources) console.log(`     - ${s.label}`);
  if (skipped.length) {
    console.log(`   • skipped:`);
    for (const s of skipped) console.log(`     - ${s}`);
  }

  // ---- 2. Collect file refs ----------------------------------------------
  const allRefs: FileRef[] = [];

  for (const s of dirSources) {
    const projects = path.join(s.pathOnDisk, "projects");
    const refs = collectJsonl(projects, s.label);
    allRefs.push(...refs);
  }

  if (opts.dryRun) {
    // Tarballs: count members only (fast), don't extract.
    for (const t of tarballSources) {
      const n = await countTarballMembers(t.pathOnDisk);
      console.log(`   ↳ ${t.label}: ${n} session jsonl member(s) [not parsed in dry-run]`);
    }
  } else {
    for (const t of tarballSources) {
      const tmp = path.join(tmpExtractRoot, t.label.replace(/[^a-z0-9._-]/gi, "_"));
      const projects = await extractTarballJsonl(t.pathOnDisk, tmp);
      if (!projects) {
        console.log(`   ⚠ ${t.label}: no projects/ jsonl extracted`);
        continue;
      }
      const refs = collectJsonl(projects, t.label);
      allRefs.push(...refs);
    }
  }

  stats.filesSeen = allRefs.length;

  // uuid -> every backup label that holds a copy (provenance / "what's left").
  const seenInMap = new Map<string, Set<string>>();
  for (const r of allRefs) {
    (seenInMap.get(r.uuid) ?? seenInMap.set(r.uuid, new Set()).get(r.uuid)!).add(r.sourceLabel);
  }

  // ---- 3. Dedup by UUID (keep largest) -----------------------------------
  const best = pickBestPerUuid(allRefs);
  stats.uniqueSessions = best.size;
  console.log(
    `\n🧮 ${allRefs.length} transcript files → ${best.size} unique sessions after dedup`,
  );

  let bestRefs = Array.from(best.values()).sort((a, b) => b.size - a.size);
  if (opts.limit) bestRefs = bestRefs.slice(0, opts.limit);

  // Fresh dump each run so outputs never mix with a prior run's files.
  // harvest-state.json lives at the root and is preserved for cross-run "what's new".
  if (!opts.dryRun) {
    fs.rmSync(path.join(opts.outDir, "sessions"), { recursive: true, force: true });
    fs.rmSync(path.join(opts.outDir, "personal"), { recursive: true, force: true });
    ensureDir(path.join(opts.outDir, "sessions"));
    ensureDir(path.join(opts.outDir, "personal", "by-theme"));
  }

  // ---- 4. Parse + classify -----------------------------------------------
  const manifest: any[] = [];
  const passageSeen = new Set<string>();
  const byTheme: Record<string, Passage[]> = {};
  const timeline: Passage[] = [];
  const rawPassages: Passage[] = [];

  for (const ref of bestRefs) {
    const doc = parseSession(ref.filePath, ref.sourceLabel, ref.isSubagent);
    if (doc.events.length === 0) continue;

    const sessionThemes = new Set<string>();
    const sessionPassages: Passage[] = [];
    const date = dateOf(doc.startTs);

    for (const ev of doc.events) {
      for (const seg of extractSegments(ev.text)) {
        if (seg.length < 25) continue;
        if (isNoise(seg)) {
          stats.dropNoise++;
          continue;
        }
        if (!opts.loose && !isPersonal(seg) && !isDisclosure(seg)) {
          stats.dropImpersonal++;
          continue;
        }
        const themes = themesFor(seg);
        if (themes.length === 0) continue;
        const h = contentHash(seg);
        if (passageSeen.has(h)) continue;
        passageSeen.add(h);

        sessionPassages.push({
          uuid: doc.uuid,
          date,
          slug: doc.slug,
          role: ev.role,
          themes,
          text: seg.length > 800 ? `${seg.slice(0, 800)}…` : seg,
          sourceLabel: doc.sourceLabel,
        });
        for (const t of themes) sessionThemes.add(t);
        if (sessionPassages.length >= 25) break; // cap so one session can't flood
      }
      if (sessionPassages.length >= 25) break;
    }

    const score = sessionThemes.size;
    const seenIn = Array.from(seenInMap.get(doc.uuid) ?? new Set([doc.sourceLabel]));
    const exclusive = seenIn.length === 1; // lives in ONE backup only — fragile/precious

    manifest.push({
      uuid: doc.uuid,
      slug: doc.slug,
      date,
      events: doc.events.length,
      personalScore: score,
      themes: Array.from(sessionThemes),
      bestFrom: doc.sourceLabel,
      seenIn,
      exclusive,
    });

    if (score < opts.minScore) continue;
    stats.personalSessions++;

    for (const p of sessionPassages) {
      stats.passages++;
      rawPassages.push(p);
      for (const t of p.themes) {
        (byTheme[t] ||= []).push(p);
        stats.themeCounts[t] = (stats.themeCounts[t] || 0) + 1;
      }
      const hasYear = /\b(19|20)\d\d\b/.test(p.text);
      if (p.themes.includes("events") || hasYear) timeline.push(p);
    }

    if (!opts.dryRun) writeSessionTranscript(opts.outDir, doc, seenIn, exclusive);
  }

  // ---- 4b. Per-source coverage ("from where" + "what's left") -------------
  type Cov = { present: number; exclusive: number; bestFrom: number; passages: number };
  const coverage: Record<string, Cov> = {};
  const cov = (label: string): Cov =>
    (coverage[label] ||= { present: 0, exclusive: 0, bestFrom: 0, passages: 0 });
  // every source that physically holds a session (from seenInMap, all sessions)
  for (const [, labels] of seenInMap) for (const l of labels) cov(l).present++;
  for (const m of manifest) {
    if (m.exclusive) cov(m.seenIn[0]).exclusive++;
    cov(m.bestFrom).bestFrom++;
  }
  for (const p of rawPassages) cov(p.sourceLabel).passages++;

  // cross-run state — which session UUIDs we've already catalogued, and where.
  const statePath = path.join(opts.outDir, "harvest-state.json");
  const prior = loadJson<any>(statePath, null);
  const priorUuids = new Set<string>(prior?.sessions ? Object.keys(prior.sessions) : []);
  const allUuids = Array.from(seenInMap.keys());
  const newUuids = allUuids.filter((u) => !priorUuids.has(u));

  // console: per-source contribution so you can see provenance each run
  console.log(`\n📒 Provenance — per backup source:`);
  for (const [label, c] of Object.entries(coverage).sort((a, b) => b[1].present - a[1].present)) {
    console.log(
      `   • ${label}: ${c.present} sessions present · ${c.exclusive} EXCLUSIVE · ${c.bestFrom} best-copy · ${c.passages} passages`,
    );
  }
  if (priorUuids.size) {
    console.log(`\n🔁 Since last run: ${newUuids.length} new session(s) of ${allUuids.length} total.`);
  }

  // ---- 5. Write outputs ---------------------------------------------------
  if (!opts.dryRun) {
    ensureDir(path.join(opts.outDir, "sessions"));
    ensureDir(path.join(opts.outDir, "personal", "by-theme"));

    // manifest
    manifest.sort((a, b) => (a.date < b.date ? -1 : 1));
    saveJson(path.join(opts.outDir, "manifest.json"), manifest);

    // by-theme files
    for (const [theme, passages] of Object.entries(byTheme)) {
      passages.sort((a, b) => (a.date < b.date ? -1 : 1));
      const lines = [`# Personal passages — ${theme}`, ``, `${passages.length} passage(s).`, ``];
      for (const p of passages) {
        lines.push(`## ${p.date} · ${roleLabel(p.role)} · _${p.slug}_  <sub>(${p.sourceLabel})</sub>`);
        lines.push("");
        lines.push(`> ${p.text.replace(/\n/g, "\n> ")}`);
        lines.push("");
      }
      atomicWrite(path.join(opts.outDir, "personal", "by-theme", `${theme}.md`), lines.join("\n"));
    }

    // timeline
    timeline.sort((a, b) => (a.date < b.date ? -1 : 1));
    const tl = [`# Personal timeline`, ``, `${timeline.length} dated/event passage(s).`, ``];
    for (const p of timeline) {
      tl.push(`### ${p.date} · ${roleLabel(p.role)} · [${p.themes.join(", ")}]`);
      tl.push(`> ${p.text.replace(/\n/g, "\n> ")}`);
      tl.push(`<sub>${p.slug} · ${p.sourceLabel}</sub>`);
      tl.push("");
    }
    atomicWrite(path.join(opts.outDir, "personal", "timeline.md"), tl.join("\n"));

    // raw passages for downstream LLM sift
    atomicWrite(
      path.join(opts.outDir, "personal", "raw-passages.jsonl"),
      rawPassages.length ? rawPassages.map((p) => JSON.stringify(p)).join("\n") + "\n" : "",
    );

    // coverage.md — provenance + what's exclusive to each backup
    const covEntries = Object.entries(coverage).sort((a, b) => b[1].present - a[1].present);
    const covLines = [
      `# Coverage — what each backup contributed`,
      ``,
      `Where every session was extracted from, and which backups hold sessions found **nowhere else**`,
      `(\`EXCLUSIVE\` — if that backup is deleted, those sessions are gone for good).`,
      ``,
      `| Backup source | Sessions present | Exclusive | Best-copy | Personal passages |`,
      `|---|--:|--:|--:|--:|`,
      ...covEntries.map(
        ([l, c]) => `| ${l} | ${c.present} | ${c.exclusive} | ${c.bestFrom} | ${c.passages} |`,
      ),
      ``,
      `## Sessions exclusive to a single backup`,
      `These are the fragile ones — keep these backups until merged.`,
      ``,
      ...manifest
        .filter((m: any) => m.exclusive)
        .sort((a: any, b: any) => (a.date < b.date ? -1 : 1))
        .map((m: any) => `- \`${m.date}\` ${m.slug} (${m.uuid.slice(0, 8)}) — **only in** ${m.seenIn[0]}`),
      ``,
    ];
    atomicWrite(path.join(opts.outDir, "coverage.md"), covLines.join("\n"));

    // harvest-state.json — cross-run memory of what's been catalogued + from where
    const sessionsState: Record<string, any> = {};
    for (const m of manifest) {
      sessionsState[m.uuid] = { date: m.date, bestFrom: m.bestFrom, seenIn: m.seenIn, personalScore: m.personalScore };
    }
    saveJson(statePath, {
      sources: Object.keys(coverage),
      totalSessions: allUuids.length,
      newThisRun: newUuids.length,
      sessions: sessionsState,
    });

    // index
    const idx = [
      `# Personal harvest from ~/Backups`,
      ``,
      `Generated by BackupHarvester.ts. **Review-only dump — not merged into PAI memory.**`,
      ``,
      `- Sources scanned: **${stats.sources}**`,
      `- Transcript files seen: **${stats.filesSeen}**`,
      `- Unique sessions (deduped): **${stats.uniqueSessions}**`,
      `- Sessions with personal content (score ≥ ${opts.minScore}): **${stats.personalSessions}**`,
      `- Personal passages extracted: **${stats.passages}**`,
      `- Sessions exclusive to one backup: **${manifest.filter((m: any) => m.exclusive).length}**`,
      priorUuids.size ? `- New sessions since last run: **${newUuids.length}**` : ``,
      ``,
      `## Theme hit counts`,
      ``,
      ...Object.entries(stats.themeCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `- **${k}**: ${v}`),
      ``,
      `## Layout`,
      `- \`coverage.md\` — **where each session came from**, and which backups hold sessions found nowhere else (what's left to preserve).`,
      `- \`harvest-state.json\` — cross-run memory; re-running reports only what's new.`,
      `- \`manifest.json\` — every unique session: date, themes, source(s) that held it, exclusive flag.`,
      `- \`sessions/<date>__<slug>__<id>.md\` — full deduped transcripts (Pedro/Tomé attributed).`,
      `- \`personal/by-theme/*.md\` — passages grouped by biographical theme.`,
      `- \`personal/timeline.md\` — dated/event passages, chronological.`,
      `- \`personal/raw-passages.jsonl\` — machine-readable, for a later LLM sift / merge pass.`,
      ``,
    ];
    atomicWrite(path.join(opts.outDir, "index.md"), idx.join("\n"));

    // cleanup temp extraction
    try {
      fs.rmSync(tmpExtractRoot, { recursive: true, force: true });
    } catch {}
  }

  return stats;
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
      "min-score": { type: "string" },
      limit: { type: "string" },
      loose: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "self-test": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(
      "BackupHarvester.ts — recover personal data from ~/Backups .claude session transcripts.\n" +
        "Flags: --backups-dir --out --source --no-tarballs --min-score --limit --dry-run --self-test\n" +
        "See the file header for examples.",
    );
    return;
  }

  const backupsDir = values["backups-dir"] || DEFAULT_BACKUPS_DIR;
  const outDir = values.out || path.join(backupsDir, "_personal-harvest");
  const minScore = values["min-score"] ? parseInt(values["min-score"], 10) : 1;
  const limit = values.limit ? parseInt(values.limit, 10) : undefined;
  const dryRun = !!values["dry-run"];

  console.log(`\n🌾 BackupHarvester — ${dryRun ? "DRY RUN (no writes)" : "harvesting"}`);
  console.log(`   out: ${dryRun ? "(none)" : outDir}  ·  min-score: ${minScore}${limit ? `  ·  limit: ${limit}` : ""}`);

  harvest({
    backupsDir,
    outDir,
    source: values.source,
    includeTarballs: !values["no-tarballs"],
    minScore,
    limit,
    dryRun,
    loose: !!values.loose,
  })
    .then((stats) => {
      console.log(`\n✅ ${dryRun ? "Preview" : "Harvest"} complete`);
      console.log(`   unique sessions:   ${stats.uniqueSessions}`);
      console.log(`   personal sessions: ${stats.personalSessions}`);
      console.log(`   passages kept:     ${stats.passages}`);
      console.log(`   dropped — noise:   ${stats.dropNoise}  ·  impersonal (no pronoun): ${stats.dropImpersonal}${values.loose ? " [loose: pronoun gate OFF]" : ""}`);
      const themes = Object.entries(stats.themeCounts).sort((a, b) => b[1] - a[1]);
      if (themes.length) console.log(`   themes:            ${themes.map(([k, v]) => `${k}:${v}`).join("  ")}`);
      if (!dryRun) console.log(`\n   → ${path.join(outDir, "index.md")}`);
    })
    .catch((e) => {
      console.error("BackupHarvester failed:", e);
      process.exit(1);
    });
}

if (import.meta.main) {
  main();
}
