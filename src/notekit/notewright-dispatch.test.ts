// The dispatch-determinism gate for Story 2.3 (FR-19, NK-3).
//
// WHAT THIS GATE PROVES, AND WHAT IT DOES NOT. It proves the two authored markdown files are wired to
// each other correctly, and that every frontmatter KEY they use is a key the INSTALLED Claude Code
// harness actually accepts. It does NOT prove a fork happened: `bun test` runs under `bun`, not under
// the harness, so no test in this repo can observe one. That claim is the manual step recorded in the
// story's Debug Log (AC #3m). A gate that greps a markdown file and calls the result "a fork" would be
// the vacuity this loop exists to catch, so the ceiling is stated rather than blurred.
//
// ⚠ IT IS NOT NAMED `core-*`, deliberately: `check:core-purity` globs `src/notekit/core-*.ts`, and this
// file reads the filesystem and spawns subprocesses. ⚠ IT MUST KEEP THE `.test.ts` SUFFIX: Story 2.2's
// sole-writer gate globs `src/notekit/**/*.ts` minus `*.test.ts`, so this file sits inside that glob and
// is excluded PURELY by its suffix. Renaming it off `.test.ts` puts it under a scan it was never written
// to satisfy.
//
// ⚠ THIS FILE NECESSARILY CONTAINS EVERY BANNED TOKEN, as its own lists. It scans THE TWO AUTHORED FILES
// ONLY, never itself — a self-scan would be permanently red, and hiding the lists behind an indirection
// to dodge that would make it permanently green. Vacuous either way, so the scope is fixed and stated.
//
// ⚠ ONE DEFECT HERE WAS FOUND BY THE BEHAVIOURAL PROOF, NOT BY THIS FILE — and the gate was extended
// afterwards so it cannot come back. The skill named `--config` in prose and handed over no path, so
// the subagent `find`-swept the tree for a registry. Every file-reading check was green throughout,
// because they all asked whether the flag was MENTIONED. The added assertions ask what the flag
// CARRIES (`configArgs` below). Any future gate over these files should ask the same kind of question.
//
// ⚠ A SECOND DEFECT WAS ALSO FOUND BEHAVIOURALLY, NOT BY THIS FILE — and gate (d) below was added so it
// cannot come back. The skill body asserted that "an absent positional arrives as the empty string … not
// some 'unset' state that never occurs". The second fork proof read the prompt the subagent ACTUALLY
// received at Claude Code 2.1.222: `$0` and `$1` substituted, `$2` left in place as the two-character
// literal `$2`. So the emptiness check the file described never ran on the one input that was missing.
// The guard held — on the model recognising an unfilled placeholder, which is judgment, not a test. Gate
// (d) asserts the condition covers BOTH arrival forms for every positional, and pins the false sentence
// out: a reassurance that is wrong is a defect in a body an agent reads, not merely untidy prose.
//
// ⚠ THE SIX ERROR CODES ARE HARDCODED HERE. Story 2.1 exports `NotekitReadErrorCode` and
// `NotekitErrorCode` as TYPES ONLY (`src/cli/notekit-read.ts:62,74`) — a TS union erases at runtime, and
// 2.1 shipped no `as const` runtime mirror beside it (`core-renderspec.ts:157`'s `KNOWN_CODES` is not
// exported and covers only its own two). So this list is a COPY, and a copy drifts: if 2.1's union ever
// gains a member, this array must gain it too, and nothing mechanical will say so.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../core";

// ── the two files under test ─────────────────────────────────────────────────────────────────────
// Resolved from `import.meta.dir`, never cwd: `bun test` inherits whatever directory it was launched
// from. Two levels up reaches the repo root from `src/notekit/` — the same move
// `src/cli/notekit-deploy.test.ts:906` makes from `src/cli/`.
const REPO = join(import.meta.dir, "..", "..");
const SKILL = join(REPO, ".claude", "skills", "notewright", "SKILL.md");
const AGENT = join(REPO, ".claude", "agents", "notewright.md");

/** The closed key set (gate (b) check (i)): 6 skill keys + 5 agent keys = 11. */
const SKILL_KEYS = ["name", "description", "argument-hint", "context", "agent", "background"];
const AGENT_KEYS = ["name", "description", "tools", "model", "effort"];

/** AC #4a — the eight tokens `tools` must never contain. A tool added to the allowlist joins this too. */
const BANNED_TOOLS = [
  "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent",
];
const ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Bash"];

/** AC #6 — the closed six-member union, two shapes. See the hardcoding warning in the header. */
const ERROR_CODES = [
  "nk-note-unreadable", "nk-no-opt-in", "nk-no-fence", "nk-unknown-type",   // 2.1, {code,message}
  "nk-missing-field", "nk-unknown-version",                                 // core, {code,message,field}
];

/** AC #5 — bare note-type names. Threshold 2 per line: prose uses one, a rotting list enumerates. */
const TYPE_NAMES = ["card", "primer", "protocol", "pattern"];
/** AC #5 — `nk-`-prefixed type literals. Identifiers, never prose, so a bare scan is safe. */
const TYPE_LITERALS = ["nk-card", "nk-primer", "nk-protocol", "nk-pattern"];
/** AC #5 — caller-state phrases. ALL MULTI-WORD ON PURPOSE: a single-word list ("earlier", "above")
 *  reddens on correct prose, and the first dev to hit that deletes the gate. */
const CALLER_STATE = ["as discussed", "you mentioned", "the note we", "earlier in this conversation"];

/** Gate (d) — every positional the skill body reads. `$0` mode, `$1` note path, `$2` config path. */
const POSITIONALS = ["$0", "$1", "$2"];

// ── pure functions: every gate is one, so every gate has a watched counterfactual ────────────────
// Declared as hoisted `function`s at module scope. Both the real assertions and their counterfactuals
// call them, so a `const` local to one test could not serve the other, and a module-scope `const`
// referenced above its declaration dies at runtime with a TDZ ReferenceError.

/** Own-property keys of a frontmatter block, in file order. */
function frontmatterKeys(text: string): string[] {
  return Object.keys(parseFrontmatter(text));
}

/**
 * Keys present that are NOT in `allowed`.
 * ⚠ MEMBERSHIP IS A `Set`, NEVER `key in obj` — `in` walks the prototype chain, so a frontmatter key
 * named `constructor`, `toString`, `valueOf` or `__proto__` would test as "allowed" against an object
 * literal and slip through. That is the exact hole the Epic-1 retro records a fix reopening.
 */
function strayKeys(text: string, allowed: string[]): string[] {
  const ok = new Set(allowed);
  return frontmatterKeys(text).filter((k) => !ok.has(k));
}

/**
 * Gate (b) check (ii). Does `key` appear as a schema key literal in the 200 chars preceding `anchor`?
 * The prose anchor proves the FEATURE still exists; the adjacent key literal proves the SPELLING.
 * A rename that keeps the prose and moves the key returns false — the July-expiry failure mode.
 *
 * ⚠ THE WINDOW STAYS AT 200 AND MUST NOT BE WIDENED "for safety". Measured at 2.1.222, `[,{]"?agent"?:`
 * and `[,{]"?background"?:` each occur TWICE on the schema line. A generous window would reach the other
 * occurrence and return true for a key that had in fact been renamed — a false PASS, which is worse than
 * the false fail it was widening to avoid.
 */
