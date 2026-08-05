// The structural apply gate for Story 2.4 (FR-9, FR-10, SM-8, NK-4 rule 4).
//
// WHAT THIS GATE PROVES, AND WHAT IT DOES NOT. It proves the gated apply surface is authored with the
// field the harness reads, that the field is still spelled the way the INSTALLED harness spells it, that
// the file is visible to the harness at all, and that the preview path leaves a fixture byte-identical
// while the apply path does not. It does NOT prove the harness HONOURS the gate: `bun test` runs under
// `bun`, not under Claude Code, so no test here can observe an invocation decision. That claim is the
// manual step recorded in the story's Debug Log (Task 4). A gate that greps a markdown file and calls the
// result "the model cannot reach this" would be the vacuity this loop exists to catch.
//
// 🔴 THE FAILURE THIS GUARDS AGAINST FAILS **OPEN**, WHICH IS WHY GATE (b) IS NOT OPTIONAL. Re-derived
// from the installed 2.1.222 bundle: the `.strict()` frontmatter schemas have exactly ONE consumer,
// `iNt(e,t)`, which `safeParse`s, emits `tengu_frontmatter_shadow_unknown_key` telemetry, wraps its body
// in `try{}catch{}`, and has its return value DISCARDED at all four call sites. The value the runtime
// actually gates on is read straight off the parsed YAML — `disableModelInvocation:rlr(e["disable-model-
// invocation"])`, where `rlr(x) = Pme(x) ?? false`. Zod is never on the read path. So an upstream RENAME
// of this key does not reject the file: the key is ignored, the skill loads normally, `?? false` makes it
// ungated, and the apply surface silently becomes model-invocable again. The harness's default for a
// missing gate key is the PERMISSIVE one, which is why gate (a) asserts `=== "true"` and never truthiness.
//
// ⚠ IT IS NOT NAMED `core-*`, deliberately: `check:core-purity` globs `src/notekit/core-*.ts`, and this
// file reads the filesystem and spawns subprocesses. ⚠ IT MUST KEEP THE `.test.ts` SUFFIX: Story 2.2's
// sole-writer gate globs `src/notekit/**/*.ts` minus `*.test.ts`, so this file sits inside that glob and
// is excluded PURELY by its suffix. Renaming it off `.test.ts` puts it under a scan it was never written
// to satisfy.
//
// ⚠ THIS FILE NECESSARILY CONTAINS EVERY TOKEN IT BANS, as its own lists. It scans THE THREE AUTHORED
// MARKDOWN FILES ONLY, never itself — a self-scan would be permanently red, and hiding the lists behind
// an indirection to dodge that would make it permanently green. Vacuous either way, so the scope is fixed
// and stated. Same call 2.1's AC #4(b) and 2.3's Task 3 made, for the same reason.
//
// ⚠ THE NINE ERROR CODES ARE HARDCODED HERE, and the cost is real. Story 2.1 exports
// `NotekitReadErrorCode` / `NotekitErrorCode` as TYPES ONLY (`src/cli/notekit-read.ts:62,74`) and 2.2
// exports its three the same way (`src/cli/notekit-write.ts:39-41`) — a TS union erases at runtime, and
// `core-renderspec.ts`'s `KNOWN_CODES` mirror is not exported and covers only its own two. So these lists
// are COPIES, and a copy drifts: the day either union gains a member, these arrays must gain it too and
// nothing mechanical will say so.
//
// ⚠ IMPORTING `probeKeySpelling` FROM A `.test.ts` FILE ALSO PULLS IN THAT FILE'S TESTS — but it does
// NOT double-count them, and the difference matters enough to state precisely rather than guess at.
// Measured 2026-08-06 at bun 1.3.14: this file ALONE reports 104 tests (its own 40 + 2.3's 64); this file
// and `notewright-dispatch.test.ts` as TWO explicit entries also report 104, not 168; and the full-suite
// delta from adding this file is exactly +40. Bun's module registry evaluates the imported module once
// and attributes its tests to whichever entry loaded it first, so the import yields a SUPERSET run when
// this file is run alone, never a duplicated suite. The practical consequence is only this: running this
// gate on its own also runs 2.3's, which is harmless.
//
// The import is deliberate. Story 2.4's ⚠️-1 rules that a COPY of the probe is worse — it would give the
// estate's only frontmatter-expiry guard two sources of truth, and the day one is fixed the other rots
// silently. That is not hypothetical here: breaking the probe's body was watched reddening 2.3's
// COUNTERFACTUAL 5/5b AND this file's COUNTERFACTUAL 3/3b in the same run, which is exactly the coupling
// a copy would have severed. 2.4's scope admits no new `src/**` SOURCE file to hoist it into; the clean
// long-term home — a shared non-test module owning the probe — needs a story whose scope allows one.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../core";
import { statMtime } from "../fsx";
import { locateFence } from "./core-fence";
import { probeKeySpelling } from "./notewright-dispatch.test";

// ── the three files under test ───────────────────────────────────────────────────────────────────
// Resolved from `import.meta.dir`, never cwd: `bun test` inherits whatever directory it was launched
// from. Two levels up reaches the repo root from `src/notekit/` — the same move
// `src/cli/notekit-deploy.test.ts` makes from `src/cli/`.
const REPO = join(import.meta.dir, "..", "..");
const APPLY = join(REPO, ".claude", "skills", "notewright-apply", "SKILL.md");
const PREVIEW = join(REPO, ".claude", "skills", "notewright", "SKILL.md");
const AGENT = join(REPO, ".claude", "agents", "notewright.md");

