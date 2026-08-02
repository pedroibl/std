// `std bmad deploy` — estate-wide module propagation (Story 2.2 landed the SCAFFOLD; Story 2.7 REPLACED
// its body with the real command).
//
// THE DELIVERABLE IS THAT THIS FILE IS ALMOST EMPTY, and that is the whole point of FR-17, which calls
// `deploy` "a convenience composition of FR-9/11/12/13/14". Read against what 2.1–2.6 actually shipped,
// the composition is TOTAL: `selectRepos(manifest, opts)` with no `--repos` already returns exactly the
// default repo set (2.1 AC5), so `std bmad update --apply` already updates the whole estate. `deploy`
// therefore adds no rule, no per-repo step, no shelled argv and no ledger field over `update` — it adds
// exactly ONE thing, a named estate-wide intent that REFUSES to be narrowed.
//
// So `runBmadDeploy` delegates to `runBmadUpdate` and contains nothing else. A convenience command that
// admits it is thin is far better than one that grows a private per-repo flow to look substantial: a
// fourth near-copy of that flow, drifting away from `install`/`update`, is precisely the failure FR-17's
// "composition" wording exists to prevent (BM-4 — the family shares ONE filter chain).
//
// STRUCTURALLY ENFORCED, NOT PROMISED. `deploy.test.ts` runs a grep gate over this file that fails on any
// per-repo-flow token appearing here, COMMENTS INCLUDED, plus a regression guard asserting the argv this
// command shells is byte-identical to `update`'s for the same estate and flags. If you are editing this
// header, re-run that gate afterwards — a well-meant sentence naming a banned symbol turns it red.
//
// D4 identity-free: no repo, path or binary literal — everything arrives resolved on `deps`.

import { hasFlag } from "../core/index";
import type { BmadDeps } from "./deps";
import { parseBmadOpts } from "./opts";
import { runBmadUpdate } from "./update";

/**
 * Run `std bmad deploy [flags]` (FR-17). Dry-run by default; `--apply` authorizes mutation and `--push`
 * is separate and never implied — all three inherited unchanged, because this command performs none of
 * them itself. Returns the family exit code: 0 ok/skip, 1 any repo failed, 2 a usage fault (BM-1).
 *
 * Do NOT grow install / git / verify machinery in here. Everything this command appears to do is done by
 * `runBmadUpdate`, and the gates named in this file's header exist to keep it that way.
 */
export async function runBmadDeploy(argv: string[], deps: BmadDeps): Promise<number> {
  // AC1 — deploy is estate-wide BY CONSTRUCTION, and it refuses to be narrowed, LOUDLY, before any repo
  // is read or touched. Silently ignoring `--repos loom` on the highest-blast-radius command in the
  // family turns an operator's scoping intent into a nine-repo mutation; silently HONORING it would mean
  // deploy had stopped being estate-wide. Neither is acceptable, so the flag is a usage fault (exit 2).
  //
  // Three guards, each covering the others' blind spot (verified against `src/core/args.ts`):
  //   1. the PARSER's own verdict — `flagValue` accepts both `--repos v` and `--repos=v`, so every valued
  //      spelling the selector layer recognises lands here, including one added after this was written.
  //      The two literal guards below cannot know about a spelling `parseSelectors` learns later.
  //   2. `hasFlag` is `argv.includes("--repos")` — BARE form only. It catches a trailing `--repos` with
  //      no value, where `flagValue` reads past the end of the argv and guard 1 sees `undefined`.
  //   3. `--repos=` (empty equals) makes `flagValue` return `""`, which `parseSelectors` normalises away
  //      to absent; `"--repos="` is also not equal to `"--repos"`, so guard 2 misses it too. Without
  //      this third guard that single spelling would deploy across the whole estate in silence.
  const reposRequested =
    parseBmadOpts(argv).repos !== undefined ||
    hasFlag(argv, "repos") ||
    argv.some((a) => a.startsWith("--repos="));
  if (reposRequested) {
    deps.report.log(
      "✗ deploy: --repos is not accepted — deploy always targets the default repo set. " +
        "Use 'std bmad update --repos <sel>' to target a subset.",
    );
    return 2; // family usage code (BM-1)
  }

  // The whole command. `update` parses this same argv itself, and with `--repos` refused above it can
  // only resolve the default set (2.1 AC5 — the Manifest minus `role:'source-only'`), which is exactly
  // deploy's contract. Passing the argv through UNMODIFIED is what makes the byte-identity gate mean
  // something: there is no seam here where a deploy-specific flag could be injected or dropped.
  //
  // It is also what keeps the inherited data-loss hazard closed. `update` names, in the argv it shells,
  // the set of built-in modules PROBED as present on each repo's disk, because the installer treats that
  // set as the set that should EXIST — a hardcoded set naming fewer modules than a repo carries DELETES
  // the rest. A deploy that authored its own invocation would have to re-derive that probe, and getting
  // it wrong here would delete a built-in module from every repo in the estate at once.
  return await runBmadUpdate(argv, deps);
}