// ⚠ AMENDMENT 2, Story 2.4 (declared in its ⚠️-1). The `export` token below is the ONLY change: Story
// 2.4's apply gate needs this same probe for `disable-model-invocation`, and a COPY would give the
// estate's only frontmatter-expiry guard two sources of truth — the day one is corrected the other rots
// silently. One token, one owner. Nothing about the function's behaviour or its 200-char window moved.
export function probeKeySpelling(schemaLine: string, key: string, anchor: string): boolean {
  const at = schemaLine.indexOf(anchor);
  if (at < 0) return false; // the prose itself is gone: the feature moved, which is also a red
  const window = schemaLine.slice(Math.max(0, at - 200), at);
  return new RegExp('[,{]"?' + key + '"?:').test(window);
}

/**
 * Non-comment, non-blank lines inside every ```bash / ```sh fence.
 * ⚠ Used ONLY for the first-token check. The note-type scans deliberately do NOT mask fences (see below).
 */
function shellLines(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("```")) {
      const info = t.slice(3).trim().toLowerCase();
      inBlock = !inBlock && (info === "bash" || info === "sh");
      continue;
    }
    if (inBlock && t.length > 0 && !t.startsWith("#")) out.push(t);
  }
  return out;
}

/**
 * Gate (c) — the config handoff. For every `--config` occurrence inside a ```bash / ```sh fence, the
 * token that IMMEDIATELY FOLLOWS the flag. A trailing `--config` with nothing after it yields `""`,
 * which fails the substitution assertion instead of passing vacuously.
 *
 * ⚠ THIS IS WHY THE ASSERTION IS NOT `text.includes("--config")`. The behavioural fork proof (AC #3m)
 * caught the skill mentioning `--config` in prose while handing over no path, and the subagent then
 * `find`-swept the tree for a registry — the exact behaviour its own body forbids. A gate that greps
 * for the flag would have been GREEN throughout that defect. What has to be true is that the flag
 * carries a SUBSTITUTED POSITIONAL, so this reads the argument rather than the mention.
 */
function configArgs(text: string): string[] {
  const out: string[] = [];
  for (const line of shellLines(text)) {
    const parts = line.split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "--config") out.push(parts[i + 1] ?? "");
    }
  }
  return out;
}

/**
 * Gate (d) — the body as LOGICAL lines: a markdown source line joined with every wrapped continuation
 * of it, whitespace-collapsed. A rule whose sentence wraps across three source lines is ONE entry here.
 *
 * ⚠ WHY NOT `text.split("\n")`. Every rule gate (d) checks is a long sentence, and long sentences wrap.
 * A raw line scan asking "does the line naming `$2` also name the placeholder form?" would answer no on
 * a correct file purely because the clause landed on the next source line — a false-positive machine,
 * and the first dev to hit it deletes the gate. Joining first is what lets the assertions be about the
 * RULE rather than about where the author happened to wrap.
 *
 * Fenced blocks are passed through line-by-line, never joined: their lines are commands, not prose, and
 * `shellLines` above is the function that reads them.
 */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (t.startsWith("```")) { inFence = !inFence; out.push(t); continue; }
    if (t.length === 0 || inFence) { out.push(t); continue; }
    const prev = out[out.length - 1];
    const continues =
      prev !== undefined && prev.length > 0 && !prev.startsWith("```") && !prev.startsWith("#") &&
      !/^([-*+]\s|#{1,6}\s|\d+[.)]\s|>|\|)/.test(t);
    if (continues) out[out.length - 1] = `${prev} ${t}`;
    else out.push(t);
  }
  return out.filter((l) => l.length > 0);
}

/**
 * Gate (d) — the body's ONE definition of an unfilled input: the rule naming BOTH arrival forms.
 *
 * ⚠ BOTH FORMS IN THE SAME RULE, deliberately. Two mentions in two unrelated places would satisfy a
 * pair of `toContain` checks while leaving the actual condition written on emptiness alone — which is
 * precisely the state the second fork proof found, where the file's reassuring prose and its operative
 * check disagreed. Requiring one rule to carry both is what makes them impossible to drift apart.
 */
function unfilledRule(text: string): string[] {
  return logicalLines(text).filter((l) => {
    const lower = l.toLowerCase();
    return lower.includes("empty string") && lower.includes("dollar sign");
  });
}

/** Gate (d) — the fail-loud stop condition: the rule that governs both stoppable positionals. */
function stopGuard(text: string): string[] {
  return logicalLines(text).filter((l) => l.includes("`$1` is empty") && l.includes("`$2` is empty"));
}

/** Gate (d) — the rule stating the mode default. */
function modeDefault(text: string): string[] {
  return logicalLines(text).filter((l) => l.includes("`$0`") && l.includes("`transform`"));
}

/** Markdown emphasis stripped and lowercased, so an assertion is about words, not about `**`. */
function plain(text: string): string {
  return text.replace(/\*\*/g, "").toLowerCase();
}

/**
 * Every `nk-`-prefixed token in the text. Strict by design: any non-member is a finding.
 * ⚠ CASE-INSENSITIVE ON PURPOSE, AND NORMALISED DOWN. A lowercase-only scan lets `nk-Card` and
 * `NK-CARD` walk straight past a gate whose whole point is that ANY non-member token is a finding —
 * the caller compares against `ERROR_CODES`, which is lowercase, so the match is lowered here rather
 * than at each call site.
 */
function nkTokens(text: string): string[] {
  return [...text.matchAll(/nk-[a-z][a-z0-9-]*/gi)].map((m) => m[0].toLowerCase());
}

/**
 * Every path in the raw stdout of `git status --porcelain -z`.
 *
 * ⚠ `-z` IS LOAD-BEARING, TWICE, AND PORCELAIN v1's DEFAULT SHAPE CANNOT BE PARSED BY `slice(3)`.
 * Measured against a scratch repo 2026-08-06: a modification of `src/needs quoting$.ts` prints
 * ` M "src/needs quoting$.ts"` — C-quoted, quotes and all — and a rename prints as the single record
 * `R  src/original.ts -> src/renamed.ts`. Neither string can ever equal an allowlist entry, so a
 * `slice(3)` parse waves both files through while the gate reports green: the worst failure a scope
 * gate has, because it looks like a pass.
 *
 * ⚠ AND `-z` DOES NOT MAKE A RENAME ONE RECORD — it makes it TWO. The `R ` record carries the NEW path;
 * the record IMMEDIATELY AFTER it is the OLD path and carries NO status prefix, so slicing 3 off it
 * would mangle it into `/original.ts`. It is consumed explicitly here. Both halves are returned: a
 * rename touches the path it left as much as the path it landed on, and AC #4c is about files touched.
 */
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

/** Lines naming `threshold` or more of `names` — the shape a hardcoded list always has. */
function enumeratingLines(text: string, names: string[], threshold: number): string[] {
  return text.split(/\r?\n/).filter((line) => {
    const lower = line.toLowerCase();
    const hits = names.filter((n) => new RegExp(`\\b${n}\\b`).test(lower)).length;
    return hits >= threshold;
  });
}