const applyText = readFileSync(APPLY, "utf8");
const previewText = readFileSync(PREVIEW, "utf8");
const agentText = readFileSync(AGENT, "utf8");

/** AC #1 — the closed seven-key set on the gated surface. */
const APPLY_KEYS = [
  "name", "description", "argument-hint", "context", "agent", "background", "disable-model-invocation",
];

/** The gate key, and its inverse twin — adjacent in the same shipped schema block. */
const GATE_KEY = "disable-model-invocation";
const TWIN_KEY = "user-invocable";
/** The harness's own English description of the gate. Anchors gate (b); English does not churn, minified
 *  identifiers (`jL`, `Qpt`, `Xpt`) do. */
const GATE_ANCHOR = "If true, the model cannot invoke this via the Skill tool";

/** AC #5 — the six read-path codes (2.1 + core) and 2.2's three apply-path codes. 6 + 3 = 9. */
const READ_CODES = [
  "nk-note-unreadable", "nk-no-opt-in", "nk-no-fence", "nk-unknown-type",
  "nk-missing-field", "nk-unknown-version",
];
const APPLY_CODES = ["nk-note-changed", "nk-write-failed", "nk-write-unverified"];
const NINE_CODES = [...READ_CODES, ...APPLY_CODES];

/**
 * `nk-` tokens the apply body may legitimately carry that are NOT error codes.
 *
 * ⚠ THIS LIST IS WHY THE SCAN IS NOT A WILDCARD. A naive `nk-[a-z-]+` sweep treats every `nk-` token as
 * a candidate tenth code and reddens against a CORRECT file the moment the body names the frontmatter
 * opt-in key or a spec version. Both populations are declared explicitly instead, so a genuinely
 * unknown token — the thing this gate exists to find — still has nowhere to hide.
 */
const NON_CODE_TOKENS = ["nk-type", "nk-v1", "nk-cap-v1", "nk-card"];

/** The apply flag, split so this file's own lists cannot trip a future whole-tree scan (2.3's idiom). */
const APPLY_FLAG = "--" + "apply";

// ── pure functions: every gate is one, so every gate has a watched counterfactual ────────────────

/** Own-property keys of a frontmatter block, in file order. */
function frontmatterKeys(text: string): string[] {
  return Object.keys(parseFrontmatter(text));
}

/**
 * Keys present that are NOT in `allowed`.
 * ⚠ MEMBERSHIP IS A `Set`, NEVER `key in obj` — `in` walks the prototype chain, so a frontmatter key
 * named `constructor`, `toString`, `valueOf` or `__proto__` would test as "allowed" against an object
 * literal and slip straight through. That is the exact hole the Epic-1 retro records a fix reopening.
 */
function strayKeys(text: string, allowed: string[]): string[] {
  const ok = new Set(allowed);
  return frontmatterKeys(text).filter((k) => !ok.has(k));
}

/** Every `nk-`-prefixed token, lowercased. Case-insensitive so `NK-CARD` cannot walk past. */
function nkTokens(text: string): string[] {
  return [...text.matchAll(/nk-[a-z][a-z0-9-]*/gi)].map((m) => m[0].toLowerCase());
}

/** Occurrences of a literal — a count, not a boolean, because the split is 0 / 0 / ≥1. */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * The gate field's value as the frontmatter parser actually returns it.
 *
 * ⚠ `parseFrontmatter` RETURNS `Record<string, string | string[]>` AND NEVER A BOOLEAN (`src/core/
 * parse.ts`). The YAML `true` arrives as the STRING `"true"`; a list value arrives as `string[]`; a
 * valueless key arrives as `""`. Every caller below therefore checks the TYPE before comparing, or a
 * list-shaped value would fail the comparison for the wrong reason.
 */
function gateValue(text: string): string | string[] | undefined {
  const fm = parseFrontmatter(text);
  return Object.hasOwn(fm, GATE_KEY) ? fm[GATE_KEY] : undefined;
}

/** The gate as the harness reads it: present, a string, and exactly `"true"`. Never truthiness. */
function isGated(text: string): boolean {
  const v = gateValue(text);
  return typeof v === "string" && v === "true";
}

type Fingerprint = {
  listing: string[];
  bytes: Record<string, string>;
  mtime: Record<string, number>;
};

/**
 * 2.1 AC #4(a)'s three-component fingerprint, cloned rather than reinvented.
 *
 * The SORTED RECURSIVE LISTING catches creation and deletion of files and directories; the RAW BYTES of
 * every regular file carry the actual claim; `fsx.statMtime` is a supporting signal only.
 *
 * ⚠ NOT `core.contentHash` — it collapses whitespace, lowercases and truncates at 400 chars, so a
 * whitespace-only rewrite hashes identically and the comparison would pass while the file changed. That
 * is precisely the change this fixture makes. ⚠ NOT `fsx.walkFiles` — it is fail-soft per directory and
 * returns files only, so an unreadable directory silently vanishes from BOTH sides of the compare.
 * ⚠ `statMtime` IS FAIL-SOFT (any stat error, ENOENT included, returns `0`), so it cannot tell "deleted"
 * from "unstatable" — the listing and the byte compare are what carry the claim.
 */
