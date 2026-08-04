import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CN_PLUGIN_CONTRACT } from "../cn/plugins";
import { HELP, globalReposPath, runMain } from "./main";
import { makeVaultFixture } from "./vault-fixture";

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
    expect(errs.join("\n")).toContain("usage: std notekit deploy --vault <dir>");
    expect(errs.join("\n")).not.toContain("std dashkit deploy");
    expect(errs.join("\n")).not.toContain("std cn deploy");
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
// against the new text and the delta is stated here. Story 1.4's delta is exactly three additions — the
// `notekit deploy` row in `commands:`, the `notekit deploy options:` block, and its two flag rows — all of
// them BETWEEN `dashkit verify` and `bmad` / between the dashkit and cn option blocks. Every pre-existing
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

cn verify options:
  --vault <dir>     the Obsidian vault to check (required)
                    drift is reported and never fatal; a missing foundation exits 1

dashkit verify options:
  --vault <dir>     the Obsidian vault to check (required)
                    drift is reported and never fatal; a missing foundation exits 1

flags:
  -h, --help        show this help`;

describe("HELP — byte-identity oracle (3.1 AC2)", () => {
  // Self-check on the TRANSCRIPTION first: a copy-paste slip would freeze the wrong bytes and then pass
  // the toBe below forever. `.length` is UTF-16 units, NOT bytes — HELP now carries FOUR em dashes (the
  // title, plus one per `--vault` row, and 1.4 added a third `--vault` row), so Buffer.byteLength is 1918
  // while `.length` is 1910. Both re-measured on the shipped constant at Story 1.4.
  test("the frozen literal is the one that was measured", () => {
    expect(FROZEN_HELP.length).toBe(1910);
    expect(Buffer.byteLength(FROZEN_HELP)).toBe(1918);
    expect(FROZEN_HELP.split("\n").length).toBe(37);
  });

  test("HELP is byte-identical to the frozen text", () => {
    expect(HELP).toBe(FROZEN_HELP);
  });

  // The re-freeze is only honest if the delta is ITSELF asserted. Removing the three notekit additions
  // from FROZEN_HELP must reproduce the 32-line/1573-char text 3.1 measured — so a re-freeze that
  // quietly reflowed or dropped a pre-existing line fails here even though the `toBe` above is green.
  test("the delta from the 3.1 baseline is EXACTLY the notekit additions, nothing else", () => {
    const added = [
      "  notekit deploy    bundle src/notekit -> <vault>/Scripts/notekit.js (one-way; the vault is build output only)",
      "",
      "notekit deploy options:",
      "  --vault <dir>     the Obsidian vault to deploy into (required — std bakes in no vault path)",
      "  --watch           deploy once, then stay resident and redeploy on every save under src/notekit, src/core",
    ];
    const lines = FROZEN_HELP.split("\n");
    // Drop the command row, then the four-line block (blank separator + header + two flags).
    const rowAt = lines.indexOf(added[0]!);
    expect(rowAt).toBeGreaterThan(-1);
    const blockAt = lines.indexOf("notekit deploy options:");
    expect(blockAt).toBeGreaterThan(-1);
    const baseline = lines.filter(
      (_, i) => i !== rowAt && i !== blockAt - 1 && i !== blockAt && i !== blockAt + 1 && i !== blockAt + 2,
    );
    expect(baseline.length).toBe(32); // 3.1's measured line count
    expect(baseline.join("\n").length).toBe(1573); // …and its measured char count
    // Every added line really is one of the five named above — no sixth slipped in.
    const removed = lines.filter((_, i) => i === rowAt || (i >= blockAt - 1 && i <= blockAt + 2));
    expect(removed).toEqual(added);
  });
});
