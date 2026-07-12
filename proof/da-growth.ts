#!/usr/bin/env bun
/**
 * DAGrowth — Story 12.4 rewrite onto the std substrate (proof/ consumer; live cutover to
 * ~/.claude/PAI/TOOLS staged for Pedro under AD-9.2). View diary entries, opinions, growth events,
 * and a summary for the primary DA. Behavior preserved to the byte; re-rolled fs/arg/date/text
 * plumbing now imports tested std primitives.
 *
 * Kept caller-local (D4): the `~/.claude/PAI` path roots, the `Australia/Melbourne` timezone (Pedro is
 * in Melbourne, AU — NOT the PAI template's `America/Los_Angeles`), the
 * `primary:` registry regex, the opinions.yaml `- topic:` block parse + per-key `get()`, the mood
 * icon map, the diary/growth aggregation, and every column layout string. Paths, `now`, and `tz` are
 * injected at the edge so the tests are hermetic.
 *
 * Usage:
 *   bun proof/da-growth.ts diary           # Last 7 diary entries
 *   bun proof/da-growth.ts diary --days 30 # Last 30 days
 *   bun proof/da-growth.ts opinions        # Current opinions
 *   bun proof/da-growth.ts growth          # Growth event log
 *   bun proof/da-growth.ts summary         # Overview
 */

import { join } from "path"
import { bar, dispatch, dateParts, flagValue, parseNdjson, truncate } from "std/core"
import { readIfExists, resolveFrameworkDir } from "std/fsx"

// ── Caller-local identity (D4) ──

const HOME = process.env.HOME ?? "~"
const PAI = process.env.LIFEOS_DIR || process.env.PAI_DIR || resolveFrameworkDir(HOME)
const REGISTRY_PATH = join(PAI, "USER", "DA", "_registry.yaml")
const TZ = "Australia/Melbourne"

// ── Types ──

interface DiaryEntry {
  date: string
  interaction_count: number
  topics: string[]
  mood: "positive" | "neutral" | "frustrated"
  avg_rating: number
  notable_moments: string[]
  learning: string | null
}

interface GrowthEvent {
  date: string
  type: string
  detail: string
}

// ── Helpers ──

export function parsePrimaryDA(content: string): string {
  const match = content.match(/^primary:\s*(\S+)/m)
  return match?.[1] ?? "tome"
}

/** Load a JSONL file, skipping malformed lines. Missing file → []. */
function readJSONL<T>(path: string): T[] {
  return parseNdjson<T>(readIfExists(path) ?? "")
}

/** `YYYY-MM-DD` for `days` before `now`, in the injected timezone. */
export function daysAgoStr(days: number, now: Date, tz: string): string {
  return dateParts(new Date(now.getTime() - days * 24 * 60 * 60 * 1000), tz).iso
}

const MOOD_ICON: Record<string, string> = {
  positive: "+",
  neutral: "~",
  frustrated: "-",
}

// ── Commands (return the exact console.log call sequence as an array of lines) ──

export function cmdDiary(daDir: string, days: number, now: Date, tz: string): string[] {
  const out: string[] = []
  const entries = readJSONL<DiaryEntry>(join(daDir, "diary.jsonl"))
  const cutoff = daysAgoStr(days, now, tz)
  const recent = entries.filter((e) => e.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date))

  if (recent.length === 0) {
    out.push(`No diary entries in the last ${days} days.`)
    return out
  }

  out.push(`\n  DA Diary — Last ${days} Days (${recent.length} entries)\n`)
  out.push("  DATE        MOOD  RATING  SESSIONS  TOPICS")
  out.push("  " + "-".repeat(70))

  for (const e of recent) {
    const moodChar = MOOD_ICON[e.mood] ?? "?"
    const topics = e.topics.slice(0, 3).join(", ")
    const truncTopics = truncate(topics, 40)
    out.push(`  ${e.date}  [${moodChar}]   ${e.avg_rating.toFixed(1).padStart(4)}    ${String(e.interaction_count).padStart(4)}      ${truncTopics}`)
  }

  // Show last entry details
  const last = recent[recent.length - 1]
  out.push(`\n  Latest (${last.date}):`)
  if (last.notable_moments.length > 0) {
    for (const m of last.notable_moments) {
      out.push(`    * ${m}`)
    }
  }
  if (last.learning) {
    out.push(`    Learning: ${last.learning}`)
  }
  out.push("")
  return out
}

