import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bar, dateParts } from "std/core"
import { cmdDiary, cmdOpinions, cmdSummary, cmdGrowth, parsePrimaryDA, daysAgoStr, main } from "./da-growth"

// A fixed clock so the tz-relative cutoffs are deterministic.
const NOW = new Date("2026-07-12T20:00:00Z")
const TZ = "Australia/Melbourne"

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

  test("is a YYYY-MM-DD string honoring the injected tz (Melbourne is ahead of UTC)", () => {
    // NOW = 2026-07-12T20:00:00Z → 06:00 AEST on the 13th in Melbourne (AEST = UTC+10, no DST in July).
    expect(daysAgoStr(0, NOW, TZ)).toBe("2026-07-13")
    expect(daysAgoStr(0, NOW, TZ)).toBe(dateParts(NOW, TZ).iso)
  })
})

// ── Registry primary DA parse (caller-local) ──

describe("parsePrimaryDA", () => {
  test("extracts the primary: value", () => {
    expect(parsePrimaryDA("primary: tome\nother: x")).toBe("tome")
  })
  test("empty / missing → default 'tome' (Pedro's DA; dir is ~/.claude/PAI/USER/DA/tome)", () => {
    expect(parsePrimaryDA("")).toBe("tome")
    expect(parsePrimaryDA("nothing here")).toBe("tome")
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

// Category 2 (RT-2, AD-9.3): PAI = LIFEOS_DIR || PAI_DIR || resolveFrameworkDir(HOME); the DA registry +
// diary hang off <PAI>/USER/DA/. PAI is a module const, so re-import under a controlled env (unique query
// busts Bun's cache) and observe which root main(["diary"]) actually reads the diary from.
let rt2Seq = 0
const DIARY_ENTRY =
  JSON.stringify({
    date: "2026-07-10", // within 7 days of NOW (2026-07-12)
    mood: "positive",
    avg_rating: 9,
    interaction_count: 3,
    topics: ["RT2MARKER"],
    notable_moments: [],
    learning: "",
  }) + "\n"

function seedDiary(root: string): void {
  // no registry → parsePrimaryDA defaults to "tome" (Pedro's DA)
  mkdirSync(join(root, "USER", "DA", "tome"), { recursive: true })
  writeFileSync(join(root, "USER", "DA", "tome", "diary.jsonl"), DIARY_ENTRY)
}

async function diaryOutputUnder(reimport: () => Promise<{ main: typeof main }>): Promise<string> {
  const lines: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => {
    lines.push(a.join(" "))
  }
  try {
    const mod = await reimport()
    mod.main(["diary"], NOW)
  } finally {
    console.log = orig
  }
  return lines.join("\n")
}

describe("RT-2 framework-dir resolution — PAI root (da-growth)", () => {
  const KEYS = ["LIFEOS_DIR", "PAI_DIR", "HOME"] as const
  let saved: Record<string, string | undefined>
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  test("LIFEOS_DIR wins over PAI_DIR — diary read from the LIFEOS root", async () => {
    const life = mkdtempSync(join(tmpdir(), "da-life-"))
    const pai = mkdtempSync(join(tmpdir(), "da-pai-"))
    seedDiary(life) // only LIFEOS has the diary
    process.env.LIFEOS_DIR = life
    process.env.PAI_DIR = pai
    try {
      expect(await diaryOutputUnder(() => import(`./da-growth?rt2=${rt2Seq++}`))).toContain("RT2MARKER")
    } finally {
      rmSync(life, { recursive: true, force: true })
      rmSync(pai, { recursive: true, force: true })
    }
  })

  test("PAI_DIR honored when LIFEOS_DIR unset (transition window)", async () => {
    const pai = mkdtempSync(join(tmpdir(), "da-pai-"))
    seedDiary(pai)
    delete process.env.LIFEOS_DIR
    process.env.PAI_DIR = pai
    try {
      expect(await diaryOutputUnder(() => import(`./da-growth?rt2=${rt2Seq++}`))).toContain("RT2MARKER")
    } finally {
      rmSync(pai, { recursive: true, force: true })
    }
  })

  test("neither env set → resolver reads the diary under .claude/LIFEOS of a fresh HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "da-home-"))
    seedDiary(join(home, ".claude", "LIFEOS"))
    delete process.env.LIFEOS_DIR
    delete process.env.PAI_DIR
    process.env.HOME = home
    try {
      expect(await diaryOutputUnder(() => import(`./da-growth?rt2=${rt2Seq++}`))).toContain("RT2MARKER")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
