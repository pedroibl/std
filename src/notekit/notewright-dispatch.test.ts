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
function probeKeySpelling(schemaLine: string, key: string, anchor: string): boolean {
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

/** Every `nk-`-prefixed token in the text. Strict by design: any non-member is a finding. */
function nkTokens(text: string): string[] {
  return [...text.matchAll(/nk-[a-z][a-z0-9-]*/g)].map((m) => m[0]);
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
  const which = Bun.spawnSync({ cmd: ["which", "claude"], stdout: "pipe", stderr: "pipe" });
  const bin = which.stdout.toString().trim();
  if (which.exitCode !== 0 || bin.length === 0) return null;
  const strings = Bun.spawnSync({ cmd: ["strings", bin], stdout: "pipe", stderr: "pipe" });
  if (strings.exitCode !== 0) return null;
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
    for (const evil of ["constructor", "toString", "valueOf"]) {
      const mutated = agentText.replace("tools:", `${evil}: x\ntools:`);
      expect(strayKeys(mutated, AGENT_KEYS)).toEqual([evil]);
    }
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

  test("AC #4d — the apply flag appears nowhere in either file", () => {
    // Same invariant as 2.2's "no default that enables it", one layer up: 2.2 ensures the flag has no
    // default that turns it on; 2.3 ensures the agent surface never types it. The path that AUTHORIZES
    // reaching it is Story 2.4's, named here only to say who owns it.
    const flag = "--" + "apply"; // split so this file's own list does not trip a future whole-tree scan
    expect(agentText).not.toContain(flag);
    expect(skillText).not.toContain(flag);
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

  test("AC #5 — the skill body fails loud on an EMPTY note path, not an unset one", () => {
    // An absent positional substitutes to the empty string, so a body branching on "unset" would describe
    // a state that never occurs — the same silent-default trap 2.1 bans at the flag level, one layer up.
    expect(skillText).toContain("$1");
    expect(skillText.toLowerCase()).toContain("empty");
    expect(skillText.toLowerCase()).toContain("usage:");
  });

  test("AC #5 — the catalog is reached by calling `capabilities`, never restated", () => {
    expect(agentText).toContain("std notekit capabilities --config");
    expect(skillText).toContain("std notekit capabilities --config");
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

describe("notewright dispatch — AC #4c: nothing under src/ or scripts/ moved", () => {
  /**
   * The working-tree allowlist. ⚠ EXTEND, NEVER REPLACE, and never widen to a prefix — Stories 2.4,
   * 2.5, 2.6 and 2.7 each append their own file here (the Epic-2 ruling §7 makes that explicit). A
   * prefix like `src/notekit/` would silently permit every future file in the slice.
   */
  const WORKING_TREE_ALLOWLIST = ["src/notekit/notewright-dispatch.test.ts"];

  test("the only changed path is this test file itself", () => {
    // ⚠ ASSERTED ON THE WORKING TREE, NOT `git diff <base>..HEAD`, which compares committed history and
    // returns empty pre-commit whatever the tree holds — vacuous exactly when it matters.
    //
    // ⚠ AND THE ALLOWLIST IS WHAT LETS THIS GATE REACH ITS PASS STATE. Without it the gate is red by
    // construction from the moment this file exists, and a gate that is always red is neither a pass nor
    // a fail.
    const proc = Bun.spawnSync({
      cmd: ["git", "status", "--porcelain", "--", "src/", "scripts/"],
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const paths = proc.stdout
      .toString()
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => l.slice(3).trim());
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
    const bom = "﻿---\nname: notewright\n---\n";
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
