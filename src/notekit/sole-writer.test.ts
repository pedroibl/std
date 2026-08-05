// Story 2.2 AC #3 — THE SOLE-WRITER GATE: exactly one file in the notekit slice may call a filesystem
// mutation API, and it may call one exactly once.
//
// ⚠ A TEST, NOT A SEVENTH `check:*` SCRIPT, and that is a decision rather than a shortcut. The estate's
// four-move gate template (checker in `scripts/`, a `.test.ts`, a `package.json` entry, a CI step) is
// for REPO-WIDE invariants — all six shipped gates scan `src/**` or the whole tree. "Only one file in
// THIS SLICE may write" is slice-scoped, and `bun test` is already the merge bar, so it bites exactly as
// hard here without growing the shared gate set for one slice. Same call Story 2.1 made, same reason.
//
// ⚠ IT IS NOT NAMED `core-*`, deliberately: `check:core-purity` globs `src/notekit/core-*.ts`, and this
// file reads the filesystem.
//
// ⚠ AND IT STAYS HERE — the #83 review asked for it to be folded into `src/cli/notekit-write.test.ts`
// on the colocation rule (tests beside code as `*.test.ts`, NFR5/D6). DECLINED, on a census the review
// did not run. `src/**` holds FOUR `*.test.ts` with no adjacent module, and all four are the same
// shape — a slice-wide acceptance or fitness suite sitting at the ROOT of what it covers:
//
//   src/bmad/cli-dryrun.test.ts          the `std bmad` surface + the dry-run safety contract
//   src/bmad/dual-surface-proof.test.ts  the Epic-0 dual-Surface render proof (shells the real binary)
//   src/notekit/notewright-dispatch.test.ts  Story 2.3's dispatch-determinism gate
//   this file                            Story 2.2's sole-writer gate
//
// So this is the fourth instance of a settled convention, not a lone exception with an excuse attached
// — and `notewright-dispatch.test.ts` landed AFTER the review was written, which is why the review
// could not see the pattern. The convention is asserted below rather than claimed here.
//
// The move would also cost what the rule exists to buy. Colocation is for DISCOVERABILITY: put the test
// where a reader looks for it. A reader looking for "what stops a second writer appearing in this
// slice" looks at the slice root, not four hundred lines into the unit-test file of the one module the
// gate EXEMPTS. Folding it in would also relabel a slice property as a property of `notekit-write.ts`,
// which is the one file whose behaviour it is NOT about.
//
// The third option — promoting it to a seventh `check:*` gate (`scripts/check-sole-writer.ts` + a
// `package.json` entry + a CI step) — was reconsidered and re-declined for Story 2.2's original reason,
// now checkable: all six shipped gates scan `src/**` or the whole tree, and this one is scoped to a
// single slice. A shared gate set that grows a script per slice stops being a set of repo invariants.
//
// ⚠ THE SCAN NEVER INCLUDES THIS FILE. It necessarily carries all thirty banned names as its own list,
// so a self-scan would be permanently red — or, if the list were moved into a string to dodge that,
// permanently green under the masker. Vacuous either way. The glob excludes every `*.test.ts`.

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripStringsAndComments } from "../../scripts/lib/specifiers";

/** A banned write CALL found in masked source. */
type Hit = { token: string; line: number };

/**
 * THE BANNED SET — Story 2.1's closed set PLUS this story's additions, as ONE set. Thirty names in four
 * groups: 11 + 8 + 1 + 10 = 30.
 *
 * ⚠ IT IS A UNION, NOT A CENSUS. "Derive it from what the tree contains today" is the WRONG rule for a
 * forward-looking coverage gate: this gate's whole job is to cover the files Stories 2.3–2.6 have not
 * written yet, and a `writeFile(…)` from `node:fs/promises` in a 2.5 module would walk straight through
 * a present-tense-derived list. A census tells you what is already here; 2.1's closed set tells you what
 * a dev might REACH FOR. The list must never shrink below 2.1's.
 */
const BANNED_SYNC_FS = [
  "writeFileSync",
  "appendFileSync",
  "renameSync",
  "rmSync",
  "unlinkSync",
  "mkdirSync",
  "copyFileSync",
  "cpSync",
  "symlinkSync",
  "truncateSync",
  "openSync",
] as const;

