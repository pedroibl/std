// `std bmad` — the family router (Story 2.2, AC1/AC7; BM-1).
//
// REGISTRATION HOME (BM-1, and the one thing this story is easiest to get wrong): `bmad` is a BUILT-IN
// std command, wired into `src/cli/main.ts:runMain` beside the `cn`/`dashkit` blocks. It is NOT a
// `src/cli/dispatch.ts` entry. `dispatch.ts` is the generic Tier-1 engine that shells a CONSUMER's
// `Step[]` from a `Manifest` and branches on `kind`/`verdict`; `bmad-manager` is std's OWN logic, and the
// spine's dependency graph marks that edge `cmds -.->|MUST NOT| dispatch`. The epic's DoD and NFR-4 both
// list `dispatch` as a sanctioned reuse target for this family — that wording is superseded; the spine
// wins. (`cn`/`dashkit` are not in `dispatch.ts` either, and there is no `edge` command at all.)
//
// NO COMMANDER, NO NEW DEPENDENCY: `package.json` declares zero runtime deps, and the family parses argv
// with `core/args` (`hasFlag`/`flagValue`/`dispatchAsync`). The spine's Stack table listed Commander as
// "verify at scaffold" — this story is that scaffold, and the verification says the existing hand-rolled
// family already provides the wiring.
//
// EXIT CONTRACT (BM-1, matching the `cn`/`dashkit` family): 0 ok/skip · 1 fail-loud · 2 usage.
//
// LATER STORIES EXTEND THE HANDLER MAP HERE — they do NOT re-add the `main.ts` block. 2.6 adds `verify`
// as its own module (BM-10); it belongs in the map below and nowhere else.

import { dispatchAsync } from "../core/index";
import { BmadError, defaultBmadDeps, type BmadDeps } from "./deps";
import { runBmadDeploy } from "./deploy";
import { runBmadInstall } from "./install";
import { ManifestError } from "./manifest";
// A re-export does NOT bind the symbol in the re-exporting module's scope, so calling `parseBmadOpts`
// in the handler map below needs this explicit import even though line 31 re-exports the same name.
import { parseBmadOpts } from "./opts";
import { runBmadUpdate } from "./update";
import { runBmadVerify } from "./verify";

// The flag framework's canonical home is `./opts` (splitting it out of this file is what keeps the
// slice acyclic — see that module's header). Re-exported here so `bmad/cli`'s declared surface holds;
// new code should import from `./opts` directly.
export { DEFAULT_SKILLS, parseBmadOpts, type BmadOpts } from "./opts";

/** `std bmad` usage. Hand-maintained, like the top-level `HELP` — keep it in sync when a command lands. */
export const BMAD_USAGE = `std bmad — manage the BMAD estate

usage: std bmad <subcommand> [options]

subcommands:
  install           install the loop-family skills across the estate
  update            update the installed modules across the estate
  deploy            compose and deploy the estate's leg across the Manifest
  verify            prove both Surfaces are byte-faithful to source (read-only, never mutates)

safety flags:
  --apply           actually execute the plan. WITHOUT IT NOTHING MUTATES (dry-run is the default)
  --push            push after committing. Separate from --apply and never implied by it
  --force-track     stage a repo whose .claude is gitignored (manual, never routine)

selectors:
  --repos a,b       only these repos (by name; default is the Manifest minus source-only entries)
  --tools a,b       only these tools
  --set m.k=v       repeatable module setting, passed through to bmad
  --skills a,b      additional skills, ADDED to the loop-family default

output:
  --json            emit the machine-readable ledger; it is then the only thing on stdout

The estate Manifest is caller-local: $XDG_CONFIG_HOME/std/estate.toml (see estate.example.toml).`;

/**
 * Route `std bmad <subcommand>` (AC1/AC7).
 *
 * `deps` defaults to {@link defaultBmadDeps} so the `main.ts` callsite stays a one-liner and `MainDeps`
 * needs no new field; tests pass a fake.
 *
 * Unknown or missing subcommand ⇒ usage on stderr, exit **2** — never 0 (which would report success for
 * a command that did nothing) and never 1 (which would read as a real fault).
 *
 * `ManifestError` and `BmadError` are caught HERE, once, rather than in each command. They are the
 * family's two fail-loud classes and they are deliberately separate: `ManifestError` means the CALLER's
 * estate.toml or selectors are wrong (missing/malformed file, unknown `--repos`, bad `--set`), while
 * `BmadError` (2.3) means a WHOLE-RUN precondition failed — the shipped estate module is incomplete, or
 * `--skills` named something illegal. Both exit 1; both are raised before any repo is touched, which is
 * the only altitude at which aborting the entire run is the right answer. A per-repo fault never travels
 * this way — it becomes that repo's `status:'failed'` row and the batch continues (FR-15).
 *
 * Anything else re-throws — an unexpected fault must surface, never be flattened into an exit code.
 */
export async function runBmad(argv: string[], deps: BmadDeps = defaultBmadDeps()): Promise<number> {
  const [sub, ...rest] = argv;

  const onUnknown = (name: string): number => {
    // Usage goes to stderr via the seam's `log`, so stdout stays clean for `--json` consumers.
    deps.report.log(name === "" ? BMAD_USAGE : `std bmad: unknown subcommand '${name}'\n\n${BMAD_USAGE}`);
    return 2;
  };

  try {
    return await dispatchAsync(
      sub ?? "",
      {
        install: () => runBmadInstall(rest, deps),
        update: () => runBmadUpdate(rest, deps),
        deploy: () => runBmadDeploy(rest, deps),
        // `verify` is the one handler that takes parsed opts rather than raw argv (2.6). It reads no
        // `--apply`, so its option type is a deliberate SUBSET of `BmadOpts` that has no such field —
        // and a `BmadOpts` satisfies it structurally, so nothing is cast. The raw `rest` still goes
        // through for the render-only `--json` read.
        verify: () => runBmadVerify(parseBmadOpts(rest), rest, deps),
      },
      onUnknown,
    );
  } catch (err) {
    if (err instanceof ManifestError || err instanceof BmadError) {
      deps.report.log(`✗ ${err.message}`);
      return 1;
    }
    throw err;
  }
}
