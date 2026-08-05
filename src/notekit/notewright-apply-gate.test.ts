// The structural apply gate for Story 2.4 (FR-9, FR-10, SM-8, NK-4 rule 4 as amended, NK-10).
//
// WHAT THIS GATE PROVES, AND WHAT IT DOES NOT. It proves the gated apply surface is authored with the
// field the harness reads, that the field is still spelled the way the INSTALLED harness spells it, that
// the file is visible to the harness at all, that the committed deny rule naming that surface exists and
// still parses as a live rule, and that the preview path leaves a fixture byte-identical while the apply
// path does not. It does NOT prove the harness HONOURS either mechanism at invocation time: `bun test`
// runs under `bun`, not under Claude Code, so no test here can observe an invocation decision. That
// behavioural bite was watched ONCE, on the real surface (`REAL-2` blocked the shipped surface under the
// deny with a valid token present; `T3`, deny removed and everything else identical, executed and wrote
// its marker) and is CITED here rather than re-run — a nested `claude -p` inside `bun test` would be
// slow, networked and non-hermetic. A gate that greps a markdown file and calls the result "the model
// cannot reach this" would be the vacuity this loop exists to catch.
//
// 🔴 THE GATE IS TWO MECHANISMS, AND THE CLAIM IS TWO LAYERS (NK-10 rule 1). AUTHORIZATION: the apply
// surface is unreachable by the `Skill` tool from any subagent unconditionally, and unreachable from the
// main session while the committed `permissions.deny` rule `Skill(notewright-apply)` is in force.
// `disable-model-invocation: true` ALONE blocks every model-initiated call EXCEPT within a turn whose own
// user-message TEXT carries the literal whitespace-delimited token `/notewright-apply`. CONTAINMENT is a
// different property with a different owner: prose safety under an agent that holds `Bash` and types the
// CLI command directly is NK-4 rules 1–2's fence-bounded writer, true for EVERY caller, and it was never
// this gate's job. The phrase "structurally unreachable by the model", said of the frontmatter field
// alone, is retired — it was the platform's own schema description, and the description overstates the
// implementation in the UNSAFE direction.
//
// ⚠ WHAT NO GATE HERE WATCHES. Gates (b) and (g) watch STRINGS; the carve-out is LOGIC. A harness bump
// that changed the `userTypedThisTurn` predicate's SHAPE — widening it to assistant text, say — would
// leave every assertion in this file green while the claim quietly stopped holding. FR-10's assumption is
// therefore discharged AS TO THE NAMES and merely MONITORED as to the behaviour. Re-run the `REAL-1` /
// `REAL-2` probes on any material harness bump.
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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

// ── the SECOND mechanism (NK-10): the committed permission boundary ──────────────────────────────
// The frontmatter field is HALF the gate. `disable-model-invocation: true` alone blocks every
// model-initiated call EXCEPT within a turn whose own user-message TEXT carries the literal
// whitespace-delimited token `/notewright-apply` — assistant text, prior turns and all tool output cannot
// open it, but documentation prose in a human's message can, and on 2026-08-06 it did. The committed deny
// rule closes that carve-out: it beats the token, holds under `bypassPermissions`, is NOT trust-gated, and
// leaves the human slash path working.
const SETTINGS = join(REPO, ".claude", "settings.json");

/** The exact deny entry. ⚠ A WHOLE LITERAL, never a `notewright-apply` substring sweep — that would go
 *  green on a comment, on an `allow` entry, or on the bare tool name, none of which is the rule. */
const DENY_ENTRY = "Skill(notewright-apply)";

/**
 * Gate (g)'s two upstream anchors: the refusal string the harness prints when a permission rule blocks a
 * skill, and the reason token it attributes to the frontmatter field. ⚠ PRESENCE, NEVER THE COUNTS —
 * both stood at 3 occurrences at 2.1.222 and occurrence counts churn on every build.
 */
