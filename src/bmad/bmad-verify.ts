// The dual-surface verification ENGINE (Story 2.6, FR-16/FR-10/FR-15; BM-10).
//
// WHAT THIS PROVES, and the three comparisons it is built out of:
//   Parity        `.claude/skills` vs `.agents/skills` — the two Surfaces render byte-identically.
//   Faithfulness  `<module>/skills/<s>` vs `.claude/skills/<s>` — each SELECTED skill matches its source.
//   set Parity    the two Surfaces hold the same top-level skill SET, and divergences are NAMED.
//
// THE HEADLINE INVARIANT — never a whole-repo comparison; the scope is the skill trees (BM-10). Every
// operand this module hands `diff` is built from {@link SURFACES} or from `<moduleRoot>/skills/<s>`, and
// there is no other compared root. That is not a convention, it is the mechanism: `bmad install`
// REGENERATES `_bmad/_config`, `_bmad/config.toml`, `_bmad/_config/bmad-help.csv` and `_bmad/scripts/`
// on every run (FR-10), so a repo-root comparison would report by-design regeneration as drift and a
// whole-repo checksum would do the same. All four of those paths live under `_bmad/`, which is outside
// all three compared roots — SO THIS FILE CARRIES NO EXCLUSION CODE AT ALL. Scoping IS the exclusion.
//
// DO NOT "FIX" THAT WITH `diff -x`. `diff -x` matches BASENAMES, and a real estate carries in-skill
// `scripts/` directories holding actual payload (measured on the live estate at authoring time: 14 under
// `.claude/skills`, 11 under `.agents/skills`). `-x scripts` would silently drop every one of them from
// Parity and report a clean run having compared almost nothing — a FALSE GREEN, which for a verification
// tool is strictly worse than a crash. `bmad-verify.test.ts` pins that case.
//
// READ-ONLY BY CONSTRUCTION (NFR-5). This module issues `diff` (an external read), `deps.fs.exists` and
// `deps.fs.listDirs`. It never touches a mutating member of the seam and takes no `--apply` gate, because
// it has nothing to gate. Adding a write here is the one change that breaks the command's whole contract.
//
// BM-7: `diff` shells through the injected `deps.exec`, never a bare `spawnCapture` import — and as an
// ARGV ARRAY, never an authored shell string (BM-15). NFR-4: nothing from `../proc`/`../git`/`../fsx` is
// imported here; every effect arrives through `deps`.
//
// D1: a Bun edge, so `node:path` is legal. D4: no repo, module or machine path literal — `repoRoot`
// arrives from the Manifest entry and `moduleRoot` from `deps.estateModulePath`.
//
// LAYERING (read before adding an import): this module sits BELOW `pipeline.ts`, which imports
// {@link verifyRepo} for its BM-4 verify filter. It must therefore import nothing at or above the
// pipeline — no `./batch`, no `./pipeline`, no `./cli`, or `check:dep-root` finds a cycle. The command
// wrapper that DOES need `batchExit` lives one layer up in `verify.ts`.

import { join } from "node:path";

import { GLYPH, type Severity } from "../core/severity";
import { emptyCounts, statusLine } from "../core/status";
import type { BmadDeps } from "./deps";

/**
 * The fail-loud class for a verification that could not be PERFORMED — distinct from a verification that
 * was performed and found differences, which is an ordinary finding (see {@link diffTrees}).
 *
 * The `EdgeVerifyError` pattern (`src/cli/edge-verify.ts`): a message-carrying `Error` subclass that sets
 * `this.name`. Deliberately NOT merged with 2.3's `BmadError` (an estate-payload/flag precondition fault)
 * or 2.1's `ManifestError` (the caller's `estate.toml` is wrong) — the three classify different faults and
 * collapsing them would make a broken `diff` read to the operator as a config typo.
 */
export class BmadVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BmadVerifyError";
  }
}

/** One reported divergence. `message` carries `diff`'s own line VERBATIM — never a count, never a boolean. */
export interface VerifyFinding {
  readonly severity: Severity;
  readonly id: string;
  readonly message: string;
}

/**
 * Column width for the id, so messages line up. DERIVED, not guessed: the longest id this module produces
 * under a default run is `faithfulness:` (13) + the longest default-selected skill name
 * `bmad-agent-jhon-the-loop` (24) = 37, rounded to 40. It is not a maximum — `--skills` is additive, and
 * `padEnd` never truncates, so a longer id simply widens its own row rather than losing characters.
 */
const ID_WIDTH = 40;