/** Banned tool tokens found in a raw `tools` value, both as exact tokens and as substrings. */
function bannedToolsIn(raw: string): string[] {
  const tokens = new Set(raw.split(",").map((s) => s.trim()));
  return BANNED_TOOLS.filter((b) => tokens.has(b) || raw.includes(b));
}

/**
 * The schema line from the INSTALLED harness, or `null` when there is no `claude` on PATH.
 * ⚠ `which claude` may well return a SYMLINK — at 2.1.222 it is `~/.local/bin/claude` pointing at the
 * version directory. No `readlink` is needed, but not for the reason the story gave: it is not "the
 * binary rather than a symlink", it is that `strings` reads THROUGH the link either way.
 */
function schemaLine(): string | null {
  // ⚠ BOTH SPAWNS ARE GUARDED, AND THE REASON IS MEASURED. `Bun.spawnSync` does NOT report an
  // unresolvable command as a non-zero `exitCode` — it THROWS (`Error: Executable not found in $PATH`,
  // probed 2026-08-06 at bun 1.x). This function is called in a `describe` BODY, so an escaping throw
  // fails COLLECTION and takes the whole file down rather than one test. `strings` ships with binutils
  // and is absent from slim CI images — exactly the host that has `claude` but not the probe. Returning
  // `null` routes a missing tool into the same warned-skip posture a missing `claude` already gets.
  const run = (cmd: string[]) => {
    try {
      return Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
    } catch {
      return null;
    }
  };
  const which = run(["which", "claude"]);
  if (which === null || which.exitCode !== 0) return null;
  const bin = which.stdout.toString().trim();
  if (bin.length === 0) return null;
  const strings = run(["strings", bin]);
  if (strings === null || strings.exitCode !== 0) return null;
  // ⚠ SELECT BY CONTENT, NEVER BY POSITION. `Agent type to spawn when` matches TWO lines at 2.1.222 —
  // a 41-byte bare description string and the 28,873-byte line holding both schemas. Taking `lines[0]`
  // would window into the short line and return false forever: a gate that cannot reach its pass state.
  const hits = strings.stdout
    .toString()
    .split("\n")
    .filter((l) => l.includes("Agent type to spawn when") && l.includes("Where the skill runs:"));
  return hits.length === 1 ? hits[0]! : null;
}

// ── the files, read once ─────────────────────────────────────────────────────────────────────────
const skillText = existsSync(SKILL) ? readFileSync(SKILL, "utf-8") : "";
const agentText = existsSync(AGENT) ? readFileSync(AGENT, "utf-8") : "";

describe("notewright dispatch — gate (a): referential integrity", () => {
  test("the repo root resolved to the right depth", () => {
    // Asserted first and explicitly, so a wrong `../` count fails HERE with a clear message instead of
    // as a confusing ENOENT four assertions later.
    expect(existsSync(join(REPO, "package.json"))).toBe(true);
  });

  test("both files exist", () => {
    expect(existsSync(SKILL)).toBe(true);
    expect(existsSync(AGENT)).toBe(true);
  });

  test("both files actually have a frontmatter block", () => {
    // `parseFrontmatter` returns `{}` on no block — never null. Without this assertion, a file with a
    // BOM before its `---` (the regex is anchored at `^---`, so a BOM defeats it) or a missing closing
    // `---` would parse as EMPTY, and every equality below would fail for a misleading reason.
    expect(frontmatterKeys(agentText).length).toBeGreaterThan(0);
    expect(frontmatterKeys(skillText).length).toBeGreaterThan(0);
  });

  test("the skill forks, in-line, to an agent that resolves", () => {
    const skill = parseFrontmatter(skillText);
    const agent = parseFrontmatter(agentText);

    expect(skill.context).toBe("fork");

    // ⚠ THE STRING "false", NOT THE BOOLEAN. `parseFrontmatter` returns `Record<string, string|string[]>`
    // (`src/core/parse.ts:50`); nothing in it is ever a boolean. A `!skill.background` check would pass on
    // an ABSENT key — green for the exact defect this asserts against, since the harness default is
    // background:true and a backgrounded fork returns a task notification instead of the in-line preview.
    expect(skill.background).toBe("false");

    // Checked BEFORE the equality: a YAML-list value arrives as `string[]`, and `=== agent.name` would
    // then be false for the wrong reason and send a reader hunting the wrong bug.
    expect(typeof skill.agent).toBe("string");
    expect((skill.agent as string).length).toBeGreaterThan(0);
    expect(typeof agent.name).toBe("string");
    expect((agent.name as string).length).toBeGreaterThan(0);

    expect(skill.agent).toBe(agent.name as string);
    expect(existsSync(join(REPO, ".claude", "agents", `${skill.agent}.md`))).toBe(true);
  });

  // ── counterfactual 1: the agent file's name no longer resolves ──
  test("COUNTERFACTUAL 1 — a renamed agent breaks the equality and the file check", () => {
    const mutated = agentText.replace("name: notewright", "name: notewright2");
    expect(parseFrontmatter(mutated).name).not.toBe(parseFrontmatter(skillText).agent);
    expect(existsSync(join(REPO, ".claude", "agents", "notewright2.md"))).toBe(false);
  });

  test("COUNTERFACTUAL 1b — deleting `background: false` reddens the in-line assertion", () => {
    const mutated = skillText.replace("background: false\n", "");
    expect(parseFrontmatter(mutated).background).toBeUndefined();
    expect(parseFrontmatter(mutated).background).not.toBe("false");
  });
});