const DENY_ANCHORS = ["Skill execution blocked by permission rules", "disable_model_invocation"];

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
 * The apply body's ordered `1.` / `2.` / `3.` steps, each returned as one lowercased whitespace-collapsed
 * string with its continuation lines folded in.
 *
 * ⚠ WHY THIS EXISTS RATHER THAN A WHOLE-FILE `toContain`. The two-step's claim is POSITIONAL — preview,
 * then showing, then write — and a phrase scan over the whole body cannot see position. Measured: a
 * mutation that deleted the showing obligation from the step list left a whole-file `/in front of the
 * human/` assertion GREEN, matched by an unrelated closing paragraph. Continuation lines are folded
 * because these steps wrap, and a step read as its first line only would drop half its own text.
 */
function orderedSteps(text: string): string[] {
  const steps: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\d+\.\s/.test(line)) steps.push(line);
    else if (steps.length > 0 && /^\s+\S/.test(line)) steps[steps.length - 1] += ` ${line.trim()}`;
    else if (line.trim() === "") continue;
    else if (steps.length > 0) break;   // the list ended; stop before unrelated prose folds in
  }
  return steps.map((s) => s.toLowerCase().replace(/\s+/g, " "));
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

/**
 * The installed harness binary, or `null` when `claude` is not on PATH.
 *
 * ⚠ MODULE SCOPE ON PURPOSE. Gates (b) and (g) both need it and both hang their SKIP on it, so it has one
 * definition. It was gate (b)'s local helper until gate (g) shipped; hoisting it moved no behaviour, and
 * a second copy would have let the two gates' SKIP conditions drift apart — the drift being that one gate
 * starts skipping in a situation where the other still runs, which is invisible until it matters.
 */
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

/**
 * Gate (g)'s liveness step, factored as a pure function so the counterfactual has a seam.
 *
 * ⚠ THIS IS NOT `probeKeySpelling` WEARING A HAT, and it is not a second copy of it. That probe answers a
 * DIFFERENT question — "does this JSON schema key literal sit within 200 chars before its own prose
 * description", a key-adjacency claim about one line of a bundled schema. These anchors are free strings
 * scattered through a 100MB binary with no key, no adjacency and no window; forcing them through the
 * key-adjacency regex would ask `[,{]"Skill execution blocked by permission rules"?:`, which is nonsense
 * and would answer `false` on a perfectly healthy harness. Different claim, different probe. The rule
 * ⚠️-1 states is "one owner per claim", not "one function per file".
 */
function probeAnchorsPresent(haystack: string, anchors: string[]): boolean {
  return anchors.every((a) => haystack.includes(a));
}

/** `.claude/settings.json`, parsed. ⚠ NO `try{}catch{}`: an unparseable settings file is a DEAD deny rule,
 *  so downgrading the throw to a soft warning is the one thing this gate must never do. */
function readSettings(): { permissions?: { deny?: unknown; allow?: unknown } } {
  return JSON.parse(readFileSync(SETTINGS, "utf8"));
}

/** The deny array as an array of strings, or `[]` if the shape is wrong (which the assertions then catch). */
function denyRules(): string[] {
  const deny = readSettings().permissions?.deny;
  return Array.isArray(deny) ? deny.filter((r): r is string => typeof r === "string") : [];
}

/** A skill surface on disk: its directory name, its declared `name:`, and its text. */
type Surface = { dir: string; name: string; text: string; writeClass: boolean };

/**
 * Every skill surface in the repo, each classified write-class or not.
 *
 * ⚠ THIS ENUMERATES RATHER THAN CHECKING ONE LITERAL, because NK-10 rule 6 binds *every* write-class
 * surface — `render --apply` today, `--body -` (NK-8 r6) and `notekit new` (NK-9 r5) the moment either
 * gains its own skill. A gate that asserted only `Skill(notewright-apply)` would stay green through the
 * arrival of a second, ungated write surface, which is precisely the regression rule 6 exists to prevent.
 * Write-class is read off the surface itself — it names the apply flag — so a new one is classified the
 * day it is authored, with nobody remembering to add it to a list here.
 */
function skillSurfaces(): Surface[] {
  const root = join(REPO, ".claude", "skills");
  return readdirSync(root).map((dir) => {
    const text = readFileSync(join(root, dir, "SKILL.md"), "utf8");
    const name = parseFrontmatter(text).name;
    return {
      dir,
      name: typeof name === "string" ? name : "",
      text,
      writeClass: countOf(text, APPLY_FLAG) > 0,
    };
  });
}