/**
 * THE TWO SURFACE ROOTS, relative to a repo — and, with `<moduleRoot>/skills/<s>`, the ONLY compared
 * roots that exist (BM-10). Index `0` (`.claude/skills`) is the Faithfulness base: AC2's Parity already
 * proves `.agents` matches `.claude`, so comparing the module against both would prove nothing new.
 *
 * Exported so the test suite can assert every recorded `diff` operand sits under one of these prefixes
 * without re-declaring the pair — a second copy is exactly how a widened operand would go unnoticed.
 */
export const SURFACES = [join(".claude", "skills"), join(".agents", "skills")] as const;

/** A wedged `diff` resolves with code 124 (which lands in the fail-loud branch) instead of hanging a batch. */
const DIFF_TIMEOUT_MS = 30_000;

/**
 * Compare two trees and map `diff`'s exit code THREE ways — the single place `diff` is interpreted.
 *
 *   `0`   identical                    → no findings.
 *   `1`   DIFFERENCES FOUND            → one `error` finding per stdout line. A NORMAL, EXPECTED result.
 *   `≥2`  `diff` itself failed         → fail loud, carrying stderr verbatim.
 *
 * WHY `1` IS NOT AN ERROR, and why a future reader must not "harden" it into a throw: `deps.exec` is
 * `src/proc`'s `spawnCapture`, which NEVER REJECTS — it resolves for a clean exit, a nonzero exit, a
 * timeout (`124`) and a launch failure (`127`) alike. The exit code is therefore the entire signal, and
 * conflating "differences found" with "the command failed" breaks this module in both directions at once:
 * an ordinary mismatch would crash the run instead of reporting the file, and a broken `diff` would be
 * reported as drift.
 *
 * `127` — no `diff` on PATH — lands in the fail-loud branch DELIBERATELY, deviating from std's standing
 * "an absent binary is a SKIP (exit 0)" adapter rule. `diff` is not an optional capability here, it is the
 * entire verification mechanism: a SKIP-0 would report "verify passed" having compared nothing, which is
 * the exact false green this module exists to prevent. Story 2.3 set the identical precedent for `bmad`.
 *
 * `--` terminates option parsing, so an operand can never be re-read as a flag (the `git add --` rule).
 * The operands are absolute paths built by the caller from the compared roots; the separator makes that
 * structural rather than incidental.
 */
async function diffTrees(id: string, a: string, b: string, deps: BmadDeps): Promise<VerifyFinding[]> {
  const r = await deps.exec("diff", ["-rq", "--", a, b], { timeout: DIFF_TIMEOUT_MS });
  if (r.code === 0) return [];
  if (r.code === 1) {
    return r.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      // VERBATIM (FR-15): `Files …/a/SKILL.md and …/b/SKILL.md differ`, `Only in …: g`. The operator's
      // next action is to open that path, and a count or a boolean costs them the fix.
      .map((line) => ({ severity: "error" as Severity, id, message: line.trim() }));
  }
  throw new BmadVerifyError(
    `diff failed (exit ${r.code}) comparing ${a} and ${b}: ${r.stderr.trim() || "(no output)"}`,
  );
}

/**
 * A `--skills` token that is a single directory name — no separators, no `.`/`..`, not empty.
 *
 * THIS IS AN AC1 GUARD, not input hygiene. `opts.skills` is operator-supplied and additive, so a token
 * like `../../etc` would make `join(moduleRoot, "skills", token)` resolve OUTSIDE the compared roots and
 * hand `diff` an operand this module's whole contract says it never produces.
 *
 * `estate-source.ts` has the same predicate inside its private `assertPlainSegment`, and it is NOT shared:
 * that one THROWS a `BmadError` and aborts the entire run, which is right for `install` (it is about to
 * write) and wrong here (verify reports and keeps going, so one bad token must not silence the repos after
 * it). Same rule, deliberately different disposition.
 */
function isPlainSegment(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\]/.test(name);
}

/**
 * Verify ONE repo and return every divergence found (FR-16). Accumulating rather than fail-fast is
 * deliberate: one run should tell an operator everything that is wrong, not the first thing.
 *
 * The order is Surface pre-check → Parity → Faithfulness → set Parity, and the pre-check is load-bearing.
 * Shelling `diff` at a path that does not exist produces exit 2 — which is correctly fail-loud, but with a
 * far worse message than "missing Surface: <path>" and with the rest of the report lost to the throw.
 *
 * Async because `deps.exec` is promise-returning. It composes into 2.3's already-async `runRepoPipeline`
 * with no new cascade, and `batchExit` stays sync.
 */
