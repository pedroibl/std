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