/** One `Invalid permission rule "<rule>" was skipped` line, as the harness's own parser reports it. */
type DoctorVerdict = { ran: boolean; skipped: string[]; raw: string };

/**
 * Wall-clock allowance for one `claude doctor` spawn.
 *
 * ⚠ NOT A GUESS, AND NOT A FLAKE PATCH. `bun test`'s default per-test timeout is 5s, and when it fires it
 * SIGTERMs the whole process group — so the spawned `doctor` came back `exit 143` with empty output and
 * the assertion failed for a reason that had nothing to do with the rule. Measured 2026-08-06: the spawn
 * takes ~0.7-1.5s idle and crosses 5s under full-suite load. The allowance buys wall-clock only; every
 * assertion below is unchanged, and a doctor run that genuinely produces no output is still RED.
 */
const DOCTOR_TIMEOUT_MS = 60_000;

/**
 * Gate (g)'s BEHAVIOURAL step: hand a settings file to the harness's OWN permission-rule parser and read
 * back which rules it threw away.
 *
 * `claude doctor` is documented as reading the settings files in the current directory without a trust
 * prompt, and it prints an `Invalid settings` block naming each rule it skipped and why. That makes it a
 * real behavioural probe rather than a string sighting: it answers "does THIS harness still turn OUR exact
 * rule text into a live rule", which a `strings` scan cannot.
 *
 * ⚠ WHAT IT DOES **NOT** ANSWER, measured rather than assumed (2026-08-06, 2.1.222). The parser is
 * SYNTACTIC. `Fnord(notewright-apply)` is accepted exactly as `Skill(notewright-apply)` is; only shape
 * errors are rejected (`Skill()` → empty parentheses; `notewright-apply` → tool names must start
 * uppercase). So this probe catches a harness that changes rule SYNTAX under us — our string silently
 * becoming an unparseable rule that is dropped on the floor — and it does NOT catch a harness that keeps
 * parsing `Skill(…)` while ceasing to ENFORCE it. That second failure is what the string anchors watch,
 * and neither watches a change to the enforcement PREDICATE's shape. Stated, not blurred.
 *
 * ⚠ HERMETIC BY CONSTRUCTION: `CLAUDE_CONFIG_DIR` is redirected into the throwaway dir, so the run reads
 * and writes nothing under the operator's real `~/.claude`; the auto-updater and telemetry are off. Two
 * runs cost ~1.5s total. Verified: the only files it created were inside the redirected config dir.
 */
