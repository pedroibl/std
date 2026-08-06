import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CN_PLUGIN_CONTRACT } from "../cn/plugins";
import { HELP, globalReposPath, runMain } from "./main";
import { makeVaultFixture } from "./vault-fixture";
import { stripComments, stripStringsAndComments } from "../../scripts/lib/specifiers";

/** Write a temp repos.ts (a RepoConfig default export) and return its path. */
function tempRepos(body: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "std-main-"));
  const path = join(dir, "repos.ts");
  writeFileSync(path, body);
  return { dir, path };
}

const GOOD = `const config = { entries: { zp: "$HOME/Dev/zsh-planning", mph: "$HOME/Sites/mph" }, reserved: ["std"] };\nexport default config;\n`;

describe("runMain — std alias --install", () => {
  test("generates + deploys repo-nav and _std, exit 0", async () => {
    const { dir, path } = tempRepos(GOOD);
    const zdot = join(dir, "zsh");
    try {
      const lines: string[] = [];
      const code = await runMain(["alias", "--install"], { reposPath: path, zdotdir: zdot, log: (l) => lines.push(l) });
      expect(code).toBe(0);
      expect(existsSync(join(zdot, "functions", "repo-nav.zsh"))).toBe(true);
      expect(existsSync(join(zdot, "completions", "_std"))).toBe(true);
      expect(lines.some((l) => l.includes("repo-nav"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fail-loud registry returns 1 and deploys nothing", async () => {
    const { dir, path } = tempRepos(`export default { entries: { "bad name": "/x" } };\n`);
    const zdot = join(dir, "zsh");
    try {
      const code = await runMain(["alias", "--install"], { reposPath: path, zdotdir: zdot, log: () => {} });
      expect(code).toBe(1);
      expect(existsSync(zdot)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("honors a frozen-name collision declared in the registry", async () => {
    const { dir, path } = tempRepos(
      `export default { entries: { forge: "/x" }, frozen: ["forge"] };\n`,
    );
    try {
      const code = await runMain(["alias", "--install"], { reposPath: path, zdotdir: join(dir, "zsh"), log: () => {} });
      expect(code).toBe(1); // forge collides with the declared frozen name → fail-loud
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing registry returns 1, not a crash", async () => {
    const code = await runMain(["alias", "--install"], { reposPath: "/no/such/repos.ts", log: () => {} });
    expect(code).toBe(1);
  });

  test("`alias` without --install prints usage, exit 2", async () => {
    const lines: string[] = [];
    expect(await runMain(["alias"], { log: (l) => lines.push(l) })).toBe(2);
    expect(lines.join("\n")).toMatch(/usage: std alias --install/);
  });

  test("an unknown command exits 2", async () => {
    expect(await runMain(["bogus"], { log: () => {} })).toBe(2);
  });

  test("-h / --help print usage, exit 0", async () => {
    for (const flag of ["-h", "--help"]) {
      const lines: string[] = [];
      expect(await runMain([flag], { log: (l) => lines.push(l) })).toBe(0);
      expect(lines.join("\n")).toContain("usage: std <command>");
      expect(lines.join("\n")).toContain("alias --install");
    }
  });

  test("no command prints help but signals incomplete invocation (exit 2)", async () => {
    const lines: string[] = [];
    expect(await runMain([], { log: (l) => lines.push(l) })).toBe(2);
    expect(lines.join("\n")).toBe(HELP);
  });
});

describe("cn dispatch + HELP (Story 7.2 — review finding: this branch had zero coverage)", () => {
  test("HELP documents --watch (AC9) — deleting the line shipped green before this", () => {
    expect(HELP).toContain("--watch");
    expect(HELP).toContain("cn deploy");
  });

  test("`cn` delegates to runCnDeploy and returns its exit code", async () => {
    // A missing --vault is the one-shot usage error (2) — proves the delegation, no vault needed.
    expect(await runMain(["cn", "deploy"], { log: () => {} })).toBe(2);
  });

  test("--watch registers the shutdown hook AT THE CALLSITE, and only when resident (AC5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "std-main-cn-"));
    try {
      const vault = makeVaultFixture(join(dir, "vault"), CN_PLUGIN_CONTRACT);
      // A FAKE watcher: this test must never open a real recursive watch — that surface is
      // platform-divergent (FSEvents vs inotify) and this suite runs on Linux in CI.
      let watchCalls = 0;
      const watch = () => (watchCalls++, { close: () => {} });

      // No --watch → nothing goes resident, so no handler is installed.
      let stops = 0;
      expect(
        await runMain(["cn", "deploy", "--vault", vault], {
          log: () => {},
          watch,
          onWatchStart: () => stops++,
        }),
      ).toBe(0);
      expect(stops).toBe(0);

      // --watch → the callsite receives `stop`. Calling it is what a real SIGINT handler does.
      let stop: (() => void) | undefined;
      expect(
        await runMain(["cn", "deploy", "--vault", vault, "--watch"], {
          log: () => {},
          watch,
          onWatchStart: (s) => {
            stop = s;
            s();
          },
        }),
      ).toBe(0);
      expect(typeof stop).toBe("function");
      // Assert the FAKE was actually reached. Without this, deleting `watch: deps.watch` from main.ts
      // stays green while these two cases silently open REAL recursive watchers on src/cn + src/core —
      // the platform-divergent surface this suite must never touch on Linux CI.
      expect(watchCalls).toBe(2); // src/cn + src/core, from the --watch run only
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the DEFAULT shutdown hook is a real SIGINT listener installed by main.ts", async () => {
    // Every other case injects onWatchStart, so the `?? ((stop) => process.on("SIGINT", stop))` default
    // was never exercised — deleting it shipped green. Here nothing is injected: the listener main.ts
    // registers IS the handle, and invoking it is what ctrl-c does.
    const dir = mkdtempSync(join(tmpdir(), "std-main-sigint-"));
    try {
      const vault = makeVaultFixture(join(dir, "vault"), CN_PLUGIN_CONTRACT);
      let sigintWatchCalls = 0;
      const before = process.listeners("SIGINT");
      const p = runMain(["cn", "deploy", "--vault", vault, "--watch"], {
        log: () => {},
        watch: () => (sigintWatchCalls++, { close: () => {} }),
      });

      let added: ((...a: unknown[]) => void)[] = [];
      for (let i = 0; i < 50 && added.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
        added = process.listeners("SIGINT").filter((l) => !before.includes(l)) as typeof added;
      }
      expect(added.length).toBe(1);

      expect(sigintWatchCalls).toBe(2); // the fake reached runWatch — no real fs.watch opened
      added[0]!(); // ctrl-c
      expect(await p).toBe(0);
      process.removeListener("SIGINT", added[0]!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("notekit dispatch (Story 1.4 Task 3)", () => {
  /** A bare Obsidian-shaped dir. notekit has NO preflight (⚠️-2), so `.obsidian/` is the whole contract. */
  function bareVault(dir: string): string {
    mkdirSync(join(dir, ".obsidian"), { recursive: true });
    return dir;
  }

  test("HELP documents `notekit deploy` and its --watch", () => {
    expect(HELP).toContain("notekit deploy");
    expect(HELP).toContain("notekit deploy options:");
    expect(HELP).toContain("src/notekit, src/core");
  });

  test("`notekit` delegates to runNotekitDeploy and returns its exit code", async () => {
    // A missing --vault is the one-shot usage error (2) — proves the delegation, no vault needed.
    expect(await runMain(["notekit", "deploy"], { log: () => {} })).toBe(2);
  });

  test("`notekit <bad>` follows the exit-2 usage contract, and prints notekit's OWN usage", async () => {
    // ⚠️-2: `verify` is not a notekit subcommand in v1 (FR18/Epic 3), so it must fall through to the
    // deploy runner's usage line, NOT be silently accepted. Both a made-up sub and `verify` exit 2.
    const errs: string[] = [];
    const realError = console.error;
    console.error = (l: unknown) => errs.push(String(l));
    try {
      expect(await runMain(["notekit", "bogus"], { log: () => {} })).toBe(2);
      expect(await runMain(["notekit", "verify"], { log: () => {} })).toBe(2);
      expect(await runMain(["notekit"], { log: () => {} })).toBe(2);
    } finally {
      console.error = realError;
    }
    // notekit's own usage, never dashkit's or cn's — a copy-pasted spec would show the wrong command.
    // ⚠ WIDENED by Story 2.1: the spec's usage line now names all four verbs, because this is what
    // `runEdgeDeploy` prints on an unknown sub and a `deploy`-only line would tell the user the CLI
    // has one verb when it has four. The old literal is pinned as ABSENT so it cannot come back.
    expect(errs.join("\n")).toContain("usage: std notekit <deploy|render|validate|capabilities>");
    expect(errs.join("\n")).toContain("render <note> --config <path>");
    expect(errs.join("\n")).not.toContain("usage: std notekit deploy --vault <dir>");
    expect(errs.join("\n")).not.toContain("std dashkit deploy");
    expect(errs.join("\n")).not.toContain("std cn deploy");
  });

  test("the three read verbs route to runNotekitRead, and deploy still routes to the deploy runner", async () => {
    // Story 2.1's pre-dispatch. Each read verb is identified by the exit code it OWNS: a missing
    // --config is the read surface's usage 2, which the deploy runner would never produce (it does not
    // parse --config at all), and none of the three touches a vault.
    const errs: string[] = [];
    const realError = console.error;
    console.error = (l: unknown) => errs.push(String(l));
    try {
      expect(await runMain(["notekit", "render", "n.md"], { log: () => {} })).toBe(2);
      expect(await runMain(["notekit", "capabilities"], { log: () => {} })).toBe(2);
      expect(await runMain(["notekit", "validate"], { log: () => {} })).toBe(2);
    } finally {
      console.error = realError;
    }
    const printed = errs.join("\n");
    expect(printed).toContain("--config <path> is required"); // the READ surface's message…
    expect(printed).toContain("--spec - is required");
    expect(printed).not.toContain("bundle src/notekit"); // …and never the deploy runner's

    // `deploy` falls THROUGH the pre-dispatch, unchanged: it still fails on the missing --vault the
    // deploy runner owns, which the read surface does not parse.
    const deployErrs: string[] = [];
    console.error = (l: unknown) => deployErrs.push(String(l));
    try {
      expect(await runMain(["notekit", "deploy"], { log: () => {} })).toBe(2);
    } finally {
      console.error = realError;
    }
    expect(deployErrs.join("\n")).toContain("--vault");
  });

  // ── Story 2.2 — `--apply` routing, through the REAL bin path ──────────────────────────────────
  //
  // ⚠ ASSERTED ON THE EFFECT, NEVER ON THE EXIT CODE. Both orderings return 0 on a valid note: if 2.2's
  // write branch were added AFTER 2.1's three-verb pre-dispatch, every `--apply` would be swallowed by
  // the read path — preview printed, nothing written, exit 0 — and an exit-code-only assertion would be
  // green over a writer that is unreachable. The note's BYTES are what distinguishes the two.
  //
  // These also drive `runNotekitApply`'s DEFAULT writer (no `writeNote` injection reaches it from
  // main.ts), so the one permitted `atomicWrite` call site is genuinely executed by the suite rather
  // than guarded as dead code.
  function applyFixture(): { dir: string; note: string; config: string } {
    const dir = mkdtempSync(join(tmpdir(), "std-apply-"));
    const note = join(dir, "note.md");
    const config = join(dir, "cfg.ts");
    // NON-canonical on purpose (a doubled key, ragged spacing), so an apply has something to change.
    writeFileSync(
      note,
      ["---", "nk-type: card", "---", "", "```nk-card", "title:   Primer  ", "title: Primer", "```", "", "prose"].join("\n"),
    );
    writeFileSync(
      config,
      `const config = { noteTypes: { card: "t" }, templates: { t: { renderer: "nk-card", rubric: { kind: "card", titleField: "title", fields: [] } } } };\nexport default config;\n`,
    );
    return { dir, note, config };
  }

  test("`notekit render <note> --apply` REACHES the writer — the note's bytes change", async () => {
    const { dir, note, config } = applyFixture();
    try {
      const before = readFileSync(note, "utf-8");
      expect(await runMain(["notekit", "render", note, "--config", config, "--apply"], { log: () => {} })).toBe(0);
      const after = readFileSync(note, "utf-8");
      expect(after).not.toBe(before); // the ONE assertion the swallowed ordering cannot satisfy
      expect(after).toBe(
        ["---", "nk-type: card", "---", "", "```nk-card", "title: Primer", "```", "", "prose"].join("\n"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("…and WITHOUT --apply the same command leaves the note byte-identical", async () => {
    const { dir, note, config } = applyFixture();
    try {
      const before = readFileSync(note, "utf-8");
      expect(await runMain(["notekit", "render", note, "--config", config], { log: () => {} })).toBe(0);
      expect(readFileSync(note, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`--apply` on a verb that is not render is a usage 2, never a silent no-op", async () => {
    const errs: string[] = [];
    const realError = console.error;
    console.error = (l: unknown) => errs.push(String(l));
    try {
      expect(await runMain(["notekit", "validate", "--apply"], { log: () => {} })).toBe(2);
      expect(await runMain(["notekit", "capabilities", "--apply"], { log: () => {} })).toBe(2);
      // `deploy --apply` returned 0 before this guard: runEdgeDeploy has no unknown-flag rejection, so
      // it deployed and ignored the flag entirely.
      expect(await runMain(["notekit", "deploy", "--apply", "--vault", "/no/such/vault"], { log: () => {} })).toBe(2);
      expect(await runMain(["notekit", "bogus", "--apply"], { log: () => {} })).toBe(2);
    } finally {
      console.error = realError;
    }
    expect(errs.filter((l) => l.includes("--apply is only valid on"))).toHaveLength(4);
  });

  test("the guard's `apply &&` half is load-bearing — the deploy fall-through still works", async () => {
    // Simplified to `rest[0] !== "render"` the guard would exit 2 for EVERY non-render verb and kill
    // the deploy delegate. Without --apply, deploy must still reach the deploy runner's own usage.
    const errs: string[] = [];
    const realError = console.error;
    console.error = (l: unknown) => errs.push(String(l));
    try {
      expect(await runMain(["notekit", "deploy"], { log: () => {} })).toBe(2);
    } finally {
      console.error = realError;
    }
    expect(errs.join("\n")).toContain("--vault");
    expect(errs.join("\n")).not.toContain("--apply is only valid on");
  });

  test("HELP declares --apply under `notekit render options:`, and NK-4 rule 3's sentence with it", () => {
    expect(HELP).toContain("notekit render options:");
    expect(HELP).toContain("--apply           actually execute the plan. WITHOUT IT NOTHING MUTATES");
  });

  test("the unknown-command line names notekit — a registered command must be discoverable", async () => {
    const errs: string[] = [];
    const realError = console.error;
    console.error = (l: unknown) => errs.push(String(l));
    try {
      expect(await runMain(["nope"], { log: () => {} })).toBe(2);
    } finally {
      console.error = realError;
    }
    expect(errs.join("\n")).toContain("Known: alias, cn, dashkit, notekit, bmad");
  });

  test("--watch registers the shutdown hook AT THE CALLSITE, and only when resident", async () => {
    const dir = mkdtempSync(join(tmpdir(), "std-main-nk-"));
    try {
      const vault = bareVault(join(dir, "vault"));
      // A FAKE watcher: never open a real recursive watch here (FSEvents vs inotify is platform-divergent).
      let watchCalls = 0;
      const watch = () => (watchCalls++, { close: () => {} });

      let stops = 0;
      expect(
        await runMain(["notekit", "deploy", "--vault", vault], {
          log: () => {},
          watch,
          onWatchStart: () => stops++,
        }),
      ).toBe(0);
      expect(stops).toBe(0); // one-shot installs no handler

      let stop: (() => void) | undefined;
      expect(
        await runMain(["notekit", "deploy", "--vault", vault, "--watch"], {
          log: () => {},
          watch,
          onWatchStart: (s) => {
            stop = s;
            s();
          },
        }),
      ).toBe(0);
      expect(typeof stop).toBe("function");
      // Assert the FAKE was reached: without this, deleting `watch: deps.watch` from main.ts's notekit
      // arm stays green while the test silently opens REAL recursive watchers on src/notekit + src/core.
      expect(watchCalls).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the DEFAULT shutdown hook is a real SIGINT listener installed by main.ts", async () => {
    // Nothing is injected here, so the `?? ((stop) => process.on("SIGINT", stop))` default IS under
    // test — deleting it from the notekit arm would otherwise ship green.
    const dir = mkdtempSync(join(tmpdir(), "std-main-nk-sigint-"));
    try {
      const vault = bareVault(join(dir, "vault"));
      let watchCalls = 0;
      const before = process.listeners("SIGINT");
      const p = runMain(["notekit", "deploy", "--vault", vault, "--watch"], {
        log: () => {},
        watch: () => (watchCalls++, { close: () => {} }),
      });

      let added: ((...a: unknown[]) => void)[] = [];
      for (let i = 0; i < 50 && added.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
        added = process.listeners("SIGINT").filter((l) => !before.includes(l)) as typeof added;
      }
      expect(added.length).toBe(1);
      expect(watchCalls).toBe(2); // the fake reached runWatch — no real fs.watch opened
      added[0]!(); // ctrl-c
      expect(await p).toBe(0);
      process.removeListener("SIGINT", added[0]!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("globalReposPath", () => {
  test("honors XDG_CONFIG_HOME, else ~/.config/std/repos.ts", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = "/tmp/xdg";
      expect(globalReposPath()).toBe("/tmp/xdg/std/repos.ts");
      delete process.env.XDG_CONFIG_HOME;
      expect(globalReposPath().endsWith("/.config/std/repos.ts")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
    }
  });
});

// The byte-identity oracle (3.1 AC2). `FROZEN_HELP` began as the `HELP` template literal copied VERBATIM
// from `main.ts` at baseline 706777f, BEFORE `HELP` became `renderHelp(SURFACE)`. The right-hand side must
// stay a literal: `expect(HELP).toBe(renderHelp(SURFACE))` would be `HELP` compared to itself — the vacuous
// gate.
//
// ⚠ RE-FROZEN at Story 1.4 (notekit's delivery rail), and this is the ONLY sanctioned way to move it: a
// story that ADDS A COMMAND changes the shipped help text by definition, so the oracle is re-measured
// against the new text and the delta is stated here. Story 1.4's delta is exactly FIVE added LINES, in
// three groups — the `notekit deploy` row in `commands:`; the blank separator plus the `notekit deploy
// options:` header; and its two flag rows — all of them BETWEEN `dashkit verify` and `bmad` / between
// the dashkit and cn option blocks. (Counted in LINES, which is what the delta test below enumerates and
// what a diff of this constant shows: an earlier wording said "three additions", counting the groups,
// and the two counts disagreeing is exactly the ambiguity an audit trail cannot afford.) Every pre-existing
// byte is unchanged; that is what the diff of this constant must show. Editing it for any other reason
// (to "make a test pass", to reflow a line) is the failure this oracle exists to catch.
const FROZEN_HELP = `std — Pedro's standard CLI

usage: std <command> [options]

commands:
  alias --install   (re)generate repo-nav + the _std completion from ~/.config/std/repos.ts
  cn deploy         bundle src/cn -> <vault>/Scripts/cn.js (one-way; the vault is build output only)
  cn verify         check a vault against cn's declared plugin envelope (AD-6)
  dashkit deploy    bundle src/dashkit -> <vault>/Scripts/dashkit.js (one-way; the vault is build output only)
  dashkit verify    check a vault against dashkit's declared plugin envelope (AD-6)
  notekit deploy    bundle src/notekit -> <vault>/Scripts/notekit.js (one-way; the vault is build output only)
  notekit render    preview a note as an nk-card; writes only with --apply (the sole writer)
  notekit validate   check a RenderSpec read from stdin, returning the Result union
  notekit capabilities   list the declared note types, generated from the one registry
  bmad install|update|deploy   dry-run by default; --apply to mutate, --push to push
  bmad verify       prove both Surfaces are byte-faithful to source (read-only)

cn deploy options:
  --vault <dir>     the Obsidian vault to deploy into (required — std bakes in no vault path)
  --format <fmt>    bundle format: esm (default) or cjs
  --watch           deploy once, then stay resident and redeploy on every save under src/cn, src/core

dashkit deploy options:
  --vault <dir>     the Obsidian vault to deploy into (required — std bakes in no vault path)
  --watch           deploy once, then stay resident and redeploy on every save under src/dashkit, src/core

notekit deploy options:
  --vault <dir>     the Obsidian vault to deploy into (required — std bakes in no vault path)
  --watch           deploy once, then stay resident and redeploy on every save under src/notekit, src/core

notekit render options:
  --config <path>   the caller-local note-type registry to read (required — std bakes in no registry)
  --at <iso>        stamp the card with this timestamp instead of the clock, making the output byte-reproducible
  --apply           actually execute the plan. WITHOUT IT NOTHING MUTATES (dry-run is the default)
  --body -          read the fence body from stdin instead of the note's own fence. Requires --apply
  --json            emit the machine-readable ledger; it is then the only thing on stdout

notekit validate options:
  --spec -          read the candidate RenderSpec from stdin; \`-\` is the only accepted value
  --json            emit the machine-readable ledger; it is then the only thing on stdout

notekit capabilities options:
  --config <path>   the caller-local note-type registry to read (required — std bakes in no registry)
  --json            emit the machine-readable ledger; it is then the only thing on stdout

cn verify options:
  --vault <dir>     the Obsidian vault to check (required)
                    drift is reported and never fatal; a missing foundation exits 1

dashkit verify options:
  --vault <dir>     the Obsidian vault to check (required)
                    drift is reported and never fatal; a missing foundation exits 1

flags:
  -h, --help        show this help`;

/** Story 2.7's one added row, named once so both delta tests reverse the SAME literal. */
const BODY_ROW =
  "  --body -          read the fence body from stdin instead of the note's own fence. Requires --apply";

describe("HELP — byte-identity oracle (3.1 AC2)", () => {
  // Self-check on the TRANSCRIPTION first: a copy-paste slip would freeze the wrong bytes and then pass
  // the toBe below forever. `.length` is UTF-16 units, NOT bytes — the gap is the multi-byte characters
  // HELP carries (the title's em dash, one per `--vault` row, and Story 2.1's two `--config` rows), so
  // Buffer.byteLength runs ahead of `.length`. All three re-measured on the shipped constant at 2.1.
  //
  // ⚠ RE-FROZEN ON THE #83 FOLLOW-UP. The `notekit render` desc changed ("writes nothing (the
  // sole-writer path is a later story)" → "writes only with --apply (the sole writer)") because 2.2's
  // `--apply` row had falsified it, and `renderHelp` prints both strings in one output. Twelve fewer
  // characters, same line count: 3048/3060/54 → 3036/3048/54. Both numbers re-measured off the shipped
  // constant, never transcribed from the diff.
  //
  // ⚠ RE-FROZEN AGAIN AT STORY 2.7, for its ONE `--body -` row inside `notekit render options:`:
  // 3036/3048/54 → 3137/3149/55. All three re-measured off the shipped constant. The delta test below
  // is what makes this re-freeze honest — a blind re-freeze at any of these sites is how a byte-identity
  // oracle stops being one.
  test("the frozen literal is the one that was measured", () => {
    expect(FROZEN_HELP.length).toBe(3137);
    expect(Buffer.byteLength(FROZEN_HELP)).toBe(3149);
    expect(FROZEN_HELP.split("\n").length).toBe(55);
  });

  test("HELP is byte-identical to the frozen text", () => {
    expect(HELP).toBe(FROZEN_HELP);
  });

  // The re-freeze is only honest if the delta is ITSELF asserted. Stripping EVERY notekit line from
  // FROZEN_HELP must reproduce the 32-line/1573-char text 3.1 measured — so a re-freeze that quietly
  // reflowed or dropped a pre-existing line fails here even though the `toBe` above is green.
  //
  // ⚠ This test used to hardcode 1.4's five notekit lines and strip them by INDEX. Story 2.1 added
  // sixteen more, which broke it — so the filter is now a RULE ("every notekit command row, and every
  // notekit options block with its blank separator") rather than a list. The baseline it lands on is
  // unchanged and deliberately so: 3.1's pre-notekit measurement is the one fixed point, and anchoring
  // to it means the next notekit story extends the RULE'S INPUT, never the oracle's target.
  test("the delta from the 3.1 baseline is EXACTLY the notekit additions, nothing else", () => {
    const lines = FROZEN_HELP.split("\n");
    const baseline: string[] = [];
    const removed: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.startsWith("  notekit ")) {
        removed.push(line); // a command row in the `commands:` block
        i++;
        continue;
      }
      if (/^notekit .* options:$/.test(line)) {
        // The blank separator BEFORE the header belongs to this block, and was already kept.
        if (baseline[baseline.length - 1] === "") removed.push(baseline.pop()!);
        removed.push(line);
        i++;
        while (i < lines.length && lines[i] !== "") removed.push(lines[i++]!);
        continue;
      }
      baseline.push(line);
      i++;
    }

    expect(baseline.length).toBe(32); // 3.1's measured line count
    expect(baseline.join("\n").length).toBe(1573); // …and its measured char count

    // …and the removed set is accounted for exactly: four command rows and four option blocks.
    expect(removed.filter((l) => l.startsWith("  notekit "))).toEqual([
      "  notekit deploy    bundle src/notekit -> <vault>/Scripts/notekit.js (one-way; the vault is build output only)",
      "  notekit render    preview a note as an nk-card; writes only with --apply (the sole writer)",
      "  notekit validate   check a RenderSpec read from stdin, returning the Result union",
      "  notekit capabilities   list the declared note types, generated from the one registry",
    ]);
    expect(removed.filter((l) => /^notekit .* options:$/.test(l))).toEqual([
      "notekit deploy options:",
      "notekit render options:",
      "notekit validate options:",
      "notekit capabilities options:",
    ]);
    expect(removed.length + baseline.length).toBe(lines.length); // nothing fell between the two sets
  });

  // Story 2.2's own delta. The test above anchors to 3.1's PRE-NOTEKIT baseline and therefore cannot
  // see a change made INSIDE a notekit options block — it strips those blocks wholesale. 2.2's change
  // is exactly such a change (one flag row inside `notekit render options:`), so without this
  // assertion the re-freeze above would be blind precisely where 2.2 moved the bytes.
  //
  // It is stated as a REMOVAL back to 2.1's measured text rather than as a second frozen literal:
  // reversing 2.2's additions must reproduce 2949/2961/53 exactly, which is only true if they are the
  // whole delta.
  //
  // ⚠ THE DELTA IS NOW TWO THINGS, NOT ONE. The #83 follow-up corrected the `notekit render` desc, so
  // reversing only the `--apply` row no longer lands on 2.1's text. The fix is to reverse BOTH and keep
  // 2.1's measured numbers as the target — NOT to re-measure the target to whatever the code now says.
  // 3.1's and 2.1's fixed points are the anchors; a later story extends the reversal, never the target.
  // Re-measuring instead would make this oracle assert only that arithmetic works.
  test("the delta from the post-2.1 freeze is EXACTLY the --apply row plus the render desc", () => {
    const APPLY_ROW =
      "  --apply           actually execute the plan. WITHOUT IT NOTHING MUTATES (dry-run is the default)";
    const RENDER_ROW_2_1 =
      "  notekit render    preview a note as an nk-card; writes nothing (the sole-writer path is a later story)";
    const RENDER_ROW_NOW =
      "  notekit render    preview a note as an nk-card; writes only with --apply (the sole writer)";

    const lines = FROZEN_HELP.split("\n");
    expect(lines.filter((l) => l === APPLY_ROW)).toHaveLength(1); // one row, not two
    expect(lines.filter((l) => l === RENDER_ROW_NOW)).toHaveLength(1);
    expect(lines.filter((l) => l === RENDER_ROW_2_1)).toHaveLength(0); // the stale claim is gone

    // …and the corrected desc names the flag that contradicted it, so the two rows now agree.
    expect(RENDER_ROW_NOW).toContain("--apply");

    // …and it sits inside `notekit render options:`, not somewhere that merely counts the same.
    const header = lines.indexOf("notekit render options:");
    expect(header).toBeGreaterThan(-1);
    const block = lines.slice(header + 1, lines.indexOf("", header));
    expect(block.map((l) => l.trim().split(/\s{2,}/)[0])).toEqual([
      "--config <path>",
      "--at <iso>",
      "--apply",
      "--body -",
      "--json",
    ]);

    // ⚠ THE REVERSAL NOW STRIPS 2.7'S ROW TOO, AND THE TARGET IS UNCHANGED. 2.1's measured 2949/2961/53
    // is a FIXED POINT: each later story extends what is reversed, never what it lands on. Re-measuring
    // the target to whatever the code now says would leave this asserting only that arithmetic works.
    const post21 = lines
      .filter((l) => l !== APPLY_ROW && l !== BODY_ROW)
      .map((l) => (l === RENDER_ROW_NOW ? RENDER_ROW_2_1 : l))
      .join("\n");
    expect(post21.length).toBe(2949);
    expect(Buffer.byteLength(post21)).toBe(2961);
    expect(post21.split("\n").length).toBe(53);
  });

  // Story 2.7's own delta. The 3.1-baseline test above strips every notekit options block wholesale and
  // therefore cannot see a change made INSIDE one; the post-2.1 test lands on a target three stories
  // old. Neither answers "was 2.7's change EXACTLY one row?" — this does, by reversing only that row and
  // landing on the post-2.6 freeze byte for byte.
  test("the delta from the post-2.6 freeze is EXACTLY the one --body row", () => {
    const lines = FROZEN_HELP.split("\n");
    expect(lines.filter((l) => l === BODY_ROW)).toHaveLength(1); // one row, not two

    // It sits inside `notekit render options:` — the block 2.1 created — and NOT in `commands:`: 2.7
    // adds a flag, never a subcommand, so `HELP_OPTION_BLOCKS` does not move.
    const header = lines.indexOf("notekit render options:");
    const block = lines.slice(header + 1, lines.indexOf("", header));
    expect(block).toContain(BODY_ROW);
    expect(lines.filter((l) => l.startsWith("  notekit ")).join("\n")).not.toContain("--body");

    // …and the row states the grammar it implements: `-` as the metavar, `--apply` as the precondition.
    expect(BODY_ROW).toContain("--body -");
    expect(BODY_ROW).toContain("Requires --apply");

    const post26 = lines.filter((l) => l !== BODY_ROW).join("\n");
    expect(post26.length).toBe(3036); // 2.6's measured numbers, reproduced exactly
    expect(Buffer.byteLength(post26)).toBe(3048);
    expect(post26.split("\n").length).toBe(54);
  });
});

// ═══ STORY 2.7 — `--body -` through the REAL notekit arm (AC #2's nine rows) ══════════════════════

describe("2.7 AC #2 — the --body grammar, through main.ts's notekit arm", () => {
  /** A note whose fence is already CANONICAL, so any byte change is the stdin body's doing. */
  function bodyFixture(): { dir: string; note: string; config: string; before: string } {
    const dir = mkdtempSync(join(tmpdir(), "std-body-"));
    const note = join(dir, "note.md");
    const config = join(dir, "cfg.ts");
    writeFileSync(
      note,
      ["---", "nk-type: card", "---", "", "```nk-card", "title: Primer", "```", "", "prose"].join("\n"),
    );
    writeFileSync(
      config,
      `const config = { noteTypes: { card: "t" }, templates: { t: { renderer: "nk-card", rubric: { kind: "card", titleField: "title", fields: [] } } } };\nexport default config;\n`,
    );
    return { dir, note, config, before: readFileSync(note, "utf-8") };
  }

  /** Run `std notekit …` capturing console.error, which the arm's guards write to directly. */
  async function run(argv: string[]): Promise<{ code: number; errs: string[] }> {
    const errs: string[] = [];
    const realError = console.error;
    console.error = (l: unknown) => errs.push(String(l));
    try {
      return { code: await runMain(argv, { log: () => {} }), errs };
    } finally {
      console.error = realError;
    }
  }

  test("rows 1 and 2 — the SPACE and EQUALS forms are the same flag, and both reach the channel", async () => {
    // 🔴 THE ASSERTION IS ON THE BYTES, not the exit code. Under a `hasFlag`-only presence test row 2
    // reads as absent, no stdin is read, the note's own fence is written back — and the run STILL
    // exits 0. Only the written body separates the correct implementation from the silent no-op.
    for (const form of [["--body", "-"], ["--body=-"]]) {
      const { dir, note, config, before } = bodyFixture();
      const proc = Bun.spawn(
        ["bun", join(import.meta.dir, "main.ts"), "notekit", "render", note, "--config", config, "--apply", ...form],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      proc.stdin.write("title: Enriched\n");
      await proc.stdin.end();
      expect(await proc.exited).toBe(0);
      const after = readFileSync(note, "utf-8");
      expect(after).not.toBe(before);
      expect(after).toContain("title: Enriched");
      expect(after).not.toContain("title: Primer");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("row 3 — `--body -` WITHOUT --apply is nk-body-without-apply, usage 2, nothing written", async () => {
    const { dir, note, config, before } = bodyFixture();
    try {
      const { code, errs } = await run(["notekit", "render", note, "--config", config, "--body", "-"]);
      expect(code).toBe(2);
      // ⚠ THE CODE NAME IS A GREPPABLE LITERAL IN THE STDERR TEXT. It is not machine-readable in an
      // envelope, deliberately: a usage 2 is decidable from argv before any file is read, so the run
      // never reaches the pipeline that produces one. Promoting it later is one line at one guard.
      expect(errs.join("\n")).toContain("nk-body-without-apply");
      expect(readFileSync(note, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rows 4, 5 and 6 — ONE equality closes every non-`-` value", async () => {
    const { dir, note, config, before } = bodyFixture();
    try {
      const bad = [
        ["--body"],              // row 4 — trailing, no value (`flagValue` → undefined)
        ["--body", "foo"],       // row 5 — a value that is not `-`
        ["--body=./b.txt"],      // row 5 — the path surface NK-8 rule 3 refuses
        ["--body="],             // row 5 — an empty value (`flagValue` → "")
        ["--body", "--json"],    // row 6 — the space form takes the next token unconditionally
      ];
      for (const flag of bad) {
        const { code, errs } = await run(["notekit", "render", note, "--config", config, "--apply", ...flag]);
        expect(code).toBe(2);
        expect(errs.join("\n")).toContain("--body accepts exactly one value");
      }
      expect(readFileSync(note, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("row 7 — a MISPLACED --body is a usage 2 on every non-render verb, never a silent no-op", async () => {
    const { code: v, errs: ve } = await run(["notekit", "validate", "--body", "-"]);
    expect(v).toBe(2);
    const { code: c } = await run(["notekit", "capabilities", "--body", "-"]);
    expect(c).toBe(2);
    // `deploy` is the one that would otherwise DEPLOY and return 0 on a flag it never parses.
    const { code: d } = await run(["notekit", "deploy", "--body", "-", "--vault", "/no/such/vault"]);
    expect(d).toBe(2);
    const { code: b } = await run(["notekit", "bogus", "--body", "-"]);
    expect(b).toBe(2);
    expect(ve.join("\n")).toContain("--body is only valid on");
  });

  test("row 7 — …and the message names the flag that is actually misplaced", async () => {
    const { errs: bodyErrs } = await run(["notekit", "validate", "--body", "-"]);
    expect(bodyErrs.join("\n")).toContain("--body is only valid on");
    expect(bodyErrs.join("\n")).not.toContain("--apply is only valid on");
    const { errs: applyErrs } = await run(["notekit", "validate", "--apply"]);
    expect(applyErrs.join("\n")).toContain("--apply is only valid on");
  });

  test("the guard's `apply || bodyPresent` half is load-bearing — deploy still falls through", async () => {
    // Simplified to `rest[0] !== "render"` this would exit 2 for every non-render verb and kill the
    // deploy delegate. Without either flag, deploy must still reach the deploy runner's own usage.
    const { code, errs } = await run(["notekit", "deploy"]);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("--vault");
    expect(errs.join("\n")).not.toContain("is only valid on");
  });

  test("row 8 — no --body at all: stdin is NEVER read (2.2's behaviour, unchanged)", async () => {
    // Driven through the real bin with stdin held OPEN and never ended. A CLI that read stdin
    // unconditionally would block on the 1000ms hang-guard; this one must not touch it at all, so the
    // run completes immediately on a stream that never ends.
    const { dir, note, config } = bodyFixture();
    try {
      const started = Date.now();
      const proc = Bun.spawn(
        ["bun", join(import.meta.dir, "main.ts"), "notekit", "render", note, "--config", config, "--apply"],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      expect(await proc.exited).toBe(0);
      expect(Date.now() - started).toBeLessThan(900); // under the hang-guard, so it was never armed
      expect(readFileSync(note, "utf-8")).toContain("title: Primer"); // the note's OWN fence, normalized
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("HELP declares --body under `notekit render options:`, with `-` as its whole grammar", () => {
    expect(HELP).toContain("notekit render options:");
    expect(HELP).toContain("--body -          read the fence body from stdin");
    expect(HELP).toContain("Requires --apply");
  });

  test("🔴 the misordered form resolves the SAME <note>, because `body` is a VALUE_FLAGS member", async () => {
    // ⚠ A DIVERGENCE FROM THE STORY'S TRACED PREDICTION, AND LIVE CODE GOVERNS. The story traced
    // `positional(argv.slice(1))` — first non-`--` token — and concluded `render --body - --apply
    // <note>` would read the literal `-` as the <note> and exit 1 with `nk-note-unreadable`. Story 2.1
    // had already replaced `positional` with `notePositional`, a walker that skips a space-form value
    // flag WITH its value, so once `body` joins VALUE_FLAGS both orderings resolve the same path. The
    // story's declared "a file named `-` in cwd" residual disappears with it.
    const { dir, note, config, before } = bodyFixture();
    try {
      const proc = Bun.spawn(
        ["bun", join(import.meta.dir, "main.ts"), "notekit", "render", "--body", "-", "--apply", "--config", config, note],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      proc.stdin.write("title: Misordered\n");
      await proc.stdin.end();
      expect(await proc.exited).toBe(0);
      const after = readFileSync(note, "utf-8");
      expect(after).not.toBe(before);
      expect(after).toContain("title: Misordered");
      expect(after).not.toContain("cannot read note");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2.2's single-`--apply`-read gate is still at exactly one, and `--body` adds no second read", () => {
    // ⚠ THE GLOB FORM, never a shell-expanded path list (2.5 AC #4's correction to 2.2 — `rg` honours
    // an explicit path over a `-g '!…'` exclusion). The globs stay the enumeration of scope; only the
    // COUNTING moved off `rg`.
    //
    // 🔴 MASKED WITH `stripComments`, AND THE FIRST DRAFT WAS NOT MASKED AT ALL — cross-vendor review
    // finding (grok, 2026-08-06), confirmed by probe. A raw `rg` counts a token wherever it appears, so
    // a COMMENT naming the banned form (`never a local hasFlag(argv, "body")`) turned this gate red
    // against a tree whose production code had exactly one reader. The first response was to paraphrase
    // the comment, which is a workaround that hands the next editor a trap: "restore clarity" in prose
    // and CI fails for prose. This gate bans a CODE token, so comments are masked and it counts code.
    //
    // ⚠ `stripComments`, NOT `stripStringsAndComments` — and the difference is load-bearing rather than
    // a preference. The stronger helper blanks string CONTENT too, so `hasFlag(argv, "body")` becomes
    // `hasFlag(argv, "    ")` and this gate would match NOTHING, reporting a green zero for every flag.
    // That is why `sole-writer.test.ts` can use the stronger one and this cannot: it bans a CALL token
    // (`atomicWrite(`), while the name this gate counts lives INSIDE the string argument.
    const repo = join(import.meta.dir, "..", "..");
    const files = Bun.spawnSync({
      cmd: [
        "rg", "--files", "src/",
        "-g", "src/cli/main.ts", "-g", "src/cli/notekit-*.ts", "-g", "src/notekit/**/*.ts", "-g", "!*.test.ts",
      ],
      cwd: repo,
      stdout: "pipe",
    }).stdout.toString().trim().split("\n").filter(Boolean);
    // The scope is non-empty, or every count below is a vacuous zero.
    expect(files.length).toBeGreaterThan(0);

    for (const [flag, expected, owner] of [["apply", 1, "main.ts"], ["body", 1, "notekit-write.ts"]] as const) {
      const pattern = new RegExp(`hasFlag\\([^)]*"${flag}"`, "g");
      const hits = files.flatMap((f) => {
        const clean = stripComments(readFileSync(join(repo, f), "utf-8"));
        return (clean.match(pattern) ?? []).map(() => f);
      });
      expect(hits).toHaveLength(expected);
      // …and the ONE read lives where it is supposed to — for `body`, inside the shared predicate.
      expect(hits[0]).toContain(owner);
    }
  });

  test("COUNTERFACTUAL — the masked gate no longer reddens on a COMMENT, but still does on CODE", () => {
    // Both halves, because a mask that swallowed the real reads too would be a gate that cannot fail.
    const pattern = /hasFlag\([^)]*"body"/;

    // A line comment naming the banned form no longer counts…
    expect(pattern.test(stripComments(`// never a local hasFlag(argv, "body") here\nconst x = 1;\n`))).toBe(false);
    // …nor does a block comment…
    expect(pattern.test(stripComments(`/* hasFlag(argv, "body") */\nconst y = 2;\n`))).toBe(false);
    // …and the REAL reader still does. Without this half a mask that swallowed everything would look
    // like a passing gate, which is the failure mode the mask itself introduces.
    expect(pattern.test(stripComments(`const p = hasFlag(argv, "body");\n`))).toBe(true);
    // And the reason the STRONGER helper is wrong here, asserted rather than asserted-in-prose: it
    // blanks the string the flag name lives in, so the gate would count zero and look green.
    expect(pattern.test(stripStringsAndComments(`const p = hasFlag(argv, "body");\n`))).toBe(false);
  });
});