const BANNED_ASYNC_FS = [
  "writeFile",
  "appendFile",
  "rename",
  "rm",
  "unlink",
  "mkdir",
  "cp",
  "createWriteStream",
] as const;

const BANNED_BUN = ["Bun.write"] as const;

const BANNED_ESTATE = [
  "atomicWrite",
  "ensureDir",
  "saveJson",
  "stageWrite",
  "commitRename",
  "writeIfAbsent",
  "appendIfMissing",
  "appendAudit",
  "appendJsonlEvent",
  "safeWrite",
] as const;

const BANNED: readonly string[] = [
  ...BANNED_SYNC_FS,
  ...BANNED_ASYNC_FS,
  ...BANNED_BUN,
  ...BANNED_ESTATE,
];

/**
 * THREE TOKENS ARE DELIBERATELY NOT BANNED. Recorded so nobody "fixes" the list by adding them:
 *
 *   `truncate`  — A FALSE POSITIVE, NOT A WRITE. It is this codebase's pure string helper
 *                 (`src/core/text.ts`), and `src/` contains no `node:fs` import of that name at all.
 *                 Banning it would flag its own definition and every caller. ⚠ `truncateSync` (the
 *                 `node:fs` one) IS banned — different names, and only one of them touches a disk.
 *   `chmodSync` / `utimesSync`
 *               — METADATA mutations, not content writes. The invariant is about NOTE BYTES; widening
 *                 it to metadata would make this story's own row-8 permission fixture illegal.
 *
 * ⚠ AND FOUR BANNED NAMES CAN FALSE-POSITIVE ON A NON-FS CALL — the answer is NEVER to delete them.
 * `openSync` is also the READ form (`openSync(p, "r")`); `rm`, `cp`, `mkdir` and `rename` are generic
 * enough to collide with a local helper (`cp` is already a `node:child_process` alias elsewhere in the
 * estate). All are absent from this scan set today. If one ever fires on a genuine non-write, NARROW
 * THE MATCHER (e.g. require the `node:fs` import that binds the name) or name the specific site as
 * permitted with a stated reason — never drop the token, which opens a real hole for the mutating form.
 */
const DELIBERATELY_NOT_BANNED = ["truncate", "chmodSync", "utimesSync"] as const;

