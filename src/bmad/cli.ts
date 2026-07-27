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
import { defaultBmadDeps, type BmadDeps } from "./deps";
import { runBmadDeploy } from "./deploy";
import { runBmadInstall } from "./install";
import { ManifestError } from "./manifest";
import { runBmadUpdate } from "./update";

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
  verify            (coming — Story 2.6)

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
 * `ManifestError` is caught HERE, once, rather than in each command: it is the family's one fail-loud
 * class (a missing/malformed estate file, an unknown `--repos` name, a bad `--set` token), and every
 * subcommand raises it from the same load-and-select step. Anything else re-throws — an unexpected fault
 * must surface, never be flattened into an exit code.
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
        // 2.6 adds: verify: () => runBmadVerify(rest, deps)   — its own module (BM-10)
      },
      onUnknown,
    );
  } catch (err) {
    if (err instanceof ManifestError) {
      deps.report.log(`✗ ${err.message}`);
      return 1;
    }
    throw err;
  }
}