function doctorVerdict(bin: string, settingsJson: string): DoctorVerdict {
  const dir = mkdtempSync(join(tmpdir(), "nk-doctor-"));
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), settingsJson);
    const proc = Bun.spawnSync({
      cmd: [bin, "doctor"],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      // ⚠ AN EXPLICIT MINIMAL ENV, NEVER `{...process.env}`. Bun runs every test file in ONE process, so
      // a `process.env` spread inherits whatever an earlier file mutated — measured: with the spread,
      // these three assertions passed when this file ran alone and failed under the full suite, because
      // some earlier file's env reached the subprocess. An inherited environment is not a hermetic probe;
      // it is a probe of whatever ran before it.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        CLAUDE_CONFIG_DIR: join(dir, "config"),
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    });
    const raw = proc.stdout.toString() + proc.stderr.toString();
    if (!raw.includes("Claude Code doctor")) {
      // 🔴 A PRESENT BINARY WHOSE PROBE CANNOT RUN IS RED, NOT SKIP — and it is red WITH THE OUTPUT, so
      // the next reader diagnoses it instead of guessing. Reporting "no rules were skipped" from a
      // command that never started is the exact green-by-construction failure this gate exists to avoid.
      throw new Error(
        `[apply-gate g] \`claude doctor\` produced no recognizable output (exit ${proc.exitCode}). ` +
          `This is RED, not a skip: the harness is installed and the probe could not read it. Raw:\n` +
          raw.slice(0, 2000),
      );
    }
    return {
      ran: true,
      skipped: [...raw.matchAll(/Invalid permission rule "([^"]*)" was skipped/g)].map((m) => m[1]!),
      raw,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// ═══ GATE (f) — the deny rule is present, well-formed, and COMMITTED ══════════════════════════════
// The second of the two mechanisms (NK-10 rules 2 + 4). Needs no binary, so it runs unconditionally
// beside (a) and (c). A deleted config line is a SILENT regression: every other gate in this file stays
// green while the carve-out reopens.

describe("apply gate (f) — the committed permission boundary exists and names the surface", () => {
  const spawnGit = (args: string[]): number =>
    Bun.spawnSync({ cmd: ["git", ...args], cwd: REPO, stdout: "pipe", stderr: "pipe" }).exitCode;

  test("AC #3f — the settings file parses as JSON and its deny array carries the exact entry", () => {
    // ⚠ NO `try{}catch{}` AROUND THE PARSE. An unparseable settings file is a dead deny rule; a gate that
    // downgraded that to a warning would report the boundary healthy at exactly the moment it was gone.
    const deny = readSettings().permissions?.deny;
    expect(Array.isArray(deny)).toBe(true);
    // ⚠ THE WHOLE LITERAL. A `rg 'notewright-apply'` sweep over the file goes green on a comment, on an
    // `allow` entry, or on the bare tool name `Skill` — none of which is the rule.
    expect(deny as string[]).toContain(DENY_ENTRY);
  });

  test("AC #3f — NEVER `deny: [\"Skill\"]`: the bare tool name is not the rule (NK-10 rule 3)", () => {
    // Denying the tool outright removes the CAPABILITY, not the INTENT: probe `A4` watched the model
    // lose the Skill tool, locate the SKILL.md with `Bash`, read it, and start running the body's command
    // by hand. The named surface is what gets denied.
    expect(denyRules()).not.toContain("Skill");
    expect(denyRules().every((r) => r !== "Skill()" && r !== "Skill(*)")).toBe(true);
  });

  test("AC #3f — the file holds ONLY the deny block", () => {
    // Project-level `allow` is trust-dialog-gated and silently ignored in an untrusted workspace, while
    // `deny` is NOT trust-gated (`T2`/`T3`) — which is the whole reason this primitive carries into every
    // clone with no setup step. Parking an inert list beside a load-bearing one invites the reader to
    // assume both are live.
    const settings = readSettings();
    expect(Object.keys(settings)).toEqual(["permissions"]);
    expect(Object.keys(settings.permissions ?? {})).toEqual(["deny"]);
    expect(Object.hasOwn(settings.permissions ?? {}, "allow")).toBe(false);
  });

  test("AC #3f — it is NOT gitignored, and the file `.gitignore` DOES name is a different file", () => {
    // `.gitignore` ignores `.claude/settings.local.json`. Writing the rule THERE would be gitignored,
    // uncommitted and invisible to every clone — an ignored permission boundary is no boundary at all.
    expect(spawnGit(["check-ignore", "-v", ".claude/settings.json"])).not.toBe(0);
    expect(spawnGit(["check-ignore", "-v", ".claude/settings.local.json"])).toBe(0);
  });

  test("AC #3f — it is git-TRACKED: present-on-disk is not the claim, committed is", () => {
    // 🔴 A surface whose deny entry lands in a later commit is an incomplete surface for the length of
    // that gap (NK-10 rule 6), and a file that is never `git add`ed reaches no clone at all. This
    // assertion is RED until the file is committed, and that is the correct reading of an uncommitted
    // boundary — not a reason to relax it to "exists on disk".
    //
    // The probe is not a constant, asserted first so a red below reads as "this file is untracked" and
    // never as "`ls-files` always fails here": a path the repo genuinely tracks comes back 0.
    expect(spawnGit(["ls-files", "--error-unmatch", ".claude/skills/notewright-apply/SKILL.md"])).toBe(0);
    expect(spawnGit(["ls-files", "--error-unmatch", ".claude/settings.json"])).toBe(0);
  });

  test("NK-10 rule 6 — EVERY write-class skill surface carries BOTH mechanisms", () => {
    // ⚠ AN ENUMERATION, NOT A SINGLE LITERAL. Rule 6 binds the surfaces that do not exist yet — `--body -`
    // (NK-8 r6) and `notekit new` (NK-9 r5) each acquire the frontmatter field AND a matching deny entry
    // the moment they gain a skill. A gate checking only today's one entry would stay green through the
    // arrival of a second, ungated write surface.
    const surfaces = skillSurfaces();
    const writeClass = surfaces.filter((s) => s.writeClass);
    expect(writeClass.length).toBeGreaterThanOrEqual(1);   // never zero: that would mean nothing to gate
    for (const s of writeClass) {
      expect(isGated(s.text)).toBe(true);                       // mechanism 1: the frontmatter field
      expect(denyRules()).toContain(`Skill(${s.name})`);        // mechanism 2: the committed deny entry
      expect(s.name).toBe(s.dir);   // …and the entry names the surface the harness will resolve
    }
    // …and the read-only preview surface is deliberately NOT denied: FR-10 keeps it model-invocable.
    for (const s of surfaces.filter((x) => !x.writeClass)) {
      expect(denyRules()).not.toContain(`Skill(${s.name})`);
    }
    // Today that partition is 1 write-class + 1 preview. Pinned so a surface appearing without a
    // classification is visible rather than absorbed.
    expect(surfaces.length).toBe(2);
    expect(writeClass.map((s) => s.name)).toEqual(["notewright-apply"]);
  });

  // ── COUNTERFACTUAL 6 (in-test half; the file-level plant is in the Debug Log) ──
  test("COUNTERFACTUAL 6 — an emptied or misspelled deny array is caught", () => {
    // ⚠ The load-bearing half of this counterfactual is planted BY EDITING THE FILE, because the claim is
    // about a committed config line being deleted and a mocked reader would prove the mock works. This
    // in-test half pins the predicate itself so the plant has something to be a plant OF.
    const pristine = readFileSync(SETTINGS, "utf8");
    for (const mutant of ['{"permissions":{"deny":[]}}', '{"permissions":{"deny":["Skill(notewright-aply)"]}}']) {
      expect(mutant).not.toBe(pristine);
      const deny = (JSON.parse(mutant) as { permissions: { deny: string[] } }).permissions.deny;
      expect(deny).not.toContain(DENY_ENTRY);
    }
    expect(denyRules()).toContain(DENY_ENTRY);   // …and the live file still passes
  });
});

// ═══ GATE (b) — spelling liveness ═════════════════════════════════════════════════════════════════
// The ONLY gate that consults an external binary, and the only one that may SKIP.

describe("apply gate (b) — the gate key is still spelled the way the INSTALLED harness spells it", () => {
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

// ═══ GATE (g) — deny-form liveness ════════════════════════════════════════════════════════════════
// The `Skill(<name>)` deny form is NOT DOCUMENTED anywhere upstream — the settings docs illustrate only
// `Bash(…)`/`Read(…)` — and it works. It therefore carries no compatibility promise, which is the same
// hazard gate (b) covers for the frontmatter key, one layer over. The primitive disappearing SILENTLY is
// the whole risk: nothing in this repo would notice.
//
// 🔴 SAME SKIP DISCIPLINE AS (b), AND IT MUST NOT BE WIDENED. An absent binary is the ONLY skip
// condition. A binary that RESOLVES but whose anchor the probe cannot find is RED — that state IS the
// regression. A skip that also covered "inconclusive" is how a SKIP = 0 gate becomes green by
// construction and stops being a gate.

describe("apply gate (g) — the harness still HAS the machinery the deny rule relies on", () => {
  test("AC #3g — both upstream anchors are present in the installed binary", () => {
    const bin = resolveBinary();
    if (bin === null) {
      console.warn("[apply-gate g] SKIP: `claude` is not on PATH — deny-form liveness unverified");
      expect(true).toBe(true);
      return;
    }
    // ⚠ FIXED-STRING SEARCH, NOT A REGEX: neither anchor carries a metacharacter today, and reading them
    // as patterns is a needless way to go red on an escaping change rather than on the regression.
    const strings = Bun.spawnSync({ cmd: ["strings", "-a", bin], stdout: "pipe", stderr: "pipe" })
      .stdout.toString();
    expect(strings.length).toBeGreaterThan(1000);   // the probe read SOMETHING; an empty haystack is red
    // ⚠ PRESENCE, NEVER THE COUNTS. Both stood at 3 occurrences at 2.1.222; counts churn per build.
    expect(probeAnchorsPresent(strings, DENY_ANCHORS)).toBe(true);
  });

  // ── COUNTERFACTUAL 7: the lexical half's seam ──
  test("COUNTERFACTUAL 7 — a withdrawn or renamed anchor is DETECTED", () => {
    // You cannot mutate the installed harness, so the mutation is fed to the pure function — the same
    // seam gate (b) uses, and for the same reason: without it the probe can only ever be observed green,
    // which is indistinguishable from a probe that always returns true.
    const bin = resolveBinary();
    if (bin === null) {
      console.warn("[apply-gate g/CF7] SKIP: `claude` is not on PATH");
      expect(true).toBe(true);
      return;
    }
    const real = Bun.spawnSync({ cmd: ["strings", "-a", bin], stdout: "pipe", stderr: "pipe" })
      .stdout.toString();
    const renamed = real.replaceAll(DENY_ANCHORS[0]!, "Skill execution blocked by policy");
    expect(renamed).not.toBe(real);                              // the mutant is not the original
    expect(probeAnchorsPresent(real, DENY_ANCHORS)).toBe(true);   // live: found
    expect(probeAnchorsPresent(renamed, DENY_ANCHORS)).toBe(false); // withdrawn: caught
    // …and the OTHER anchor vanishing is caught too, so this is not a one-string gate wearing a plural.
    expect(probeAnchorsPresent(real.replaceAll(DENY_ANCHORS[1]!, "dmi"), DENY_ANCHORS)).toBe(false);
  });

  test("COUNTERFACTUAL 7b — the probe is not a constant: it answers true and false on pure input", () => {
    // Runs with or without the binary. `every` on an empty anchor list would be vacuously true, which is
    // the way this predicate could rot into a tautology; pinned here.
    expect(probeAnchorsPresent("a b", ["a", "b"])).toBe(true);
    expect(probeAnchorsPresent("a b", ["a", "c"])).toBe(false);
    expect(DENY_ANCHORS.length).toBe(2);
  });

  // ── The BEHAVIOURAL half: the harness's own parser, on our own file ──
  test("AC #3g — the harness's OWN rule parser still accepts the repo's exact deny entry", () => {
    // This is the one assertion in either gate that is not lexical. `claude doctor` reads the settings
    // files in the current directory and prints every permission rule it SKIPPED and why, so handing it
    // our real file answers "does this harness still turn our exact rule text into a live rule" —
    // a question no `strings` scan can reach.
    const bin = resolveBinary();
    if (bin === null) {
      console.warn("[apply-gate g] SKIP: `claude` is not on PATH — rule-parser acceptance unverified");
      expect(true).toBe(true);
      return;
    }
    const verdict = doctorVerdict(bin, readFileSync(SETTINGS, "utf8"));
    // A present binary whose probe cannot run is RED, never SKIP — same discipline as (b).
    expect(verdict.ran).toBe(true);
    expect(verdict.skipped).toEqual([]);
  }, DOCTOR_TIMEOUT_MS);

  test("NON-VACUITY — the same probe REJECTS a malformed rule, so an empty skip list means something", () => {
    // 🔴 WITHOUT THIS, THE ASSERTION ABOVE IS DECORATION. "No rules were skipped" is also what a harness
    // that stopped reporting skipped rules would print, and what a probe pointed at the wrong directory
    // would print. The mutant proves the channel is live in the same run.
    const bin = resolveBinary();
    if (bin === null) {
      console.warn("[apply-gate g/non-vacuity] SKIP: `claude` is not on PATH");
      expect(true).toBe(true);
      return;
    }
    const pristine = readFileSync(SETTINGS, "utf8");
    const mutated = pristine.replace(DENY_ENTRY, "Skill(notewright-apply");   // closing paren dropped
    expect(mutated).not.toBe(pristine);
    const verdict = doctorVerdict(bin, mutated);
    expect(verdict.ran).toBe(true);
    expect(verdict.skipped).toEqual(["Skill(notewright-apply"]);
  }, DOCTOR_TIMEOUT_MS);

  test("what gate (g) does NOT detect, asserted rather than only commented", () => {
    // ⚠ THE BLIND SPOT, PINNED SO IT CANNOT BE QUIETLY OVERSTATED LATER. Measured 2026-08-06 at 2.1.222:
    // the rule parser is SYNTACTIC, so an unknown tool name is accepted exactly as `Skill` is. Gate (g)
    // therefore proves the rule PARSES, never that the permission layer still consults it for skill
    // invocations — and neither half watches the `userTypedThisTurn` predicate's SHAPE. A harness bump
    // that widened that carve-out to assistant text would leave every assertion in this file green while
    // the claim quietly stopped holding. Re-run the `REAL-1`/`REAL-2` probes on any material bump; there
    // is no test here that catches it, and saying otherwise would be the vacuity this loop exists to find.
    const bin = resolveBinary();
    if (bin === null) {
      console.warn("[apply-gate g/blind-spot] SKIP: `claude` is not on PATH");
      expect(true).toBe(true);
      return;
    }
    const bogus = doctorVerdict(bin, '{"permissions":{"deny":["Fnord(notewright-apply)"]}}');
    expect(bogus.ran).toBe(true);
    expect(bogus.skipped).toEqual([]);   // an unknown TOOL is accepted; only bad SHAPE is rejected
  }, DOCTOR_TIMEOUT_MS);
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

  // ── the two-step (NK-4 rule 3), replacing the inherited-evidence precondition ──────────────────
  //
  // 🔴 WHAT THIS REPLACED, AND WHY THE OLD ASSERTION HAD TO GO. Until 2026-08-06 this position held:
  //
  //     test("AC #5 — the apply body states that a preview must already have been seen (NK-4 rule 3)")
  //       expect(applyText.toLowerCase()).toContain("preview");
  //       expect(applyText.toLowerCase()).toMatch(/must already have been seen|preview must/);
  //
  // It certified a body clause requiring EVIDENCE THAT A HUMAN HAD ALREADY PREVIEWED THE NOTE, and the
  // body forbade the agent from re-deriving that preview itself. `context: fork` means the surface
  // inherits nothing — no prior turns, no parent transcript — so that evidence can never be in hand and
  // the precondition was unsatisfiable BY CONSTRUCTION, for the human path too. Measured end to end:
  // three forked runs, zero write-class tool calls, and both apply runs made ZERO tool calls — they
  // stopped on this clause every time, including one resumed onto the very session that had just
  // displayed the preview. The headline verb had never executed. Leaving the old assertion beside the
  // new ones would certify a body as satisfying both halves of a contradiction, which is worse than
  // having no gate here at all — so it is DELETED, not weakened, and quoted above so its removal is
  // legible rather than silent.
  //
  // ⚠ THE INTENT IS DELIBERATELY WEAKER NOW, and these assertions must never be read as the old claim.
  // NK-4 rule 3 asks that the write be "preceded by the same preview" — which the in-run two-step
  // satisfies exactly. What is NOT claimed is that a human read it. That trade is ruled, not accidental,
  // and the body is asserted below to say so in those terms.

  test("AC #5/#6 — the apply body renders READ-ONLY first and SHOWS the diff, before the write", () => {
    // ⚠ ORDER IS THE CLAIM, so this is positional and not a pair of `toContain`s: a body naming both
    // commands in the wrong order describes preview-after-write, which is not a preview at all.
    const shell = applyText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("std "));
    const readOnly = shell.findIndex((l) => l.includes("notekit render") && !l.includes(APPLY_FLAG));
    const write = shell.findIndex((l) => l.includes("notekit render") && l.includes(APPLY_FLAG));
    expect(readOnly).toBeGreaterThan(-1);   // the preview render exists at all…
    expect(write).toBeGreaterThan(-1);      // …and so does the write…
    expect(readOnly).toBeLessThan(write);   // …and the preview is FIRST.

    // Showing it is a separate obligation from running it: a render whose diff is never put in front of
    // the human produces evidence nobody sees, which is the old defect wearing a new command.
    //
    // ⚠ SCOPED TO THE ORDERED STEPS, NOT TO THE WHOLE BODY, and the reason is a mutation that did NOT
    // bite. A first draft asserted `/show it|in front of the human/` over the entire file; deleting the
    // showing obligation from the step list left the test GREEN, because the closing "puts four things in
    // front of the human" paragraph satisfied the regex from a hundred lines away. A whole-file scan for
    // a phrase cannot tell WHERE the obligation is, and here the position is the claim. So the steps are
    // extracted and each is asserted on its own.
    const steps = orderedSteps(applyText);
    expect(steps.length).toBe(3);
    expect(steps[0]!).toMatch(/read-only/);                       // step 1 is the preview…
    expect(steps[1]!).toMatch(/show/);                            // …step 2 puts it in front of a human…
    expect(steps[1]!).toMatch(/in front of the human/);
    expect(steps[1]!).toMatch(/diff/);                            // …and what it shows is the DIFF…
    expect(steps[2]!).toMatch(/write/);                           // …step 3 writes.
    expect(steps[2]!).toMatch(/apply flag|--apply/);
  });

  test("AC #5/#6 — the body states the WEAKENED intent instead of claiming a human read it", () => {
    // The trade is written down so the next reader does not rediscover it as a defect and "fix" it back
    // into an unsatisfiable precondition.
    const lower = applyText.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toMatch(/rendered and shown/);
    expect(lower).toMatch(/deliberate trade|not an oversight/);
    // …and the retired claim is NOT still asserted anywhere in the body.
    expect(lower).not.toMatch(/must already have been seen/);
  });

  test("AC #5/#6 — a failed preview STOPS the run and explicitly forbids a retry", () => {
    // 🔴 THE TRAP THIS EXISTS TO CLOSE. Research probe `E3` watched a fork rewrite a failing command and
    // retry until the write succeeded. A two-step whose first step may be retried is a loop that ends in
    // a write no preview ever covered — the old defect inverted. Preview → show → write, once.
    const lower = applyText.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toMatch(/not a licence to write|failed preview/);
    expect(lower).toMatch(/do not re-run/);
    expect(lower).toMatch(/different flag|different path|different config/);
    expect(lower).toMatch(/once each|one read-only render, one showing, one write/);
    // A fenceless note is the same stop with a reason, and it must not become a creation path.
    expect(applyText).toContain("nk-no-fence");
    expect(lower).toMatch(/do not create a fence/);
  });

  // ── COUNTERFACTUAL 6 ──
  test("COUNTERFACTUAL 6 — a body whose write precedes its read-only render is caught", () => {
    // Built by SWAPPING the two live render lines rather than by hand-writing a fake body: a mutant
    // typed from scratch can pass vacuously when it happens to equal the original. Asserted non-equal
    // before it is used, so a future edit that made the swap a no-op reddens here instead of hiding.
    const lines = applyText.split(/\r?\n/);
    const ro = lines.findIndex((l) => l.trim().startsWith("std ") && l.includes("notekit render") && !l.includes(APPLY_FLAG));
    const wr = lines.findIndex((l) => l.trim().startsWith("std ") && l.includes("notekit render") && l.includes(APPLY_FLAG));
    expect(ro).toBeGreaterThan(-1);
    expect(wr).toBeGreaterThan(ro);
    const swapped = [...lines];
    [swapped[ro], swapped[wr]] = [swapped[wr]!, swapped[ro]!];
    const mutated = swapped.join("\n");
    expect(mutated).not.toBe(applyText);   // the mutation is REAL, not a vacuous copy

    const order = (text: string) => {
      const shell = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("std "));
      return [
        shell.findIndex((l) => l.includes("notekit render") && !l.includes(APPLY_FLAG)),
        shell.findIndex((l) => l.includes("notekit render") && l.includes(APPLY_FLAG)),
      ];
    };
    const [mRo, mWr] = order(mutated);
    expect(mRo).toBeGreaterThan(mWr!);     // the mutant fails the order claim…
    const [lRo, lWr] = order(applyText);
    expect(lRo).toBeLessThan(lWr!);        // …and the live file still passes it
  });

  test("COUNTERFACTUAL 6b — a body that drops the retry ban is caught", () => {
    // Deletion, not substitution: the mutant is the live text with the ban's sentence removed, so it
    // cannot equal the original unless the ban was never there — which the non-equality assertion says.
    const mutated = applyText.replace(/\*\*do not re-run[^*]*\*\*/i, "");
    expect(mutated).not.toBe(applyText);
    expect(mutated.toLowerCase().replace(/\s+/g, " ")).not.toMatch(/do not re-run/);
    expect(applyText.toLowerCase().replace(/\s+/g, " ")).toMatch(/do not re-run/);
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