describe("notewright dispatch — gate (b) check (i): the closed 11-key set", () => {
  // 🔴 THIS CHECK RUNS EVERYWHERE, INCLUDING CI, AND IS DELIBERATELY OUTSIDE THE SKIP BELOW. It compares
  // the two files against a list written in the story and needs no binary. Skipping the cheapest and most
  // load-bearing half because an unrelated dependency is absent would leave the claim unenforced on
  // exactly the machine — a fresh clone — where a stray key is most likely to survive.
  //
  // 🔴 WHY A STRAY KEY MATTERS, AND IT IS NOT THE REASON IT FIRST LOOKED LIKE. The shipped zod schemas
  // are `.strict()`, but they are a TELEMETRY SHADOW CHECK: `safeParse` inside `try{}catch{}`, result
  // discarded at every call site. Zod is NOT on the read path — the runtime reads gate values straight
  // off the parsed YAML record, where a missing key yields `undefined ?? false`. So a stray or renamed
  // key does NOT reject the file: the file loads perfectly and the gate silently stops applying. THE
  // HARNESS FAILS OPEN. A "does it still load?" check would therefore prove nothing, because the real
  // failure mode is a live file with a dead gate.

  test("skill frontmatter carries exactly its six keys", () => {
    expect(strayKeys(skillText, SKILL_KEYS)).toEqual([]);
    expect(frontmatterKeys(skillText).sort()).toEqual([...SKILL_KEYS].sort());
  });

  test("agent frontmatter carries exactly its five keys", () => {
    expect(strayKeys(agentText, AGENT_KEYS)).toEqual([]);
    expect(frontmatterKeys(agentText).sort()).toEqual([...AGENT_KEYS].sort());
  });

  test("the two sets are the eleven the story prescribes", () => {
    expect(SKILL_KEYS.length + AGENT_KEYS.length).toBe(11);
  });

  test("neither file carries `permissionMode` or `disallowedTools`", () => {
    // `permissionMode` ABSENT is the AC, not `permissionMode: default` — an absent key inherits the
    // parent's mode, so there is no value to drift toward `bypassPermissions`. `disallowedTools` is a
    // real schema key but INERT beside `tools` ("Ignored if `tools` is set"), so shipping it would be a
    // line that looks like a denial and enforces nothing.
    for (const key of ["permissionMode", "disallowedTools", "permissions"]) {
      expect(frontmatterKeys(agentText)).not.toContain(key);
      expect(frontmatterKeys(skillText)).not.toContain(key);
    }
  });

  // ── counterfactual 2: a key the harness does not accept ──
  test("COUNTERFACTUAL 2 — `permissions: read-only` is caught as a stray key", () => {
    // Not hypothetical: 6 of the 12 files in the user-level agents directory carry `permissions:`, and it
    // is NOT in the shipped schema. Live estate usage is not evidence a key is supported; this is the
    // check that separates the two.
    const mutated = agentText.replace("tools:", "permissions: read-only\ntools:");
    expect(strayKeys(mutated, AGENT_KEYS)).toEqual(["permissions"]);
  });

  test("COUNTERFACTUAL 2b — a prototype-chain key name cannot hide in the allowed set", () => {
    // E1-A3: `key in {name:1}` is TRUE for "constructor", "toString", "valueOf" and "__proto__". A
    // membership test written with `in` would wave every one of them through. `strayKeys` uses a Set.
    //
    // ⚠ THE FOURTH NAME, `__proto__`, IS DELIBERATELY NOT IN THIS LOOP — a stated ceiling, not an
    // oversight, and not a `strayKeys` defect. `parseFrontmatter` builds a plain object literal and
    // assigns with `result[key] = …` (`src/core/parse.ts:66`), so a `__proto__:` line hits the
    // prototype SETTER instead of creating an own property. `Object.keys` therefore never lists it and
    // `strayKeys` returns `[]`. Adding `__proto__` to the loop above would go red on that `[]` and read
    // as a hole in `strayKeys`. The assertion below pins the real behaviour so the next author sees it.
    for (const evil of ["constructor", "toString", "valueOf"]) {
      const mutated = agentText.replace("tools:", `${evil}: x\ntools:`);
      expect(strayKeys(mutated, AGENT_KEYS)).toEqual([evil]);
    }
  });

  test("COUNTERFACTUAL 2c — `__proto__` is the one name this gate CANNOT catch, and why", () => {
    // The ceiling above, asserted rather than asserted-about. A string value makes the setter a no-op,
    // so nothing is polluted either — the key simply vanishes, invisibly to any own-key scan.
    const mutated = agentText.replace("tools:", "__proto__: x\ntools:");
    const parsed = parseFrontmatter(mutated);
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(false);
    expect(Object.getOwnPropertyNames(parsed)).not.toContain("__proto__");
    expect(strayKeys(mutated, AGENT_KEYS)).toEqual([]);
    // And the prototype is untouched, so the smuggled key corrupts nothing downstream either.
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});

describe("notewright dispatch — gate (b) check (ii): key spelling is alive in the installed harness", () => {
  // Anchors are the harness's OWN ENGLISH, which does not churn. ⚠ NOT the minified helper names
  // (`jL`, `Xpt`, `Qpt`): those are minifier output and change on every build, so a gate keyed to them
  // would go red on a harmless version bump — a false-positive machine, not a gate.
  //
  // ⚠ `background` uses a NEARER anchor than the story prescribed, and the reason is measured, not
  // stylistic. Against the story's anchor ("to keep the caller waiting for the result in-line") the key
  // literal sits 177 chars back — 23 chars of headroom inside a 200-char window. Any harness re-wording
  // that lengthened that description by more than 23 characters would redden this gate on a change that
  // broke nothing. The nearer anchor sits 38 chars from the key. The story's phrase is kept below as a
  // SEPARATE whole-line assertion, so the semantics it proves are not lost.
  const PAIRS: Array<[string, string]> = [
    ["context", "Where the skill runs:"],
    ["agent", "Agent type to spawn when"],
    ["background", "Only for `context: fork`"],
    ["tools", "Tools available to this agent"],
  ];

  const line = schemaLine();

  test("every prescribed key name is still the harness's own spelling", () => {
    if (line === null) {
      // SKIP = exit 0, the estate's adapter posture. Written as a passing assertion plus a warning
      // rather than `test.skip`, because a statically skipped test cannot report WHY it skipped.
      console.warn("[notewright-dispatch] SKIP: no `claude` on PATH — key-spelling liveness unverified");
      expect(true).toBe(true);
      return;
    }
    // A future single-line split would leave a fragment that probes green by accident; fail loudly first.
    expect(line.length).toBeGreaterThan(10_000);
    for (const [key, anchor] of PAIRS) {
      expect(probeKeySpelling(line, key, anchor)).toBe(true);
    }
  });

  test("the semantics `background: false` buys are still described by the harness", () => {
    if (line === null) {
      console.warn("[notewright-dispatch] SKIP: no `claude` on PATH — background semantics unverified");
      expect(true).toBe(true);
      return;
    }
    // The prose the nearer anchor gave up. If the harness stops promising that `false` keeps the caller
    // waiting in-line, `background: false` no longer buys the human-visible preview and this goes red.
    expect(line).toContain("to keep the caller waiting for the result in-line");
  });

  // ── counterfactual 5: the story's headline risk, and the only one that proves it detectable ──
  test("COUNTERFACTUAL 5 — a renamed key is caught even though the prose survives", () => {
    // You cannot rename a key inside the installed harness, so the probe is a PURE FUNCTION of the schema
    // line and the counterfactual feeds it a mutated one. Without this seam the probe could only ever be
    // observed green, and gate (b) would be decoration.
    const real = line ?? 'x,agent:jL().optional().describe("Agent type to spawn when `context: fork`.")';
    expect(probeKeySpelling(real, "agent", "Agent type to spawn when")).toBe(true);

    const renamed = real.replaceAll(",agent:", ",subagent:");
    expect(probeKeySpelling(renamed, "agent", "Agent type to spawn when")).toBe(false);
  });

  test("COUNTERFACTUAL 5b — a key that vanishes with its prose is also caught", () => {
    const real = line ?? 'x,background:Qpt().optional().describe("Only for `context: fork`. …")';
    expect(probeKeySpelling(real, "background", "Only for `context: fork`")).toBe(true);
    expect(probeKeySpelling(real.replaceAll(",background:", ",bg:"), "background", "Only for `context: fork`"))
      .toBe(false);
    // Anchor gone entirely ⇒ false, not a crash: the feature moved, which is also a red.
    expect(probeKeySpelling("nothing here", "agent", "Agent type to spawn when")).toBe(false);
  });
});

describe("notewright dispatch — gate (c): content assertions", () => {
  test("AC #4a — `tools` is the four-token allowlist and none of the eight banned tokens", () => {
    const raw = parseFrontmatter(agentText).tools;
    // The comma-separated STRING form is pinned. `parseFrontmatter` only produces `string[]` for a
    // bracketed `[a, b]` value (`src/core/parse.ts:59-65`), so the YAML-list form would silently change
    // this assertion's shape. Pick one, consistently — this is that pick.
    expect(typeof raw).toBe("string");
    const tools = (raw as string).split(",").map((s) => s.trim());
    expect(tools).toEqual(ALLOWED_TOOLS);
    expect(bannedToolsIn(raw as string)).toEqual([]);
    expect(BANNED_TOOLS.length).toBe(8);
  });

  // ── counterfactual 3 ──
  test("COUNTERFACTUAL 3 — appending `Write` to `tools` is caught", () => {
    expect(bannedToolsIn("Read, Grep, Glob, Bash, Write")).toEqual(["Write"]);
    // And the substring half catches the compound name a token split alone would let past on its own.
    expect(bannedToolsIn("Read, NotebookEdit")).toContain("NotebookEdit");
  });

  test("AC #4b — every shell line in both files starts with `std`", () => {
    // ⚠ A BODY-CONTENT GATE, NOT A RUNTIME GUARANTEE. The agent holds `Bash` and could emit a command
    // its body never showed. The runtime guarantee is NK-4's and lives in 2.2's source scan and byte
    // assertions, not here. This bounds what the definition TEACHES, which is all a text file can bound.
    for (const text of [agentText, skillText]) {
      const lines = shellLines(text);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l.split(/\s+/)[0]).toBe("std");
    }
  });

  // ── counterfactual 4 ──
  test("COUNTERFACTUAL 4 — a `cp` line inside a shell block is caught", () => {
    const mutated = agentText.replace(
      "std notekit validate --spec - --json",
      "std notekit validate --spec - --json\ncp $1 /tmp/backup.md",
    );
    const firsts = shellLines(mutated).map((l) => l.split(/\s+/)[0]);
    expect(firsts).toContain("cp");
    expect(firsts.every((f) => f === "std")).toBe(false);
    // And `sed -i`, the other shape of the same defect.
    const sed = agentText.replace("std notekit render", "sed -i '' s/a/b/ $1\nstd notekit render");
    expect(shellLines(sed).map((l) => l.split(/\s+/)[0])).toContain("sed");
  });

  test("AC #4d — the apply flag reaches the preview SKILL never, and the agent only to forbid itself", () => {
    // Same invariant as 2.2's "no default that enables it", one layer up: 2.2 ensures the flag has no
    // default that turns it on; 2.3 ensures no ungated surface types it.
    const flag = "--" + "apply"; // split so this file's own list does not trip a future whole-tree scan

    // The preview SKILL keeps the absolute zero. It is model-invocable, so the flag must not reach it.
    expect(skillText).not.toContain(flag);

    // ⚠ THE AGENT HALF WAS AMENDED 2026-08-06 (review of 2.4). The blanket zero was wrong in a way that
    // took building 2.4 to see: the agent is the EXECUTOR, and forbidding it the flag left it unable to
    // state the one rule that matters ("never write `--apply` yourself"). 2.4 reconciled it instead with
    // a general posture clause — "that posture was authorized by the human who typed it" — which asserts
    // something a forked run CANNOT verify, and which a model-authored spawn prompt satisfies exactly as
    // well as a human one. A vague rule on a write path is worse than a specific one, so the specific one
    // is now permitted and the vague one is banned by name.
    const forbids = /never write `--apply` yourself/.test(agentText);
    expect(forbids).toBe(true);
    // Every occurrence in the agent must sit in the prohibition, never in a runnable command block.
    for (const line of shellLines(agentText)) expect(line).not.toContain(flag);
    // …and the superseded authorization-by-inference wording must not come back.
    expect(agentText).not.toMatch(/authorized by the human who typed it/);
  });

  test("AC #5 — no `nk-`-prefixed note-type literal in either file", () => {
    for (const text of [agentText, skillText]) {
      for (const lit of TYPE_LITERALS) expect(text).not.toContain(lit);
    }
    expect(TYPE_LITERALS.length).toBe(4);
  });

  test("AC #5 — every `nk-` token in either file is one of the six error codes", () => {
    // Strict by design, and it subsumes the literal check above: ANY `nk-` token that is not a member is
    // a finding, including a note-type name nobody thought to ban. Scanned UN-MASKED across the whole
    // file — masking fences would quietly permit a hardcoded type list inside one, the exact rot AC #5
    // exists to stop, and these tokens are identifiers with no false-positive surface in prose.
    const known = new Set(ERROR_CODES);
    for (const text of [agentText, skillText]) {
      const stray = [...new Set(nkTokens(text))].filter((t) => !known.has(t));
      expect(stray).toEqual([]);
    }
    expect(ERROR_CODES.length).toBe(6);
  });

  test("AC #5 — no line enumerates two or more bare note-type names", () => {
    // Threshold 2 because a rotting hardcoded list ALWAYS enumerates, while ordinary prose uses one such
    // word at a time. ⚠ A bare `\b(card|primer|protocol|pattern)\b` scan at threshold 1 is a
    // false-positive machine — "follow the error-reporting protocol" and "use this pattern" both match,
    // and the first dev to hit that deletes the gate.
    for (const text of [agentText, skillText]) {
      expect(enumeratingLines(text, TYPE_NAMES, 2)).toEqual([]);
    }
  });

  test("AC #5 — the enumeration gate stays green on ordinary prose and red on a list", () => {
    // Proving the gate can reach BOTH states, which is the difference between a gate and a decoration.
    expect(enumeratingLines("follow the error-reporting protocol below", TYPE_NAMES, 2)).toEqual([]);
    expect(enumeratingLines("use this pattern for every failed render", TYPE_NAMES, 2)).toEqual([]);
    expect(enumeratingLines("supported types: card, primer, protocol", TYPE_NAMES, 2)).toHaveLength(1);
  });

  test("AC #5 — no phrase reaching for caller state", () => {
    for (const text of [agentText, skillText]) {
      const lower = text.toLowerCase();
      for (const phrase of CALLER_STATE) expect(lower).not.toContain(phrase);
    }
    expect(CALLER_STATE.length).toBe(4);
  });

  test("AC #5 — the skill body uses `$0` and `$1` and no other substitution form", () => {
    expect(skillText).toContain("$0");
    expect(skillText).toContain("$1");
    // `$ARGUMENTS` would collapse the two positionals into one string, defeating the empty-`$1` check.
    expect(skillText).not.toContain("$ARGUMENTS");
    // No `@`-inlined path: the CLI reads the note itself, so an inlined copy is a second source of truth
    // that can drift from what `render` parses (declared Variance 4).
    expect(skillText).not.toMatch(/@[A-Za-z0-9_./~-]/);
    // No `!`-prefixed backtick block: pre-fork shell execution would run BEFORE the empty-`$1` check and
    // outside the agent's tool scope — the one place a command could run that the shell-line scan
    // never sees.
    expect(skillText).not.toMatch(/!`/);
  });

  test("AC #5 — the skill body fails loud on a note path that never arrived", () => {
    // ⚠ THIS COMMENT SAID THE OPPOSITE AND WAS WRONG. It read: "an absent positional substitutes to the
    // empty string, so a body branching on 'unset' would describe a state that never occurs". The second
    // fork proof read the DELIVERED prompt at 2.1.222 and found the unfilled positional arriving as the
    // literal `$N` — the state that "never occurs" is the one that occurred. Gate (d) carries the
    // corrected condition. This assertion keeps only its narrower claim: the body branches on the note
    // path and prints a usage line. Emptiness is still one real arrival form, so `empty` stays required.
    expect(skillText).toContain("$1");
    expect(skillText.toLowerCase()).toContain("empty");
    expect(skillText.toLowerCase()).toContain("usage:");
  });

  test("AC #5 — the catalog is reached by calling `capabilities`, never restated", () => {
    expect(agentText).toContain("std notekit capabilities --config");
    expect(skillText).toContain("std notekit capabilities --config");
  });

  test("AC #5 — the skill HANDS the config over as `$2`; it does not leave the agent to find one", () => {
    // FOUND BY THE BEHAVIOURAL FORK PROOF (AC #3m), not by any file-reading gate: the skill named
    // `--config` in prose and supplied no path, while the agent body says "`<note>` and `<config>` are
    // the paths handed to you. You do not discover them." Nothing handed one over, so the subagent
    // spent its first two `Bash` calls `find`-sweeping for a registry and landed on the right file only
    // because the fixture config happened to sit beside the fixture note. Against a tree holding more
    // than one registry that is a wrong render delivered confidently.
    //
    // ⚠ THIS ASSERTS SUBSTITUTION, NOT PRESENCE. `skillText.includes("--config")` was TRUE throughout
    // the defect. What must be true is that every `--config` inside a shell fence is followed by the
    // substituted positional, so the assertion reads the ARGUMENT the flag carries.
    const args = configArgs(skillText);
    expect(args.length).toBeGreaterThan(0);
    for (const arg of args) expect(arg).toBe("$2");

    // Both verbs the skill runs must carry it — a config on `capabilities` but not on `render` would
    // read the catalog from one registry and render against a discovered other.
    const configured = shellLines(skillText).filter((l) => l.includes("--config"));
    expect(configured.some((l) => l.includes("notekit capabilities"))).toBe(true);
    expect(configured.some((l) => l.includes("notekit render"))).toBe(true);

    // The unsubstituted placeholder belongs to the AGENT's generic body, never to the skill's rendered
    // one: the skill is the surface the harness substitutes into, so a placeholder surviving here means
    // the handover did not happen.
    expect(skillText).not.toContain("--config <config>");

    // And the positional is declared as an input, not only used in a command.
    expect(skillText).toContain("`$2`");
  });

  test("AC #5 — the skill body fails loud on an EMPTY config path and offers NO discovery fallback", () => {
    // Same shape as the note-path guard above, because it is the same failure. ⚠ The reason stated here
    // used to be "an absent positional arrives as the empty string, so the branch is on emptiness, never
    // on 'unset'" — false at 2.1.222, corrected in gate (d). Emptiness is still a REQUIRED clause (an
    // explicitly-empty argument is a real arrival form); it is simply no longer a SUFFICIENT one.
    const lower = skillText.toLowerCase();
    expect(skillText).toContain("`$2` is empty");
    expect(lower).toContain("usage:");

    // The guard must STOP. A warning that lets the run continue is worse than no guard: it reads as
    // handled while the sweep still happens. `--apply` arrives on this same surface in Story 2.4, so a
    // discovered-registry run stops being a wrong preview and becomes a wrong write.
    expect(lower).toContain("no fallback");
    expect(lower).toMatch(/do not search the tree|do not fall back/);

    // The usage line the human reads must name the real arity, and `argument-hint` must agree with it —
    // a hint that lags the body is how a caller learns the wrong invocation.
    const hint = parseFrontmatter(skillText)["argument-hint"];
    expect(typeof hint).toBe("string");
    expect(hint as string).toContain("<config-path>");
    expect(skillText).toContain(`usage: /notewright ${hint as string}`);
  });

  // ── counterfactual 6: the defect itself, replanted ──
  test("COUNTERFACTUAL 6 — a `--config` with no substituted positional is caught", () => {
    // This is the shipped-and-reviewed state of the file before this fix: the flag present, the path
    // absent. `includes("--config")` stays true; `configArgs` reports the placeholder.
    const mutated = skillText.replaceAll("--config $2", "--config <config>");
    expect(mutated).toContain("--config");                 // the grep-style check still passes…
    expect(configArgs(mutated)).not.toEqual(["$2", "$2"]); // …and the substitution check does not
    expect(configArgs(mutated).every((a) => a === "$2")).toBe(false);

    // A flag dangling at end-of-line yields "" rather than reading past the array end.
    expect(configArgs("```bash\nstd notekit render $1 --config\n```")).toEqual([""]);
  });

  test("COUNTERFACTUAL 6b — dropping the config from ONE of the two verbs is caught", () => {
    const mutated = skillText.replace("std notekit render $1 --config $2 --json", "std notekit render $1 --json");
    const configured = shellLines(mutated).filter((l) => l.includes("--config"));
    expect(configured.some((l) => l.includes("notekit render"))).toBe(false);
    expect(configured.some((l) => l.includes("notekit capabilities"))).toBe(true); // the other half still there
  });

  // ── counterfactual 7: the guard deleted ──
  test("COUNTERFACTUAL 7 — deleting the absent-config guard reddens the guard assertion", () => {
    const mutated = skillText.replace("If `$1` is empty, or if `$2` is empty,", "If `$1` is empty,");
    expect(mutated).not.toContain("`$2` is empty");
    expect(skillText).toContain("`$2` is empty"); // and the real file still has it
  });

  test("COUNTERFACTUAL 7b — a guard that permits a fallback is caught", () => {
    const mutated = skillText.replace("there is no fallback", "otherwise search for one");
    expect(mutated.toLowerCase()).not.toContain("no fallback");
    expect(skillText.toLowerCase()).toContain("no fallback");
  });

  test("AC #6 — the branch field is `code`; `error.kind` appears zero times", () => {
    // NK-7 rule 2's prose says `error.kind` and is WRONG: the shipped type is
    // `Classified<C> = { code: C; message: string }` (`src/core/result.ts:10`). Reality governs; the
    // divergence is declared in the story's ⚠️-4.1, not silently absorbed.
    for (const text of [agentText, skillText]) {
      expect(text).not.toContain("error.kind");
      expect(text).toContain("error.code");
    }
  });

  test("AC #6 — the agent body names all four unrecognised-payload classes", () => {
    // E1-A3. The AC is that the instruction EXISTS and names all four; the sentence is the deliverable.
    const lower = agentText.toLowerCase();
    expect(lower).toContain("not an object");        // non-object payload
    expect(lower).toContain("empty string");         // empty-string code
    expect(lower).toContain("prototype-chain");      // prototype-chain name…
    for (const p of ["constructor", "toString", "__proto__", "valueOf"]) {
      expect(agentText).toContain(p);                // …named explicitly
    }
    expect(lower).toContain("holes");                // sparse/array-shaped payload
  });

  test("AC #6 — no apply-path error code is named on this read-only surface", () => {
    // 2.2's three codes are reachable only through the write flag, which AC #4d forbids this surface from
    // typing. Their exclusion is a property of 2.3's scope, not an oversight.
    for (const code of ["nk-note-changed", "nk-write-failed", "nk-write-unverified"]) {
      expect(agentText).not.toContain(code);
      expect(skillText).not.toContain(code);
    }
  });

  test("D4/NFR3 — no consumer identity in either file", () => {
    // ⚠ `check:no-consumer-ids` globs `src/**` ONLY, so it does NOT see `.claude/**`. That is a gap in
    // gate coverage, not a licence — this story asserts it here instead of assuming a gate has it.
    for (const text of [agentText, skillText]) {
      expect(text).not.toContain("note-report");
      expect(text).not.toContain("/Users/");
      expect(text).not.toContain("Documents/");
    }
  });
});

describe("notewright dispatch — gate (d): an unfilled positional is DETECTED, never assumed empty", () => {
  // FR-20 requires a missing input to fail loud. Before this gate the body's condition was emptiness
  // alone, and the transcript shows the missing input arriving NOT empty. What follows asserts the
  // condition the body actually instructs, for every positional it reads — never the presence of a word.

  test("the body defines an unfilled input as EMPTY OR the placeholder literal, in ONE rule", () => {
    const defs = unfilledRule(skillText);
    expect(defs.length).toBe(1);
    expect(defs[0]!.toLowerCase()).toContain("unfilled");
    // The rule governs every positional the body reads, each named by its digit — so a fourth positional
    // added later cannot inherit the rule silently while sitting outside it.
    for (const p of POSITIONALS) expect(defs[0]!).toContain("`" + p.slice(1) + "`");
  });

  test("COUNTERFACTUAL 8 — a rule naming only emptiness is caught", () => {
    // ⚠ DERIVED FROM THE LIVE FILE, like counterfactuals 6, 7 and 9–11. That is deliberate — a mutant
    // frozen into a literal stops tracking the file it guards, and goes green the day the file changes
    // out from under it. The cost is that these break their own precondition while the live file is
    // itself mutated during a watched counterfactual run, which is expected and reported, not patched.
    const mutated = skillText.replace("a dollar sign followed by that input's digit", "the empty string");
    expect(unfilledRule(mutated)).toEqual([]);
    expect(unfilledRule(skillText).length).toBe(1);
  });

  test("the fail-loud stop fires on BOTH arrival forms of `$1` and `$2`", () => {
    const guard = stopGuard(skillText);
    expect(guard.length).toBe(1);
    const lower = guard[0]!.toLowerCase();
    expect(lower).toContain("unfilled");     // absent from the emptiness-only version this replaced
    expect(lower).toContain("placeholder");  // and it names WHICH other form, not just "or otherwise"
    expect(lower).toContain("run nothing");  // and it still stops rather than warning and continuing
  });

  test("COUNTERFACTUAL 9 — an emptiness-only stop condition is caught", () => {
    const mutated = skillText.replace(", or if either arrives unfilled in the placeholder form", "");
    const guard = stopGuard(mutated);
    expect(guard.length).toBe(1);                                // the guard sentence survives…
    expect(guard[0]!.toLowerCase()).not.toContain("unfilled");   // …covering one arrival form only
    expect(stopGuard(skillText)[0]!.toLowerCase()).toContain("unfilled");
  });

  test("the `transform` default fires on an unfilled `$0`, not only an empty one", () => {
    // The second fork proof supplied `$0` explicitly in both runs, so the default path is UNVERIFIED
    // behaviourally. Given what `$2` did, an omitted `$0` plausibly arrives as the literal `$0` too —
    // so the default is written to cover both forms rather than waiting for a proof that it must be.
    const mode = modeDefault(skillText);
    expect(mode.length).toBe(1);
    expect(mode[0]!.toLowerCase()).toContain("unfilled");
  });

  test("COUNTERFACTUAL 10 — a mode default written on emptiness alone is caught", () => {
    const mutated = skillText.replace("when that arrives unfilled, the mode is", "when that is empty, the mode is");
    expect(modeDefault(mutated).length).toBe(1);
    expect(modeDefault(mutated)[0]!.toLowerCase()).not.toContain("unfilled");
  });

  test("no positional's guard rests on emptiness alone", () => {
    // The universal form of the three assertions above: whatever rule governs a positional, if it talks
    // about emptiness at all it must also cover the placeholder form. A fourth positional added with an
    // emptiness-only guard reddens here even if nobody thinks to add a named test for it.
    for (const p of POSITIONALS) {
      const governing = logicalLines(skillText).filter((l) => l.includes("`" + p + "`") && /empty|unfilled/i.test(l));
      expect(governing.length).toBeGreaterThan(0);
      for (const l of governing) expect(l.toLowerCase()).toContain("unfilled");
    }
    expect(POSITIONALS.length).toBe(3);
  });

  test("COUNTERFACTUAL 10b — reverting ANY ONE positional to emptiness alone is caught", () => {
    const governed = (text: string, p: string) =>
      logicalLines(text).filter((l) => l.includes("`" + p + "`") && /empty|unfilled/i.test(l));
    for (const [from, to] of [
      ["when that arrives unfilled, the mode is", "when that is empty, the mode is"],
      [", or if either arrives unfilled in the placeholder form", ""],
    ] as Array<[string, string]>) {
      const mutated = skillText.replace(from, to);
      const slipped = POSITIONALS.flatMap((p) => governed(mutated, p)).filter((l) => !l.toLowerCase().includes("unfilled"));
      expect(slipped.length).toBeGreaterThan(0);
    }
  });

  test("the body no longer claims an absent positional arrives as the empty string", () => {
    // A false reassurance in a body an agent reads is a defect, not untidy prose: it tells a reader the
    // guard is deterministic when it is not, and it invites the next author to write the emptiness-only
    // check again. So the wrong sentence is pinned OUT and the right one is pinned IN.
    expect(plain(skillText)).not.toContain("an absent positional arrives as the empty string");
    expect(plain(skillText)).not.toContain("state that never occurs");
    expect(plain(skillText)).not.toContain("checks on emptiness");
    // Stated positively and sourced to the version it was measured at, so the claim can be re-checked
    // rather than believed — the same reason gate (b) reads the installed binary instead of a doc.
    expect(plain(skillText)).toContain("an absent positional does not reliably arrive as the empty string");
    expect(skillText).toContain("2.1.222");
  });

  test("COUNTERFACTUAL 11 — the false reassurance is caught if it returns verbatim", () => {
    const mutated = skillText.replace(
      /An absent positional does \*\*not\*\* reliably arrive[\s\S]*?actually missing\./,
      'An absent positional arrives as the empty string, so both of these are checks on emptiness — not on\nsome "unset" state that never occurs.',
    );
    expect(plain(mutated)).toContain("an absent positional arrives as the empty string");
    expect(plain(mutated)).toContain("state that never occurs");
    expect(plain(mutated)).toContain("checks on emptiness");
    expect(plain(skillText)).not.toContain("an absent positional arrives as the empty string");
  });

  test("the body reads no positional beyond the three it declares", () => {
    for (const p of POSITIONALS) expect(skillText).toContain(p);
    expect(skillText).not.toContain("$3");
    expect(skillText).not.toContain("$4");
  });
});

describe("notewright dispatch — AC #4c: nothing under src/ or scripts/ moved", () => {
  /**
   * The working-tree allowlist. ⚠ EXTEND, NEVER REPLACE, and never widen to a prefix — Stories 2.4,
   * 2.5, 2.6 and 2.7 each append their own file here (the Epic-2 ruling §7 makes that explicit). A
   * prefix like `src/notekit/` would silently permit every future file in the slice.
   */
  // ⚠ AMENDMENT 1, Story 2.4 (declared in its ⚠️-1). ONE exact path appended — 2.4's apply gate lives at
  // `src/notekit/notewright-apply-gate.test.ts` (beside the slice it governs, D6), so it lands inside this
  // scan the moment it exists. This EXTENDS the enumeration and does not relax it: an unlisted dirty path
  // under `src/` or `scripts/` still reddens. It is deliberately NOT a prefix like `src/notekit/notewright-*`
  // — a permissive pattern is how this assertion would stop being a gate.
  const WORKING_TREE_ALLOWLIST = [
    "src/notekit/notewright-dispatch.test.ts",
    "src/notekit/notewright-apply-gate.test.ts",
  ];

  test("COUNTERFACTUAL 12 — a rename parses to BOTH its paths, not to `old -> new`", () => {
    // Constructed from REAL `-z` output (probed 2026-08-06 against a scratch repo), so the shape is
    // measured rather than assumed. Tested on the parser rather than by renaming a file in the live
    // tree: a gate that has to dirty the repo to prove itself is not one anybody will run twice.
    expect(porcelainPaths("R  src/renamed.ts\0src/original.ts\0")).toEqual([
      "src/renamed.ts",
      "src/original.ts",
    ]);
    // The v1 default shape this replaced. `slice(3)` on it yields one unmatched pseudo-path.
    expect("R  src/original.ts -> src/renamed.ts".slice(3).trim()).toBe(
      "src/original.ts -> src/renamed.ts",
    );
    expect(WORKING_TREE_ALLOWLIST).not.toContain("src/original.ts -> src/renamed.ts");
  });

  test("COUNTERFACTUAL 12b — a special-character path arrives unquoted under `-z`", () => {
    // Porcelain v1 WITHOUT `-z` C-quotes this path, and `"src/needs quoting$.ts"` — quotes included —
    // can never match an allowlist entry, so the gate would wave the file through while looking green.
    expect(porcelainPaths(" M src/needs quoting$.ts\0")).toEqual(["src/needs quoting$.ts"]);
    expect(' M "src/needs quoting$.ts"'.slice(3).trim()).toBe('"src/needs quoting$.ts"');
  });

  test("COUNTERFACTUAL 12c — an ordinary modification and an untracked file still parse", () => {
    expect(porcelainPaths(" M src/a.ts\0?? src/b.ts\0M  src/c.ts\0")).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
    expect(porcelainPaths("")).toEqual([]);
  });

  test("the only changed path is this test file itself", () => {
    // ⚠ ASSERTED ON THE WORKING TREE, NOT `git diff <base>..HEAD`, which compares committed history and
    // returns empty pre-commit whatever the tree holds — vacuous exactly when it matters.
    //
    // ⚠ AND THE ALLOWLIST IS WHAT LETS THIS GATE REACH ITS PASS STATE. Without it the gate is red by
    // construction from the moment this file exists, and a gate that is always red is neither a pass nor
    // a fail.
    //
    // ⚠ IT STAYS HERE, AND THE RECOMMENDATION TO MOVE IT TO A CI-ONLY SCRIPT IS DECLINED. AC #4c asserts
    // the property ON THE WORKING TREE, and the Epic-2 ruling §7 makes the allowlist an object Stories
    // 2.4 → 2.7 EXTEND, never replace. A CI-only gate decouples the assertion from the story that owns
    // it and drops the extend-never-replace protocol with it. The two parsing defects raised underneath
    // that recommendation were real, and are fixed in `porcelainPaths` above.
    const proc = Bun.spawnSync({
      cmd: ["git", "status", "--porcelain", "-z", "--", "src/", "scripts/"],
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const paths = porcelainPaths(proc.stdout.toString());
    expect(paths.filter((p) => !WORKING_TREE_ALLOWLIST.includes(p))).toEqual([]);
  });
});

describe("notewright dispatch — hostile frontmatter inputs (E1-A3)", () => {
  // The deliverable here is two markdown files parsed as frontmatter, so the hostile inputs are the
  // file's own. Each of these is the behaviour the gates above depend on; if one changes, they break.

  test("a file with no frontmatter parses to {} rather than throwing", () => {
    expect(parseFrontmatter("# just a heading\n")).toEqual({});
    expect(parseFrontmatter("")).toEqual({});
  });

  test("a BOM before `---` defeats the block entirely — which is why gate (a) asserts non-empty", () => {
    // ⚠ WRITTEN AS AN ESCAPE, NEVER AS A LITERAL U+FEFF. A literal zero-width BOM in source is invisible
    // in every editor and survives only as long as every formatter, editor and diff tool on the path
    // preserves the byte — the day one strips it this test silently becomes a test of `"---"`.
    const bom = "\uFEFF---\nname: notewright\n---\n";
    expect(bom.charCodeAt(0)).toBe(0xfeff); // the input is what it claims to be
    expect(parseFrontmatter(bom)).toEqual({});
    // Without gate (a)'s explicit non-empty assertion this would surface as a confusing `undefined`
    // equality failure rather than "this file has no frontmatter".
    expect(frontmatterKeys(bom).length).toBe(0);
  });

  test("CRLF line endings still parse", () => {
    const fm = parseFrontmatter("---\r\nname: notewright\r\nbackground: false\r\n---\r\n");
    expect(fm.name).toBe("notewright");
    expect(fm.background).toBe("false");
  });

  test("a second `---` inside the body does not extend the block", () => {
    const fm = parseFrontmatter("---\nname: notewright\n---\n\nbody\n\n---\n\nrogue: value\n");
    expect(Object.keys(fm)).toEqual(["name"]);
    expect(fm.rogue).toBeUndefined();
  });

  test("a duplicate key keeps the LAST value — so a smuggled second `agent:` wins", () => {
    const fm = parseFrontmatter("---\nagent: notewright\nagent: something-else\n---\n");
    expect(fm.agent).toBe("something-else");
    // Which is precisely why gate (a) compares the PARSED value against the agent file's name rather
    // than grepping the text for the string it expects to find.
  });

  test("a valueless key is recorded as an empty string, not dropped", () => {
    const fm = parseFrontmatter("---\nbackground:\nname: notewright\n---\n");
    expect(fm.background).toBe("");
    expect(fm.background).not.toBe("false");   // the gate still reddens
    expect(Object.keys(fm)).toContain("background");  // and the key-set check still sees it
  });

  test("trailing whitespace on a value is trimmed", () => {
    expect(parseFrontmatter("---\nbackground: false   \n---\n").background).toBe("false");
  });

  test("valid YAML of the WRONG SHAPE is caught by the key-set check, not by parsing", () => {
    // Parses perfectly; every key is wrong. This is the case a "does it parse?" check waves through.
    const wrong = "---\nfoo: bar\nbaz: qux\n---\n";
    expect(parseFrontmatter(wrong)).toEqual({ foo: "bar", baz: "qux" });
    expect(strayKeys(wrong, AGENT_KEYS).sort()).toEqual(["baz", "foo"]);
  });

  test("a bracketed value becomes string[] — which is why gate (a) type-checks before comparing", () => {
    const fm = parseFrontmatter("---\nagent: [notewright, other]\n---\n");
    expect(Array.isArray(fm.agent)).toBe(true);
    expect(typeof fm.agent).not.toBe("string");
  });
});
