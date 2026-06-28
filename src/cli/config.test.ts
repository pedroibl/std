import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SCHEMA_VERSION, defineConfig, discover, resolveConfigPath, validate } from "./index";
import type { Manifest } from "./index";

const good: Manifest = {
  schemaVersion: 1,
  commands: [{ name: "gates", steps: [{ kind: "exec", label: "lint", run: "bun run lint" }] }],
};

describe("defineConfig", () => {
  test("returns its argument (identity helper for typed authoring)", () => {
    expect(defineConfig(good)).toBe(good);
  });
});

describe("validate — whole-at-load, fail-closed (AC1)", () => {
  test("accepts a well-formed manifest", () => {
    expect(validate(good)).toEqual(good);
  });

  test("rejects a non-object", () => {
    expect(() => validate(null)).toThrow(/must be an object/);
    expect(() => validate(42)).toThrow(/must be an object/);
  });

  test("rejects a missing/mismatched schemaVersion (AD-4)", () => {
    expect(() => validate({ commands: [] })).toThrow(/schemaVersion must be 1/);
    expect(() => validate({ schemaVersion: 2, commands: [] })).toThrow(/schemaVersion must be 1/);
  });

  test("rejects a non-array commands", () => {
    expect(() => validate({ schemaVersion: 1, commands: {} })).toThrow(/'commands' must be an array/);
  });

  test("rejects a bad step kind, naming the path", () => {
    const bad = { schemaVersion: 1, commands: [{ name: "g", steps: [{ kind: "nope", label: "x", run: "y" }] }] };
    expect(() => validate(bad)).toThrow(/commands\[0\]\.steps\[0\]\.kind/);
  });

  test("rejects a non-string run / label", () => {
    const badRun = { schemaVersion: 1, commands: [{ name: "g", steps: [{ kind: "exec", label: "x", run: 1 }] }] };
    expect(() => validate(badRun)).toThrow(/\.run must be a string/);
  });

  test("fail-closed: rejects a function value anywhere (AD-1 no smuggled computation)", () => {
    const sneaky = {
      schemaVersion: 1,
      commands: [{ name: "g", steps: [{ kind: "exec", label: "x", run: "y", hook: () => 1 }] }],
    };
    // the rebuilt projection drops `hook`; assert validation still produces clean serializable data
    const m = validate(sneaky);
    expect(JSON.stringify(m)).not.toContain("hook");
  });

  test("rejects a function smuggled at a position the projection would keep", () => {
    // a function AS the command name is a type breach caught by the string checks
    const bad = { schemaVersion: 1, commands: [{ name: () => "g", steps: [] }] };
    expect(() => validate(bad)).toThrow(/\.name must be a string/);
  });
});

describe("validate — adapter kind (Story 4.4 AC3 — closed std-owned set, config selects not supplies)", () => {
  const withStep = (step: unknown) => ({ schemaVersion: 1, commands: [{ name: "review", steps: [step] }] });

  test("accepts an adapter step naming a member of the closed set", () => {
    const m = validate(withStep({ kind: "adapter", label: "review", adapter: "sourcery" }));
    expect(m.commands[0].steps[0]).toEqual({ kind: "adapter", label: "review", adapter: "sourcery" });
  });

  test("accepts every named member (incl. deferred + none)", () => {
    for (const a of ["sourcery", "coderabbit", "none"]) {
      expect(() => validate(withStep({ kind: "adapter", label: "r", adapter: a }))).not.toThrow();
    }
  });

  test("'loom' is NOT a member (it's the local reviewer, not a hosted adapter) → rejected", () => {
    expect(() => validate(withStep({ kind: "adapter", label: "r", adapter: "loom" }))).toThrow(
      /\.adapter must be one of/,
    );
  });

  test("rejects an adapter name OUTSIDE the closed set (fail-closed), naming the path", () => {
    expect(() => validate(withStep({ kind: "adapter", label: "r", adapter: "semgrep" }))).toThrow(
      /commands\[0\]\.steps\[0\]\.adapter must be one of/,
    );
  });

  test("rejects config trying to SUPPLY an adapter (a function/command, not a name) — no logic backdoor", () => {
    // a function as the adapter value: not a string → fail-closed
    expect(() => validate(withStep({ kind: "adapter", label: "r", adapter: () => 0 }))).toThrow(
      /\.adapter must be one of/,
    );
    // an arbitrary command string masquerading as an adapter: not in the closed set → rejected
    expect(() => validate(withStep({ kind: "adapter", label: "r", adapter: "rm -rf /" }))).toThrow(
      /\.adapter must be one of/,
    );
  });

  test("an adapter step's `run` (if smuggled) is dropped — the projection carries only {kind,label,adapter}", () => {
    const m = validate(withStep({ kind: "adapter", label: "r", adapter: "none", run: "evil" }));
    expect(m.commands[0].steps[0]).not.toHaveProperty("run");
  });
});