function fingerprint(dir: string): Fingerprint {
  const listing = readdirSync(dir, { recursive: true }).map(String).sort();
  const bytes: Record<string, string> = {};
  const mtime: Record<string, number> = {};
  for (const rel of listing) {
    const p = join(dir, rel);
    if (!statSync(p).isFile()) continue;
    bytes[rel] = readFileSync(p).toString("base64"); // raw bytes, compared verbatim
    mtime[rel] = statMtime(p);
  }
  return { listing, bytes, mtime };
}

/** A cold `std` subprocess through THIS checkout. */
function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ["bun", join(REPO, "src", "cli", "main.ts"), ...args],
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

// ═══ GATE (a) — field presence + referential integrity ════════════════════════════════════════════
// Runs FIRST and needs no external binary, so it reports before anything can be skipped.

describe("apply gate (a) — the gate field is present, correctly typed, and points at a real agent", () => {
  test("the path depth is right before anything else is asserted", () => {
    // A wrong `../` count would otherwise surface as a confusing ENOENT four assertions later.
    expect(existsSync(join(REPO, "package.json"))).toBe(true);
    expect(existsSync(APPLY)).toBe(true);
  });

  test("AC #1 — the gate is the STRING `true`, asserted by type then by value", () => {
    const v = gateValue(applyText);
    expect(typeof v).toBe("string");       // a list value is `string[]`; comparing first would mislead
    expect(v).toBe("true");                // never `Boolean(v)`, which passes on the string "false"
    expect(isGated(applyText)).toBe(true);
  });

  test("AC #1 — the three composed keys carry the values the fork needs", () => {
    const fm = parseFrontmatter(applyText);
    expect(fm.context).toBe("fork");
    expect(fm.agent).toBe("notewright");
    expect(fm.background).toBe("false");   // the STRING — see `gateValue`'s note
  });

  test("AC #1 — `user-invocable`, the inverse twin, is ABSENT", () => {
    // It sits immediately beside the gate in the same shipped schema block and its description is the
    // exact inversion: "If false, hides the slash command from users; only the model can invoke it via
    // the Skill tool." A dev reaching for "the invocation-control key" can land on the wrong one and
    // ship a surface only the model can reach. Absence is asserted, not merely the gate's presence.
    expect(Object.hasOwn(parseFrontmatter(applyText), TWIN_KEY)).toBe(false);
  });

  test("AC #1 — exactly the seven keys, and no eighth", () => {
    expect(strayKeys(applyText, APPLY_KEYS)).toEqual([]);
    expect(frontmatterKeys(applyText).sort()).toEqual([...APPLY_KEYS].sort());
    expect(APPLY_KEYS.length).toBe(7);
  });

  test("AC #1 — a prototype-chain key name cannot masquerade as allowed", () => {
    // `strayKeys` uses a Set. Proving the guard rather than asserting the doctrine.
    const forged = "---\nname: x\nconstructor: y\ntoString: z\n---\n";
    expect(strayKeys(forged, ["name"]).sort()).toEqual(["constructor", "toString"]);
    // And a bare `fm[k]` read on an ABSENT key must not resolve through the prototype.
    expect(gateValue("---\nname: x\n---\n")).toBeUndefined();
    expect(Object.hasOwn(parseFrontmatter("---\nname: x\n---\n"), "constructor")).toBe(false);
  });

  test("AC #3a — referential integrity: `agent:` names a file that exists on disk", () => {
    // Nothing in the shipped schema cross-checks `agent:` against installed agent names — the pairing is
    // prose-only, so a skill naming an agent type that does not resolve is a silent no-op.
    const agent = parseFrontmatter(applyText).agent;
    expect(typeof agent).toBe("string");
    expect(existsSync(join(REPO, ".claude", "agents", `${agent as string}.md`))).toBe(true);
    // …and the agent file's own `name:` agrees with what the skill asked for.
    expect(parseFrontmatter(agentText).name).toBe(agent);
  });

  // ── COUNTERFACTUAL 1: the gate key deleted ──
  test("COUNTERFACTUAL 1 — deleting the gate key reddens gate (a)", () => {
    const mutated = applyText.replace(`${GATE_KEY}: true\n`, "");
    expect(mutated).not.toBe(applyText);              // the mutation actually bit — never vacuous
    expect(gateValue(mutated)).toBeUndefined();
    expect(isGated(mutated)).toBe(false);
    expect(isGated(applyText)).toBe(true);            // …and the live file still passes
  });

  // ── COUNTERFACTUAL 2: the gate replaced by its inverse twin ──
  test("COUNTERFACTUAL 2 — swapping in `user-invocable: false` reddens BOTH the twin and the key set", () => {
    const mutated = applyText.replace(`${GATE_KEY}: true`, `${TWIN_KEY}: false`);
    expect(mutated).not.toBe(applyText);
    expect(isGated(mutated)).toBe(false);                                   // not gated any more…
    expect(Object.hasOwn(parseFrontmatter(mutated), TWIN_KEY)).toBe(true);  // …and the twin is present
    expect(strayKeys(mutated, APPLY_KEYS)).toEqual([TWIN_KEY]);             // …and the 7-key set breaks
  });

  test("COUNTERFACTUAL 2b — `false` and the empty string are both caught, and truthiness would miss one", () => {
    for (const bad of ["false", ""]) {
      const mutated = applyText.replace(`${GATE_KEY}: true`, `${GATE_KEY}: ${bad}`.trimEnd());
      expect(isGated(mutated)).toBe(false);
    }
    // The defect the string comparison exists to catch: `Boolean("false")` is `true`.
    expect(Boolean("false")).toBe(true);
    expect(isGated(applyText.replace(`${GATE_KEY}: true`, `${GATE_KEY}: false`))).toBe(false);
  });

  test("COUNTERFACTUAL 2c — a YAML-list value fails on TYPE, not on a misleading comparison", () => {
    const mutated = applyText.replace(`${GATE_KEY}: true`, `${GATE_KEY}: [true]`);
    const v = gateValue(mutated);
    expect(Array.isArray(v)).toBe(true);   // `string[]`, exactly as `parseFrontmatter` documents
    expect(isGated(mutated)).toBe(false);
  });

  test("COUNTERFACTUAL 2d — renaming the agent file target is caught", () => {
    const mutated = applyText.replace("agent: notewright", "agent: notewrite");
    const agent = parseFrontmatter(mutated).agent;
    expect(agent).toBe("notewrite");
    expect(existsSync(join(REPO, ".claude", "agents", `${agent as string}.md`))).toBe(false);
  });
});