function escapeForRegExp(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every banned write CALL in `src`, with its line. PURE — it takes source text, so the fault injection
 * can feed it synthetic strings, exactly as `scanConsumerIds(src, names)` is exported for that purpose.
 *
 * ⚠ IT MATCHES CALLS, NOT IDENTIFIERS, and both halves of that matter:
 *   - the prescribed writer opens with `import { atomicWrite, readIfExists } from "../fsx";`, so a
 *     bare-identifier scan finds TWO `atomicWrite` in a file this gate says must have exactly one —
 *     following the story verbatim would turn its own gate red. An import declares INTENT to call; what
 *     is counted is write SITES.
 *   - `check-no-consumer-ids`'s tokenizer cannot be cloned verbatim: its `isTokenChar` includes `.`, so
 *     it reads `fsx.atomicWrite(…)` as the single token `fsx.atomicWrite` and finds NOTHING. A namespace
 *     import would silently defeat the gate. Clone that file's STRUCTURE, not its tokenizer.
 *
 * ⚠ MASKED WITH `stripStringsAndComments`. This bans CODE tokens, so BOTH strings and comments are
 * masked — the `check-dep-root` choice, and the OPPOSITE of `check-no-consumer-ids`, whose targets live
 * inside string literals. Getting it backwards makes the gate a false-positive machine: the estate
 * already carries `appendFileSync(join(OBS_DIR, file), …)` as literal text INSIDE a comment.
 *
 * ⚠ IT IS A CALL-FORM MATCHER, NOT A TYPE-AWARE ANALYSIS, and its residual escapes are an accepted
 * static limit rather than holes to close by dropping tokens: a renamed import binding
 * (`import { atomicWrite as w }; w(p, c)`), a local alias (`const w = atomicWrite; w(…)`),
 * bracket/`Reflect` dispatch (`fs['writeFileSync'](…)`), and any write in a file outside the runtime
 * glob. Say so rather than implying total coverage.
 */
export function scanWriteCalls(src: string, banned: readonly string[] = BANNED): Hit[] {
  const clean = stripStringsAndComments(src);
  const hits: Hit[] = [];
  for (const token of banned) {
    const escaped = escapeForRegExp(token);
    // The bare call form covers the member form too (`.` is a word boundary), but the member
    // alternative is stated explicitly because AC #3 pins the matcher and a whitespace-bearing
    // `fsx . atomicWrite (` should not depend on that coincidence.
    const re = new RegExp(`(?:\\b${escaped}|\\.\\s*${escaped})\\s*\\(`, "g");
    for (const m of clean.matchAll(re)) {
      hits.push({ token, line: clean.slice(0, m.index).split("\n").length });
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.token.localeCompare(b.token));
}

/**
 * ⚠ THE ROOT IS RESOLVED FROM `import.meta.dir`, NEVER THE PROCESS CWD. `new Bun.Glob(...).scan(".")`
 * is cwd-relative, so the same test silently passes over an EMPTY SET when run from anywhere but the
 * repo root. The non-empty + contains-the-writer assertions below are the backstop; this is the fix.
 */
const ROOT = join(import.meta.dir, "..", "..");

/**
 * ⚠ GLOBBED AT RUN TIME, NEVER A HARDCODED FILE LIST. A literal list would silently stop covering the
 * files Stories 2.3–2.6 add, and a coverage gate that shrinks as the slice grows is not a gate.
 *
 * ⚠ THE EXCLUSION IS `*.test.ts` AND NOTHING ELSE — and a suffix filter is NOT a "test code" filter.
 * `src/cli/vault-fixture.ts` is 100% test support and writes with raw `mkdirSync`/`writeFileSync`; it
 * would sail past a suffix filter. It is not in this set today, but `src/notekit/edge/dom-stub.support.ts`
 * IS — and the moment a support file inside the set needs to write, the gate goes red and must be handled
 * by NAMING IT in a permitted set, never by widening the suffix pattern. Widening the pattern is how this
 * gate would quietly stop covering the slice.
 */
async function scanSet(): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of ["src/notekit/**/*.ts", "src/cli/notekit-*.ts"]) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: ROOT })) {
      if (file.endsWith(".test.ts")) continue;
      files.push(file.split("\\").join("/"));
    }
  }
  return files.sort();
}

/** THE one permitted write site. */
const PERMITTED = "src/cli/notekit-write.ts";

describe("the banned set is the union, and it is closed", () => {
  test("thirty names in four groups — 11 + 8 + 1 + 10, no duplicates", () => {
    expect(BANNED_SYNC_FS).toHaveLength(11);
    expect(BANNED_ASYNC_FS).toHaveLength(8);
    expect(BANNED_BUN).toHaveLength(1);
    expect(BANNED_ESTATE).toHaveLength(10);
    expect(BANNED).toHaveLength(30);
    expect(new Set(BANNED).size).toBe(30);
  });

  test("it is a SUPERSET of Story 2.1's sixteen — this list may never shrink below it", () => {
    // 2.1's closed set, restated so a later edit that drops one of them fails here rather than in a
    // review. (2.1 asserts its own sixteen in `notekit-read.test.ts`; this is the containment claim.)
    const STORY_2_1 = [
      "Bun.write", "writeFileSync", "appendFileSync", "rmSync", "unlinkSync", "mkdirSync",
      "renameSync", "atomicWrite", "ensureDir", "saveJson", "writeFile", "appendFile",
      "createWriteStream", "copyFileSync", "cpSync", "truncateSync",
    ];
    expect(STORY_2_1).toHaveLength(16);
    for (const token of STORY_2_1) expect(BANNED).toContain(token);
  });

  test("the three stated exclusions are NOT in the list, and their reasons are checkable", () => {
    for (const token of DELIBERATELY_NOT_BANNED) expect(BANNED).not.toContain(token);
    // `truncate` is a pure string helper, and `src/` binds no `node:fs` name of it — the load-bearing
    // half of the exclusion, re-derived here rather than quoted from the story.
    const text = readFileSync(join(ROOT, "src", "core", "text.ts"), "utf-8");
    expect(text).toContain("export function truncate");
    // …while `truncateSync`, the one that does touch a disk, IS banned.
    expect(BANNED).toContain("truncateSync");
  });
});