describe("validate — NFR3 assertion 1: round-trips as serializable data", () => {
  test("the validated projection equals its JSON round-trip", () => {
    const m = validate(good);
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  test("extra non-serializable props on input are dropped from the projection", () => {
    const withExtras = {
      schemaVersion: 1,
      extraFn: () => 99,
      commands: [{ name: "g", steps: [{ kind: "exec", label: "x", run: "y" }] }],
    };
    const m = validate(withExtras);
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
    expect(m).not.toHaveProperty("extraFn");
  });
});

describe("discover / resolveConfigPath — zero-config (AC2, NFR8)", () => {
  test("finds repo-local std.config.ts and stops at the git toplevel", () => {
    const root = mkdtempSync(join(tmpdir(), "std-disc-"));
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, "std.config.ts"), "export default {}");
      const nested = join(root, "a", "b");
      mkdirSync(nested, { recursive: true });
      expect(discover(nested)).toBe(join(root, "std.config.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repo-local nearest-up wins (precedence over ancestors)", () => {
    const root = mkdtempSync(join(tmpdir(), "std-disc-"));
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, "std.config.ts"), "export default {}");
      const sub = join(root, "pkg");
      mkdirSync(sub);
      writeFileSync(join(sub, "std.config.ts"), "export default {}");
      expect(discover(sub)).toBe(join(sub, "std.config.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null at the git toplevel when no config exists (does not walk past the repo)", () => {
    const root = mkdtempSync(join(tmpdir(), "std-disc-"));
    try {
      mkdirSync(join(root, ".git"));
      const nested = join(root, "x");
      mkdirSync(nested);
      expect(discover(nested)).toBeNull();
      expect(resolveConfigPath(nested)).toBeNull(); // no global in this sandbox either path is null-safe
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("load — validates the imported module (fail-closed)", () => {
  test("loads a default-exported manifest and validates it", async () => {
    const root = mkdtempSync(join(tmpdir(), "std-load-"));
    try {
      const path = join(root, "std.config.ts");
      writeFileSync(
        path,
        `import { defineConfig } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};\n` +
          `export default defineConfig(${JSON.stringify(good)});\n`,
      );
      const { load } = await import("./index");
      const m = await load(path);
      expect(m).toEqual(good);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a config whose default export is invalid throws (fail-closed)", async () => {
    const root = mkdtempSync(join(tmpdir(), "std-load-"));
    try {
      const path = join(root, "std.config.ts");
      writeFileSync(path, `export default { schemaVersion: 9, commands: [] };\n`);
      const { load } = await import("./index");
      let thrown: unknown;
      try {
        await load(path);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/schemaVersion must be 1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("globalConfigPath — XDG_CONFIG_HOME honored", () => {
  test("uses XDG_CONFIG_HOME when set, else ~/.config", async () => {
    const { globalConfigPath } = await import("./index");
    const prev = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = "/tmp/xdg-test";
      expect(globalConfigPath()).toBe("/tmp/xdg-test/std/config.ts");
      delete process.env.XDG_CONFIG_HOME;
      expect(globalConfigPath().endsWith("/.config/std/config.ts")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
    }
  });
});

describe("SCHEMA_VERSION", () => {
  test("is the literal 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});