// ═══ GATE (c) — the file is visible to the harness at all ═════════════════════════════════════════
// Also unconditional, and also ahead of gate (b): a gitignored skills dir is skipped WHOLESALE by the
// harness, and every content assertion in this file would still pass because they read from disk.

describe("apply gate (c) — neither authored path is gitignored", () => {
  const checkIgnore = (rel: string): number =>
    Bun.spawnSync({ cmd: ["git", "check-ignore", "-v", rel], cwd: REPO, stdout: "pipe", stderr: "pipe" })
      .exitCode;

  test("AC #3c — the gated skill and the agent are both visible to git", () => {
    // The 2.1.222 binary carries the literal log line `[skills] Skipped gitignored skills dir:` — the
    // failure this catches is "green locally, absent in the harness", which no content assertion sees.
    // ⚠ FIX THE IGNORE, NEVER WEAKEN THIS GATE.
    expect(checkIgnore(".claude/skills/notewright-apply/SKILL.md")).not.toBe(0);
    expect(checkIgnore(".claude/agents/notewright.md")).not.toBe(0);
  });

  test("COUNTERFACTUAL 4's shape — `check-ignore` really does report 0 for an ignored path", () => {
    // Proving the probe can reach BOTH states without dirtying `.gitignore`: a path the repo genuinely
    // ignores must come back 0, or the assertion above is green by construction.
    expect(checkIgnore(".claude/settings.local.json")).toBe(0);
  });
});

// ═══ GATE (b) — spelling liveness ═════════════════════════════════════════════════════════════════
// The ONLY gate that consults an external binary, and the only one that may SKIP.

describe("apply gate (b) — the gate key is still spelled the way the INSTALLED harness spells it", () => {
  /** The installed binary, or `null` when `claude` is not on PATH. */
  function resolveBinary(): string | null {
    const which = Bun.spawnSync({ cmd: ["which", "claude"], stdout: "pipe", stderr: "pipe" });
    const path = which.stdout.toString().trim();
    if (which.exitCode !== 0 || path.length === 0) return null;
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  }

  /**
   * The one schema line satisfying BOTH anchors.
   *
   * ⚠ SELECT BY CONTENT, NEVER `lines[0]`. Two lines match the agent anchor at 2.1.222 — a 41-byte bare
   * description string and the 28,873-byte schema line — so taking the first is red by construction.
   */
  function schemaLines(bin: string): string[] {
    const out = Bun.spawnSync({ cmd: ["strings", "-a", bin], stdout: "pipe", stderr: "pipe" });
    return out.stdout
      .toString()
      .split("\n")
      .filter((l) => l.includes("Agent type to spawn when") && l.includes("Where the skill runs:"));
  }

  test("AC #3b — the key literal still sits beside its own shipped description", () => {
    const bin = resolveBinary();
    if (bin === null) {
      // SKIP = exit 0 per the estate's adapter posture, and `expect(true)` rather than `test.skip`
      // because a statically-skipped test cannot report WHY it skipped.
      console.warn("[apply-gate b] SKIP: `claude` is not on PATH — spelling liveness unverified");
      expect(true).toBe(true);
      return;
    }

    // 🔴 AN ABSENT BINARY IS THE ONLY SKIP CONDITION. A binary that RESOLVES but whose schema line
    // cannot be read is RED, not SKIP: that is exactly the "the bundle restructured under us" state this
    // gate exists to surface. A skip that also covered "inconclusive" would make SKIP = 0 green by
    // construction and stop this being a gate at all.
    const lines = schemaLines(bin);
    expect(lines.length).toBe(1);
    const line = lines[0]!;
    expect(line.length).toBeGreaterThan(10_000);
    expect(probeKeySpelling(line, GATE_KEY, GATE_ANCHOR)).toBe(true);

    // The inverse twin is alive too — the reason gate (a) asserts its ABSENCE rather than trusting that
    // nobody would reach for it.
    expect(probeKeySpelling(line, TWIN_KEY, "If false, hides the slash command from users")).toBe(true);
  });

  // ── COUNTERFACTUAL 3: THE LOAD-BEARING ONE ──
  test("COUNTERFACTUAL 3 — a renamed key is DETECTED; without this seam the probe is decoration", () => {
    // You cannot rename a key inside the installed harness, so the rename is fed to the pure function.
    // This is the only counterfactual that proves this story's headline risk — an expired or renamed
    // field name — is detectable AT ALL. Everything else here would stay green through that failure,
    // because the harness ignores the unknown key and loads the file perfectly (see the header).
    const bin = resolveBinary();
    if (bin === null) {
      console.warn("[apply-gate b/CF3] SKIP: `claude` is not on PATH");
      expect(true).toBe(true);
      return;
    }
    const real = schemaLines(bin)[0]!;
    const renamed = real.replaceAll(`"${GATE_KEY}":`, '"disable-model-invoke":');
    expect(renamed).not.toBe(real);                                   // the mutant is not the original
    expect(probeKeySpelling(real, GATE_KEY, GATE_ANCHOR)).toBe(true);  // live: found
    expect(probeKeySpelling(renamed, GATE_KEY, GATE_ANCHOR)).toBe(false); // renamed: caught
  });

  test("COUNTERFACTUAL 3b — a vanished description is caught too, not only a renamed key", () => {
    // The other half of the expiry mode: the key survives, the feature's prose moves. Pure input, so it
    // runs with or without the binary.
    expect(probeKeySpelling("nothing here at all", GATE_KEY, GATE_ANCHOR)).toBe(false);
    expect(probeKeySpelling(`{"${GATE_KEY}":x} ${GATE_ANCHOR}`, GATE_KEY, GATE_ANCHOR)).toBe(true);
  });
});