describe("this suite's own location is a convention, not an exception (#83 review, declined)", () => {
  /** Every `*.test.ts` under `src/` with no `<name>.ts` beside it. */
  async function orphanSuites(): Promise<string[]> {
    const found: string[] = [];
    for await (const file of new Bun.Glob("src/**/*.test.ts").scan({ cwd: ROOT })) {
      const path = file.split("\\").join("/");
      const module = `${path.slice(0, -".test.ts".length)}.ts`;
      if (!(await Bun.file(join(ROOT, module)).exists())) found.push(path);
    }
    return found.sort();
  }

  test("this file is NOT the only slice-property suite — the review's premise was that it was", async () => {
    const orphans = await orphanSuites();
    expect(orphans).toContain("src/notekit/sole-writer.test.ts");
    // ⚠ ASSERTED AS "MORE THAN ONE", NOT AS THE EXACT LIST. The claim being defended is that the shape
    // is a convention; pinning the exact four would go red the day an unrelated slice adds or retires
    // one, and someone would then "fix" it by editing this line rather than by re-reading the argument.
    expect(orphans.length).toBeGreaterThan(1);
  });

  test("the siblings named in the header still exist, so the census is not stale prose", async () => {
    const orphans = await orphanSuites();
    // If one of these genuinely moves, this goes red and the header above must be re-censused — which
    // is the point. A comment that cannot go stale silently is worth more than a longer comment.
    for (const sibling of [
      "src/bmad/cli-dryrun.test.ts",
      "src/bmad/dual-surface-proof.test.ts",
      "src/notekit/notewright-dispatch.test.ts",
    ]) {
      expect(orphans).toContain(sibling);
    }
  });

  test("…and the module it was asked to move into is a real file with its own adjacent module", async () => {
    // The alternative home is not imaginary — the decline is a judgement between two real options.
    expect(await Bun.file(join(ROOT, "src", "cli", "notekit-write.test.ts")).exists()).toBe(true);
    expect(await Bun.file(join(ROOT, PERMITTED)).exists()).toBe(true);
  });
});

describe("scanWriteCalls — the pure scanner, fault-injected with synthetic source", () => {
  test("a call is a hit", () => {
    expect(scanWriteCalls(`const x = atomicWrite(p, c);\n`).map((h) => h.token)).toEqual(["atomicWrite"]);
  });

  test("an IMPORT LINE alone is NOT a hit — the story's own writer opens with one", () => {
    expect(scanWriteCalls(`import { atomicWrite, readIfExists } from "../fsx";\n`)).toEqual([]);
    // …and the same identifier followed by `(` on the next line IS.
    expect(
      scanWriteCalls(`import { atomicWrite } from "../fsx";\natomicWrite(p, c);\n`),
    ).toHaveLength(1);
  });

  test("the NAMESPACE form is a hit — the trap a cloned scanConsumerIds tokenizer would miss", () => {
    expect(scanWriteCalls(`fsx.atomicWrite(p, c);\n`)).toHaveLength(1);
    expect(scanWriteCalls(`fsx . atomicWrite (p, c);\n`)).toHaveLength(1);
    expect(scanWriteCalls(`await Bun.write(p, c);\n`).map((h) => h.token)).toEqual(["Bun.write"]);
  });

  test("MASKED CONTEXTS are green — that is what the masker is for", () => {
    expect(scanWriteCalls(`// atomicWrite(p, c) is mentioned, never called\n`)).toEqual([]);
    expect(scanWriteCalls(`/* writeFileSync(a, b) in a block comment */\n`)).toEqual([]);
    expect(scanWriteCalls(`const help = "run writeFileSync(x) yourself";\n`)).toEqual([]);
    // The estate really carries this shape: a write call quoted inside comment prose.
    expect(scanWriteCalls(`// appendFileSync(join(OBS_DIR, file), line);\n`)).toEqual([]);
  });

  test("every one of the thirty is genuinely matchable — no dead entry in the list", () => {
    for (const token of BANNED) {
      expect({ token, hits: scanWriteCalls(`${token}(a, b);\n`).length }).toEqual({ token, hits: 1 });
    }
  });

  test("the reported LINE is the real one, so a finding is actionable", () => {
    expect(scanWriteCalls(`a\nb\nmkdirSync(d);\n`)[0]!.line).toBe(3);
  });
});

