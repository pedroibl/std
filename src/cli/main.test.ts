import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { globalReposPath, runMain } from "./main";

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
    expect(await runMain([], { log: () => {} })).toBe(2);
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
