import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bar, dateParts } from "std/core"
import { cmdDiary, cmdOpinions, cmdSummary, cmdGrowth, parsePrimaryDA, daysAgoStr, main } from "./da-growth"

// A fixed clock so the tz-relative cutoffs are deterministic.
const NOW = new Date("2026-07-12T20:00:00Z")
const TZ = "America/Los_Angeles"

function makeDaDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "da-growth-"))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
  return dir
}

// ── Confidence-bar byte parity (the promotion oracle) ──

describe("confidence bar — core.bar ≡ original padEnd skeleton", () => {
  // ORIGINAL: `"#".repeat(Math.round(c*10)).padEnd(10, ".")`
  const original = (c: number): string => "#".repeat(Math.round(c * 10)).padEnd(10, ".")
  // REPLACEMENT: the exact call used in cmdOpinions.
  const replacement = (c: number): string =>
    bar(Math.round(c * 10), 10, { fillChar: "#", emptyChar: ".", brackets: false })

  test("byte-identical across the valid confidence range [0,1]", () => {
    for (const c of [0, 0.05, 0.1, 0.14, 0.25, 0.5, 0.55, 0.7, 0.849, 0.95, 1.0]) {
      expect(replacement(c)).toBe(original(c))
    }
  })

  test("track is always exactly 10 chars of '#'/'.'", () => {
    for (const c of [0, 0.3, 0.7, 1.0]) {
      const t = replacement(c)
      expect(t.length).toBe(10)
      expect(/^#*\.*$/.test(t)).toBe(true)
    }
  })
})

// ── JSONL load via parseNdjson ──

describe("readJSONL via parseNdjson(readIfExists ?? '')", () => {
  test("loads well-formed lines and skips malformed ones", () => {
    const dir = makeDaDir({
      "diary.jsonl": [
        JSON.stringify({ date: "2026-07-11", interaction_count: 3, topics: ["a"], mood: "positive", avg_rating: 4.2, notable_moments: [], learning: null }),
        "{ not valid json",
        JSON.stringify({ date: "2026-07-12", interaction_count: 5, topics: ["b", "c"], mood: "neutral", avg_rating: 3.0, notable_moments: ["did x"], learning: "learned y" }),
      ].join("\n"),
    })
    const out = cmdDiary(dir, 30, NOW, TZ)
    // header line reports the count of parsed (valid) entries
    expect(out[0]).toContain("(2 entries)")
    // both dates appear, malformed line silently dropped
    expect(out.join("\n")).toContain("2026-07-11")
    expect(out.join("\n")).toContain("2026-07-12")
  })

  test("missing file → empty result → 'No diary entries' message", () => {
    const dir = makeDaDir({}) // no diary.jsonl
    const out = cmdDiary(dir, 7, NOW, TZ)
    expect(out).toEqual(["No diary entries in the last 7 days."])
  })
})

// ── Date formatting via dateParts with injected tz + now ──

describe("daysAgoStr — dateParts(now-Ndays, tz).iso", () => {
  test("matches the original toLocaleDateString('en-CA', {timeZone}) output", () => {
    for (const days of [0, 1, 7, 30, 365]) {
      const past = new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)
      const originalStr = past.toLocaleDateString("en-CA", { timeZone: TZ })
      expect(daysAgoStr(days, NOW, TZ)).toBe(originalStr)
    }
  })

  test("is a YYYY-MM-DD string honoring the injected tz (LA is behind UTC)", () => {
    // NOW = 2026-07-12T20:00:00Z → 13:00 in LA on the 12th.
    expect(daysAgoStr(0, NOW, TZ)).toBe("2026-07-12")
    expect(daysAgoStr(0, NOW, TZ)).toBe(dateParts(NOW, TZ).iso)
  })
})

// ── Registry primary DA parse (caller-local) ──

describe("parsePrimaryDA", () => {
  test("extracts the primary: value", () => {
    expect(parsePrimaryDA("primary: tome\nother: x")).toBe("tome")
  })
  test("empty / missing → default 'kai'", () => {
    expect(parsePrimaryDA("")).toBe("kai")
    expect(parsePrimaryDA("nothing here")).toBe("kai")
  })
})

// ── Opinions rendering (bar + caller-local yaml parse) ──

describe("cmdOpinions", () => {
  test("renders a confidence bar with caller-owned brackets + counts suffix", () => {
    const yaml = [
      "- topic: retrieval",
      '  position: "retrieval beats recall"',
      "  confidence: 0.7",
      "  confirmations: 5",
      "  contradictions: 1",
    ].join("\n")
    const dir = makeDaDir({ "opinions.yaml": yaml })
    const out = cmdOpinions(dir)
    const joined = out.join("\n")
    expect(joined).toContain("(1 total)")
    // brackets + bar (10 wide) + counts suffix are caller-owned; topic renders empty because the
    // `- topic:` split consumes the label (faithful to the original's get("topic") === "").
    const barExpected = "#".repeat(7).padEnd(10, ".")
    expect(joined).toContain(`[${barExpected}]  5/ 1  `)
    expect(joined).toContain("retrieval beats recall")
  })

  test("no topics → 'No opinions formed yet.'", () => {
    const dir = makeDaDir({ "opinions.yaml": "# nothing\n" })
    expect(cmdOpinions(dir)).toEqual(["\n  No opinions formed yet.\n"])
  })
})

// ── Growth + summary smoke (aggregation stays caller-local) ──

describe("cmdGrowth + cmdSummary", () => {
  test("growth log shows tagged events", () => {
    const dir = makeDaDir({
      "growth.jsonl": JSON.stringify({ date: "2026-07-10", type: "opinion_formed", detail: "new stance" }),
    })
    const out = cmdGrowth(dir)
    const joined = out.join("\n")
    expect(joined).toContain("(1 total, showing last 1)")
    expect(joined).toContain("2026-07-10")
    expect(joined).toContain("FORMED") // "opinion_" stripped, uppercased
  })

  test("summary aggregates entries + mood counts", () => {
    const dir = makeDaDir({
      "diary.jsonl": [
        JSON.stringify({ date: "2026-07-11", interaction_count: 3, topics: [], mood: "positive", avg_rating: 4.0, notable_moments: [], learning: null }),
        JSON.stringify({ date: "2026-07-12", interaction_count: 2, topics: [], mood: "neutral", avg_rating: 3.0, notable_moments: [], learning: null }),
      ].join("\n"),
      "opinions.yaml": "- topic: x\n  confidence: 0.5\n",
      "growth.jsonl": JSON.stringify({ date: "2026-07-01", type: "trait_shift", detail: "d" }),
    })
    const out = cmdSummary(dir, NOW, TZ)
    const joined = out.join("\n")
    expect(joined).toContain("Diary entries:     2 total")
    expect(joined).toContain("Total sessions:    5")
    expect(joined).toContain("+ 1  ~ 1  - 0")
    expect(joined).toContain("Opinions:          1")
    expect(joined).toContain("Growth events:     1")
  })
})

// ── main() dispatch + exit codes ──

describe("main dispatch", () => {
  test("unknown command → exit 1", () => {
    expect(main(["frobnicate"], NOW)).toBe(1)
  })
  test("known command → exit 0", () => {
    // summary reads the real (likely absent) daDir; still returns 0.
    expect(main(["summary"], NOW)).toBe(0)
  })
})