describe("the real tree: exactly one writer, exactly one call", () => {
  test("the scan set is non-empty and contains the writer — a green gate over nothing is not a gate", async () => {
    const files = await scanSet();
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(PERMITTED);
    expect(files).toContain("src/notekit/core-fence.ts");
    expect(files.filter((f) => f.endsWith(".test.ts"))).toEqual([]);
  });

  test("EXACTLY ONE file carries a banned write call, and it is the sanctioned writer", async () => {
    const offenders: Record<string, Hit[]> = {};
    for (const file of await scanSet()) {
      const hits = scanWriteCalls(readFileSync(join(ROOT, file), "utf-8"));
      if (hits.length > 0) offenders[file] = hits;
    }
    expect(Object.keys(offenders).sort()).toEqual([PERMITTED]);
  });

  test("…and it carries EXACTLY ONE — *exactly*, never *at most*", async () => {
    // An upper bound would pass on ZERO, i.e. on a writer that was never wired. The baseline this
    // moves from is 0 across all of `src/notekit/**` and `src/cli/notekit-deploy.ts`, so "exactly one"
    // is the only assertion that distinguishes "wired" from "absent".
    const hits = scanWriteCalls(readFileSync(join(ROOT, PERMITTED), "utf-8"));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.token).toBe("atomicWrite");
  });

  test("the pre-existing exception is NAMED, not hidden: notekit deploy writes through a SHARED engine", async () => {
    // `notekit deploy` writes `<vault>/Scripts/notekit.js` — AD-5 generated build output, not a note —
    // and it does so through `src/cli/edge-deploy.ts`, a module cn and dashkit also own. That file is
    // OUTSIDE this glob by construction, and `notekit-deploy.ts` itself carries zero write tokens, so
    // it passes with no exemption. The invariant is about NOTE bytes; an unscoped "notekit never writes
    // anything" would have been false the day it was written.
    expect(scanWriteCalls(readFileSync(join(ROOT, "src", "cli", "notekit-deploy.ts"), "utf-8"))).toEqual([]);
    expect(await scanSet()).not.toContain("src/cli/edge-deploy.ts");
    expect(scanWriteCalls(readFileSync(join(ROOT, "src", "cli", "edge-deploy.ts"), "utf-8")).length).toBeGreaterThan(0);
  });

  test("COUNTERFACTUAL, BOTH DIRECTIONS, against the real sources", async () => {
    // Run as a test rather than recorded as a claim — and against the REAL file text, so it is the
    // shipped source that is proven to move the verdict, not a synthetic stand-in.
    const writer = readFileSync(join(ROOT, PERMITTED), "utf-8");
    const pureFile = readFileSync(join(ROOT, "src", "notekit", "core-fence.ts"), "utf-8");

    // UP: a second write call planted in a pure `core-*` file → the file set is no longer just the
    // writer, so the exactly-one-file assertion goes red.
    expect(scanWriteCalls(`${pureFile}\nexport function leak(p: string) { atomicWrite(p, ""); }\n`)).toHaveLength(1);
    expect(scanWriteCalls(pureFile)).toEqual([]); // …and the real file is clean

    // DOWN: the real `atomicWrite` call deleted → ZERO, which is ALSO red, because the assertion is
    // *exactly one*. An upper-bound-only gate would stay green over an unwired writer.
    const gutted = writer.replace("else atomicWrite(plan.notePath, next);", "else { /* removed */ }");
    expect(gutted).not.toBe(writer); // the surgery really hit the line it names
    expect(scanWriteCalls(gutted)).toHaveLength(0);
    expect(scanWriteCalls(writer)).toHaveLength(1);
  });
});