export function cmdOpinions(daDir: string): string[] {
  const out: string[] = []
  const content = readIfExists(join(daDir, "opinions.yaml")) ?? ""

  if (!content.includes("topic:")) {
    out.push("\n  No opinions formed yet.\n")
    return out
  }

  // Simple parse for display
  const blocks = content.split(/^\s*- topic:/m).slice(1)
  const opinions: Array<{ topic: string; position: string; confidence: number; confirmations: number; contradictions: number }> = []

  for (const block of blocks) {
    const get = (key: string) => {
      const m = block.match(new RegExp(`${key}:\\s*"?(.+?)"?\\s*$`, "m"))
      return m?.[1] ?? ""
    }
    opinions.push({
      topic: get("topic"),
      position: get("position"),
      confidence: parseFloat(get("confidence") || "0"),
      confirmations: parseInt(get("confirmations") || "0", 10),
      contradictions: parseInt(get("contradictions") || "0", 10),
    })
  }

  if (opinions.length === 0) {
    out.push("\n  No opinions formed yet.\n")
    return out
  }

  opinions.sort((a, b) => b.confidence - a.confidence)

  out.push(`\n  DA Opinions (${opinions.length} total)\n`)
  out.push("  CONF   +/-     TOPIC")
  out.push("  " + "-".repeat(60))

  for (const o of opinions) {
    const track = bar(Math.round(o.confidence * 10), 10, { fillChar: "#", emptyChar: ".", brackets: false })
    out.push(`  [${track}] ${String(o.confirmations).padStart(2)}/${String(o.contradictions).padStart(2)}  ${o.topic}`)
    out.push(`  ${"".padStart(15)}${o.position}`)
  }
  out.push("")
  return out
}

export function cmdGrowth(daDir: string): string[] {
  const out: string[] = []
  const events = readJSONL<GrowthEvent>(join(daDir, "growth.jsonl"))

  if (events.length === 0) {
    out.push("\n  No growth events recorded yet.\n")
    return out
  }

  // Show last 20
  const recent = events.slice(-20)
  out.push(`\n  Growth Log (${events.length} total, showing last ${recent.length})\n`)

  for (const e of recent) {
    const typeTag = e.type.replace("opinion_", "").replace("trait_", "").toUpperCase().padEnd(12)
    out.push(`  ${e.date}  ${typeTag}  ${e.detail}`)
  }
  out.push("")
  return out
}

export function cmdSummary(daDir: string, now: Date, tz: string): string[] {
  const out: string[] = []
  const entries = readJSONL<DiaryEntry>(join(daDir, "diary.jsonl"))
  const events = readJSONL<GrowthEvent>(join(daDir, "growth.jsonl"))
  const opinionsContent = readIfExists(join(daDir, "opinions.yaml")) ?? ""
  const opinionCount = (opinionsContent.match(/- topic:/g) ?? []).length

  const last7 = entries.filter((e) => e.date >= daysAgoStr(7, now, tz))
  const last30 = entries.filter((e) => e.date >= daysAgoStr(30, now, tz))
  const totalSessions = entries.reduce((sum, e) => sum + e.interaction_count, 0)
  const avgRating7d = last7.length > 0
    ? (last7.reduce((sum, e) => sum + e.avg_rating, 0) / last7.length).toFixed(1)
    : "n/a"
  const avgRating30d = last30.length > 0
    ? (last30.reduce((sum, e) => sum + e.avg_rating, 0) / last30.length).toFixed(1)
    : "n/a"
  const moodCounts = entries.reduce(
    (acc, e) => { acc[e.mood] = (acc[e.mood] ?? 0) + 1; return acc },
    {} as Record<string, number>
  )

  out.push("\n  DA Growth Summary")
  out.push("  " + "=".repeat(40))
  out.push(`  Diary entries:     ${entries.length} total (${last7.length} this week, ${last30.length} this month)`)
  out.push(`  Total sessions:    ${totalSessions}`)
  out.push(`  Avg rating (7d):   ${avgRating7d}`)
  out.push(`  Avg rating (30d):  ${avgRating30d}`)
  out.push(`  Mood breakdown:    + ${moodCounts.positive ?? 0}  ~ ${moodCounts.neutral ?? 0}  - ${moodCounts.frustrated ?? 0}`)
  out.push(`  Opinions:          ${opinionCount}`)
  out.push(`  Growth events:     ${events.length}`)

  if (entries.length > 0) {
    out.push(`  First entry:       ${entries[0].date}`)
    out.push(`  Latest entry:      ${entries[entries.length - 1].date}`)
  }
  out.push("")
  return out
}

// ── CLI Entry ──

function emit(out: string[]): void {
  for (const line of out) console.log(line)
}

export function main(argv: string[] = process.argv.slice(2), now: Date = new Date()): number {
  const args = argv
  const command = args[0] ?? "summary"

  const primaryDA = parsePrimaryDA(readIfExists(REGISTRY_PATH) ?? "")
  const daDir = join(PAI, "USER", "DA", primaryDA)

  return dispatch(
    command,
    {
      diary: () => {
        const daysStr = flagValue(args, "days")
        const days = daysStr !== undefined ? (parseInt(daysStr, 10) || 7) : 7
        emit(cmdDiary(daDir, days, now, TZ))
        return 0
      },
      opinions: () => {
        emit(cmdOpinions(daDir))
        return 0
      },
      growth: () => {
        emit(cmdGrowth(daDir))
        return 0
      },
      summary: () => {
        emit(cmdSummary(daDir, now, TZ))
        return 0
      },
    },
    () => {
      console.log(`Unknown command: ${command}`)
      console.log("Usage: bun DAGrowth.ts [diary|opinions|growth|summary] [--days N]")
      return 1
    },
  )
}

if (import.meta.main) {
  process.exit(main())
}