// ═══ GATE (d) — content assertions (AC #2, AC #5) ═════════════════════════════════════════════════

describe("apply gate (d) — the split IS the gate, and the gated body handles all nine codes", () => {
  test("AC #2 — the gate key appears on the apply surface and NOWHERE on the preview surface", () => {
    // The preview path may stay model-invocable: the epic and FR-10 both say so in terms. Gating it
    // would break 2.3's AC #4d and close a path this story is required to leave open.
    expect(countOf(previewText, GATE_KEY)).toBe(0);
    expect(countOf(applyText, GATE_KEY)).toBe(1);
  });

  test("AC #2 — the apply flag is named ONLY on the gated surface: 0 / 0 / ≥1", () => {
    // A gated surface that never names the flag it gates is a gate over nothing. The two zeroes are
    // 2.3's AC #4d, re-asserted here as a regression: 2.4 must not have leaked the flag sideways.
    expect(countOf(previewText, APPLY_FLAG)).toBe(0);
    expect(countOf(agentText, APPLY_FLAG)).toBe(0);
    expect(countOf(applyText, APPLY_FLAG)).toBeGreaterThanOrEqual(1);
  });

  test("AC #2 — the estate has exactly three notewright-facing surfaces: 2 skills + 1 agent", () => {
    const skills = readdirSync(join(REPO, ".claude", "skills"));
    const agents = readdirSync(join(REPO, ".claude", "agents"));
    expect(skills.sort()).toEqual(["notewright", "notewright-apply"]);
    expect(agents).toEqual(["notewright.md"]);
    // 1 gated + 1 ungated skill = 2; the agent is not a skill and the gate key is not in its schema.
    expect(skills.length + agents.length).toBe(3);
  });

  test("AC #2 — the agent carries no gate key: it is not a skill and the key is not in its schema", () => {
    expect(countOf(agentText, GATE_KEY)).toBe(0);
    expect(Object.hasOwn(parseFrontmatter(agentText), GATE_KEY)).toBe(false);
  });

  test("AC #5 — the apply body names all three write-path codes; the agent body names none", () => {
    for (const code of APPLY_CODES) {
      expect(applyText).toContain(code);
      expect(agentText).not.toContain(code);   // naming one there turns 2.3's AC #6 red
      expect(previewText).not.toContain(code);
    }
    expect(APPLY_CODES.length).toBe(3);
  });

  test("AC #5 — the apply body names all six read-path codes too: 6 + 3 = 9", () => {
    for (const code of READ_CODES) expect(applyText).toContain(code);
    expect(NINE_CODES.length).toBe(9);
    expect(new Set(NINE_CODES).size).toBe(9);   // nine DISTINCT codes, not a list with a duplicate
  });

  test("AC #5 — every `nk-` token in the apply body is a declared code or a declared non-code token", () => {
    // ⚠ SCOPED, NOT A WILDCARD SWEEP. See `NON_CODE_TOKENS`: a naive scan would flag correct prose.
    // Both populations are explicit, so an unknown token still has nowhere to hide.
    const known = new Set([...NINE_CODES, ...NON_CODE_TOKENS]);
    const stray = [...new Set(nkTokens(applyText))].filter((t) => !known.has(t));
    expect(stray).toEqual([]);
  });

  test("AC #5 — the branch field is `code`; `error.kind` appears zero times in any of the three", () => {
    // NK-7 rule 2's prose says `error.kind` and is WRONG: the shipped type is
    // `Classified<C> = { code: C; message: string }` (`src/core/result.ts:10`). Reality governs.
    for (const text of [applyText, previewText, agentText]) expect(text).not.toContain("error.kind");
    expect(applyText).toContain("error.code");
  });

  test("AC #5 — the apply body names the four unrecognised-payload classes", () => {
    const lower = applyText.toLowerCase();
    expect(lower).toContain("not an object");
    expect(lower).toContain("empty string");
    expect(lower).toContain("prototype-chain");
    for (const p of ["constructor", "toString", "__proto__", "valueOf"]) expect(applyText).toContain(p);
    expect(lower).toContain("holes");
  });

  test("AC #5 — the apply body fails loud on an unfilled path and offers NO discovery fallback", () => {
    // ⚠ WHITESPACE-COLLAPSED FIRST, for the same reason 2.3 joins logical lines: every rule here is a
    // long sentence, and long sentences wrap. A raw scan for "no fallback" answers NO on a correct file
    // purely because the clause landed on the next source line — a false-positive machine, and the
    // first dev to hit one deletes the gate.
    const lower = applyText.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toContain("usage:");
    expect(lower).toContain("empty");       // one real arrival form…
    expect(lower).toContain("unfilled");    // …and the placeholder form the transcript actually showed
    expect(lower).toContain("no fallback");
    expect(lower).toMatch(/do not search the tree|do not fall back/);
  });

  test("AC #5 — the apply body HANDS the config over; it does not leave the agent to find one", () => {
    // 2.3's behavioural finding, one layer up and with higher stakes: a skill that named `--config` and
    // supplied no path made the subagent `find`-sweep for a registry. On the write surface a discovered
    // registry is not a wrong preview, it is a wrong write. Assert the ARGUMENT, never the mention.
    const shell = applyText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("std "));
    expect(shell.length).toBeGreaterThan(0);
    for (const l of shell) {
      const parts = l.split(/\s+/);
      const at = parts.indexOf("--config");
      expect(at).toBeGreaterThan(-1);
      expect(parts[at + 1]).toBe("$1");       // substituted, never a `<config>` placeholder
    }
    expect(applyText).not.toContain("--config <config>");
    // Every command it shows is a `std` command — it shells the CLI and edits nothing itself.
    expect(shell.some((l) => l.includes("notekit capabilities"))).toBe(true);
    expect(shell.some((l) => l.includes(`notekit render`) && l.includes(APPLY_FLAG))).toBe(true);
  });

  test("AC #5 — the apply body states that a preview must already have been seen (NK-4 rule 3)", () => {
    expect(applyText.toLowerCase()).toContain("preview");
    expect(applyText.toLowerCase()).toMatch(/must already have been seen|preview must/);
  });

  test("AC #4 — the agent body carries a transform contract fixing all four points", () => {
    // ⚠️-3: the contract is an ADDITIVE, BODY-ONLY section in a file Story 2.3 owns. Asserted here
    // rather than assumed, because AC #4's deliverable IS the instruction's existence.
    const at = agentText.indexOf("## Transform mode");
    expect(at).toBeGreaterThan(-1);
    const section = agentText.slice(at).toLowerCase().replace(/\s+/g, " ");

    // (i) exactly two inputs — the note's text, and the catalog obtained by running `capabilities`.
    expect(section).toContain("two inputs");
    expect(agentText.slice(at)).toContain("std notekit capabilities --config");
    // (ii) the closed set is the catalog's own emitted entries, prototype-chain names included.
    expect(section).toMatch(/only authority|the catalog is the only/);
    expect(section).toContain("own");
    for (const p of ["constructor", "toString", "__proto__", "valueOf"]) {
      expect(agentText.slice(at)).toContain(p);
    }
    // (iii) unclassifiable ⇒ report and stop; never guess, never default.
    expect(section).toMatch(/say so and stop|report .{0,20}and stop/);
    expect(section).toContain("do not fall back to a default");
    // (iv) why a wrong classification cannot damage prose.
    expect(section).toMatch(/cannot damage prose/);
    // …and the four input classes on the parsed CLI envelope.
    expect(section).toContain("not an object");
    expect(section).toContain("empty string");
    expect(section).toContain("prototype-chain");
    expect(section).toContain("holes");
  });

  test("AC #4 — the transform section names no note type and enumerates none", () => {
    // 2.3's AC #5 gates the WHOLE agent file on this; asserted again scoped to the new section so a
    // future edit to it is caught here with a message about this story rather than about 2.3's.
    const section = agentText.slice(agentText.indexOf("## Transform mode"));
    for (const lit of ["nk-card", "nk-primer", "nk-protocol", "nk-pattern"]) {
      expect(section).not.toContain(lit);
    }
    const names = ["card", "primer", "protocol", "pattern"];
    const enumerating = section.split(/\r?\n/).filter((line) => {
      const lower = line.toLowerCase();
      return names.filter((n) => new RegExp(`\\b${n}\\b`).test(lower)).length >= 2;
    });
    expect(enumerating).toEqual([]);
  });

  test("D4/NFR3 — no consumer identity in any of the three files", () => {
    // ⚠ `check:no-consumer-ids` globs `src/**` ONLY, so it does NOT see `.claude/**`. Asserted here
    // rather than assumed to be covered by a gate that cannot see these files.
    for (const text of [applyText, previewText, agentText]) {
      expect(text).not.toContain("note-report");
      expect(text).not.toContain("/Users/");
      expect(text).not.toContain("Documents/");
    }
  });

  // ── COUNTERFACTUAL 5 ──
  test("COUNTERFACTUAL 5 — an apply-flag example added to the PREVIEW skill is caught", () => {
    const mutated = `${previewText}\n\nstd notekit render $1 --config $2 ${APPLY_FLAG}\n`;
    expect(countOf(mutated, APPLY_FLAG)).toBe(1);   // the mutation bit…
    expect(countOf(previewText, APPLY_FLAG)).toBe(0); // …and the live file is still clean
    // And it would redden 2.3's own AC #4d at the same time, which is the point: the split is one claim
    // held by two gates, not two independent conveniences.
  });

  test("COUNTERFACTUAL 5b — a tenth `nk-` code smuggled into the apply body is caught", () => {
    const known = new Set([...NINE_CODES, ...NON_CODE_TOKENS]);
    const mutated = `${applyText}\n| \`nk-write-partial\` | invented | — |\n`;
    const stray = [...new Set(nkTokens(mutated))].filter((t) => !known.has(t));
    expect(stray).toEqual(["nk-write-partial"]);
    expect([...new Set(nkTokens(applyText))].filter((t) => !known.has(t))).toEqual([]);
  });
});