export async function verifyRepo(
  repoRoot: string,
  skills: readonly string[],
  moduleRoot: string,
  deps: BmadDeps,
): Promise<VerifyFinding[]> {
  const findings: VerifyFinding[] = [];

  // 1. SURFACE PRE-CHECK. Both roots, both reported — an operator with neither Surface wants both names.
  for (const surface of SURFACES) {
    const root = join(repoRoot, surface);
    if (!deps.fs.exists(root)) {
      findings.push({ severity: "error", id: "surface", message: `missing Surface: ${root}` });
    }
  }
  // A missing root makes every comparison below meaningless, so return the named finding rather than
  // pressing on. This is the one early return in this function.
  if (findings.length > 0) return findings;

  // 2. PARITY — the two Surfaces, whole. Scoped to the skill roots, so regenerated `_bmad/*` is invisible.
  findings.push(
    ...(await diffTrees("parity", join(repoRoot, SURFACES[0]), join(repoRoot, SURFACES[1]), deps)),
  );

  // 3. FAITHFULNESS — over the SELECTED skills (BM-12), NEVER `readdir(<moduleRoot>/skills)`.
  //    The on-disk estate carries a third, opt-in skill (`bmad-agent-dev-the-loop`) that a default
  //    install does not render. A readdir loop would compare it against a directory that is absent BY
  //    DESIGN and manufacture a Faithfulness break out of a correct install — the Epic-0 trap already
  //    pinned at `dual-surface-proof.test.ts`. The selected set is the install gate, so it is the
  //    verification gate too.
  for (const skill of skills) {
    if (!isPlainSegment(skill)) {
      findings.push({
        severity: "error",
        id: "skill-name",
        message: `invalid skill name ${JSON.stringify(skill)} — a skill is a single directory name`,
      });
      continue;
    }
    const src = join(moduleRoot, "skills", skill);
    const dst = join(repoRoot, SURFACES[0], skill);
    if (!deps.fs.exists(src)) {
      findings.push({ severity: "error", id: `faithfulness:${skill}`, message: `module skill missing: ${src}` });
      continue;
    }
    if (!deps.fs.exists(dst)) {
      findings.push({
        severity: "error",
        id: `faithfulness:${skill}`,
        message: `skill missing from Surface: ${skill} (expected ${dst})`,
      });
      continue;
    }
    findings.push(...(await diffTrees(`faithfulness:${skill}`, src, dst, deps)));
  }

  // 4. SET PARITY — the `comm -3` semantic, computed in-process (see this story's recorded deviation).
  //    Both listings arrive sorted from `deps.fs.listDirs`. The difference is taken BOTH WAYS: a one-sided
  //    `a \ b` would miss every agents-only skill, which is half the divergences this check exists to name.
  //    `diff -rq` above also reports `Only in …` lines, and that redundancy is intentional — this check
  //    still fires for a skill dir that is EMPTY on one side, which `diff -rq` reports as `Only in` too but
  //    which a content-only comparison could not distinguish from a genuine tree.
  const claudeDirs = deps.fs.listDirs(join(repoRoot, SURFACES[0]));
  const agentsDirs = deps.fs.listDirs(join(repoRoot, SURFACES[1]));
  const inAgents = new Set(agentsDirs);
  const inClaude = new Set(claudeDirs);
  for (const name of claudeDirs.filter((d) => !inAgents.has(d))) {
    findings.push({ severity: "error", id: "set-parity", message: `only in ${SURFACES[0]}: ${name}` });
  }
  for (const name of agentsDirs.filter((d) => !inClaude.has(d))) {
    findings.push({ severity: "error", id: "set-parity", message: `only in ${SURFACES[1]}: ${name}` });
  }

  return findings;
}

/**
 * Render findings + the summary line. PURE — takes findings, returns lines — so the exact printed output
 * is assertable with no repo, no fixture and no stdout.
 *
 * `statusLine` returns `""` for an all-zero tally; suppress the line entirely rather than printing a blank
 * one, so a clean repo produces no noise at all.
 *
 * THE TALLY IS BUILT INSIDE THIS FUNCTION, and it must stay there. A module-level `const counts = …`
 * would ACCUMULATE ACROSS CALLS, so the second repo in a batch would render the first repo's totals — a
 * quietly wrong report, which is the failure mode this whole module exists to prevent.
 */
export function renderVerifyFindings(findings: readonly VerifyFinding[]): string[] {
  const counts = emptyCounts();
  const out: string[] = [];
  for (const f of findings) {
    counts[f.severity] += 1;
    out.push(`${GLYPH[f.severity]} ${f.id.padEnd(ID_WIDTH)} ${f.message}`);
  }
  const summary = statusLine(counts);
  if (summary !== "") {
    out.push("");
    out.push(summary);
  }
  return out;
}