// ═══ GATE (e) — `--dry-run` is the default, and the comparator is PROVEN able to see a change ═════

describe("apply gate (e) — preview leaves the fixture byte-identical; apply does not", () => {
  const ISO = "2026-01-01T00:00:00Z";

  /**
   * A note whose fence body is DELIBERATELY NON-CANONICAL.
   *
   * ⚠ THE BLANK LINE IS THE WHOLE POINT, and it is written as an explicit string literal so the next
   * reader can see it. `parseFenceBody`'s declared normalization rule 2 DROPS blank lines, so this body
   * canonicalizes shorter than it started. A canonical fixture would take 2.2's skip-if-identical path,
   * both runs would match, and the comparator would look green while proving nothing.
   */
  const NOTE = [
    "---", "nk-type: card", "---", "", "prose above", "",
    "```nk-card", "title: A Note", "", "status: live", "```", "", "prose below", "",
  ].join("\n");

  const CONFIG = [
    "export default {",
    '  noteTypes: { card: "plain-card" },',
    "  templates: {",
    '    "plain-card": {',
    '      renderer: "nk-card",',
    '      rubric: { kind: "card", titleField: "title", fields: [{ key: "status" }] },',
    "    },",
    "  },",
    "};",
    "",
  ].join("\n");

  function makeFixture(): { dir: string; note: string; cfg: string; decoy: string } {
    // ⚠ A TMP DIR, NEVER THE VAULT AND NEVER THE REPO. NK-5 puts `--apply` on the live working tree, so
    // the discipline IS the fixture — there is no worktree to hide behind.
    const dir = mkdtempSync(join(tmpdir(), "nk-apply-gate-"));
    const note = join(dir, "note.md");
    const cfg = join(dir, "cfg.ts");
    const decoy = join(dir, "decoy.md");
    writeFileSync(note, NOTE);
    writeFileSync(cfg, CONFIG);
    writeFileSync(decoy, "a file the render path has no reason to touch\n");
    return { dir, note, cfg, decoy };
  }

  test("SM-2 — the preview run leaves every byte, the listing and every mtime identical", () => {
    const f = makeFixture();
    try {
      const before = fingerprint(f.dir);
      const run = runCli(["notekit", "render", f.note, "--config", f.cfg, "--at", ISO]);
      expect(run.exitCode).toBe(0);
      const after = fingerprint(f.dir);
      expect(after.listing).toEqual(before.listing);
      expect(after.bytes).toEqual(before.bytes);
      expect(after.mtime).toEqual(before.mtime);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("the preview's STDOUT carries the HTML and a NON-EMPTY fenced diff", () => {
    // A fingerprint-only test would pass on a `render` that printed NOTHING, while the epic's AC #1
    // requires HTML plus the exact fenced diff. ⚠ Presence and non-emptiness only — re-pinning 2.1's
    // exact markup here would create a second oracle that breaks whenever 2.1 legitimately changes it.
    const f = makeFixture();
    try {
      const run = runCli(["notekit", "render", f.note, "--config", f.cfg, "--at", ISO]);
      expect(run.exitCode).toBe(0);
      expect(run.stdout.length).toBeGreaterThan(0);
      expect(run.stdout).toContain("<div");                 // the HTML preview
      expect(run.stdout).toContain("```diff");              // the fenced diff region
      const diff = run.stdout.slice(run.stdout.indexOf("```diff") + 7);
      // Non-empty for THIS deliberately non-canonical fixture: the dropped blank line is a real delta.
      expect(diff.split(/\r?\n/).some((l) => l.startsWith("-") || l.startsWith("+"))).toBe(true);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("NON-VACUITY — the apply run DOES change the fixture, and only inside the fence", () => {
    const f = makeFixture();
    try {
      const before = fingerprint(f.dir);
      const beforeNote = readFileSync(f.note, "utf8");

      const run = runCli(["notekit", "render", f.note, "--config", f.cfg, "--at", ISO, APPLY_FLAG]);
      expect(run.exitCode).toBe(0);

      const after = fingerprint(f.dir);
      const afterNote = readFileSync(f.note, "utf8");

      // 🔴 THE HALF THAT STOPS THIS TEST BEING DECORATION. If the fingerprint matches here, the
      // comparator cannot see a real change (or the fixture went canonical) and the passing preview
      // assertion above proves nothing whatsoever.
      if (JSON.stringify(after.bytes) === JSON.stringify(before.bytes)) {
        throw new Error("the comparator did not detect a real change; this test proves nothing");
      }
      expect(afterNote).not.toBe(beforeNote);

      // The change is confined: no file created or deleted, and the decoy is untouched byte-for-byte…
      expect(after.listing).toEqual(before.listing);
      expect(after.bytes["decoy.md"]).toBe(before.bytes["decoy.md"]);
      expect(after.bytes["cfg.ts"]).toBe(before.bytes["cfg.ts"]);
      // …including its mtime. ⚠ The NOTE's mtime legitimately moves after a write, so a blanket
      // "all mtimes identical" assertion would be red by construction on a correct apply.
      expect(after.mtime["decoy.md"]).toBe(before.mtime["decoy.md"]);

      // 🔴 COMPARE BY CONTENT, NEVER BY BYTE OFFSET. This fixture SHRINKS the fence (the blank line is
      // dropped), so every byte after it moves. NK-4 rule 2 defines the write invariant on the fence
      // AST, not byte offsets — an offset-wise "differs only between bodyStart and bodyEnd" assertion
      // is false BY CONSTRUCTION here and would fail on a CORRECT apply. Two locator calls, one per
      // side, never one set of offsets reused across both.
      const preFence = locateFence(beforeNote);
      const postFence = locateFence(afterNote);
      expect(preFence).not.toBeNull();
      expect(postFence).not.toBeNull();
      expect(beforeNote.slice(0, preFence!.blockStart)).toBe(afterNote.slice(0, postFence!.blockStart));
      expect(beforeNote.slice(preFence!.blockEnd)).toBe(afterNote.slice(postFence!.blockEnd));

      // And the fence really did shrink — so the offset trap above is a live hazard here, not a theory.
      expect(afterNote.length).toBeLessThan(beforeNote.length);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

// ═══ AC #6 — nothing outside this story's enumerated paths moved ══════════════════════════════════

describe("apply gate — AC #6: the working tree holds only this story's own files", () => {
  /**
   * ⚠ AN ENUMERATION OF EXACT PATHS, NEVER A PREFIX. `src/notekit/notewright-*` would silently permit
   * every future file in the slice, which is how this assertion stops being a gate. Extended by 2.5,
   * 2.6 and 2.7 in turn (Epic-2 ruling §7) — extend it, never replace it.
   */
  const ALLOWLIST = [
    "src/notekit/notewright-dispatch.test.ts",   // 2.3's file, amended by this story (⚠️-1)
    "src/notekit/notewright-apply-gate.test.ts", // this file
  ];

  /** `git status --porcelain -z` paths. A rename emits TWO records; the second carries no status. */
  function porcelainPaths(stdout: string): string[] {
    const records = stdout.split("\0").filter((r) => r.length > 0);
    const out: string[] = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      const status = record.slice(0, 2);
      out.push(record.slice(3).trim());
      if (status.includes("R") || status.includes("C")) {
        const origin = records[++i];
        if (origin !== undefined) out.push(origin.trim());
      }
    }
    return out;
  }

  test("AC #6 — no file under src/ or scripts/ moved beyond the two enumerated paths", () => {
    // ⚠ THE WORKING TREE, never `git diff <base>..HEAD -- src/` — a committed-history range returns
    // empty pre-commit whatever the tree holds, so it would be vacuous as an unchanged-gate. And this
    // story follows THREE siblings on one repo, so a pinned base SHA would sweep their commits in.
    const proc = Bun.spawnSync({
      cmd: ["git", "status", "--porcelain", "-z", "--", "src/", "scripts/"],
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const paths = porcelainPaths(proc.stdout.toString());
    expect(paths.filter((p) => !ALLOWLIST.includes(p))).toEqual([]);
  });

  test("AC #6 — the allowlist is exact paths, and an UNLISTED dirty path still reddens", () => {
    // The proof that the amendment widened nothing: a path under `src/` that is not enumerated is a
    // finding, whatever its name and however close it sits to a listed one.
    const unlisted = porcelainPaths("?? src/notekit/core-fence.ts\0 M src/cli/main.ts\0")
      .filter((p) => !ALLOWLIST.includes(p));
    expect(unlisted).toEqual(["src/notekit/core-fence.ts", "src/cli/main.ts"]);
    // A prefix pattern would have waved the first one straight through — which is why there is none.
    expect(ALLOWLIST.every((p) => p.endsWith(".ts") && !p.includes("*"))).toBe(true);
  });

  test("AC #6 — this story adds no `src/**` SOURCE file: the notekit non-test count is unchanged", () => {
    // Its one new `src/` file is a `*.test.ts`, which is why the six `check:*` gates should report
    // counts identical to the post-2.3 tree.
    const nonTest = readdirSync(join(REPO, "src", "notekit"))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(nonTest.length).toBe(7);
    expect(existsSync(join(REPO, "src", "notekit", "notewright-apply-gate.ts"))).toBe(false);
  });
});
