// containment-zones.test.ts — REPAIRED (Story 13.6, AC6 / validator N-c).
// Run: bun test proof/hooks/lib/containment-zones.test.ts
//
// WHY THE REPAIR (option a — minimal correct fix, NOT the reverted-feature re-implement):
//   The pre-13.6 file was dead at load — it imported `internalUseSkillRels` + `privateSkillCacheDrift`,
//   which no longer exist on containment-zones.ts (current exports: ContainmentZone, CONTAINMENT_ZONES,
//   PATTERN_ALLOWLIST_FILES, relativeToClaudeRoot, isContained, isPatternAllowlisted). It also asserted a
//   REVERTED feature (visibility-aware private-skill containment): `isContained("skills/loom-ecosystem/…")
//   === true`. The live `private-skills` zone is only `skills/_*/**` (underscore-prefixed), so a kebab name
//   like `loom-ecosystem` is NOT contained today. This test now (a) drops the two dead imports + the three
//   obsolete tests, (b) keeps the still-valid public-not-contained case, and (c) ADDS the missing
//   `_*`-prefixed POSITIVE that the old test lacked (its test 1 only exercised the now-wrong kebab path).
//   We deliberately do NOT re-implement the reverted visibility scanner (option b — larger, out of scope).
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isContained,
  isPatternAllowlisted,
  relativeToClaudeRoot,
  CONTAINMENT_ZONES,
  PATTERN_ALLOWLIST_FILES,
} from "./containment-zones";

const ROOT = join(homedir(), ".claude");
const skill = (rel: string) => join(ROOT, "skills", rel);

describe("private-skills zone — underscore-prefixed only (skills/_*/**)", () => {
  test("(N-c) an `_*`-prefixed private skill IS contained", () => {
    // The positive the pre-13.6 test never had — its only private case used the (now-wrong) kebab name.
    expect(isContained(skill("_PAI/TOOLS/ShadowRelease.ts"), ROOT)).toBe(true);
    expect(isContained(skill("_private/Tools/secret.ts"), ROOT)).toBe(true);
  });

  test("a kebab (non-underscore) skill is NOT contained — the reverted visibility feature", () => {
    // Documents the revert: the old test wrongly expected these `=== true`. The current zone is
    // `skills/_*/**`, so a public/kebab skill name falls OUTSIDE containment. Guards the revert.
    expect(isContained(skill("loom-ecosystem/SKILL.md"), ROOT)).toBe(false);
    expect(isContained(skill("credential-handler/Tools/CredentialHandler"), ROOT)).toBe(false);
  });

  test("a public skill is NOT contained (kept from the original)", () => {
    expect(isContained(skill("Research/SKILL.md"), ROOT)).toBe(false);
  });
});

describe("other zones (spot checks against the live CONTAINMENT_ZONES)", () => {
  test("PAI/USER/** and PAI/MEMORY/** are contained", () => {
    expect(isContained(join(ROOT, "PAI/USER/PRINCIPAL_IDENTITY.md"), ROOT)).toBe(true);
    expect(isContained(join(ROOT, "PAI/MEMORY/WORK/x/ISA.md"), ROOT)).toBe(true);
  });

  test("settings.json (config-secrets, a bare non-glob pattern) is contained", () => {
    expect(isContained(join(ROOT, "settings.json"), ROOT)).toBe(true);
  });

  test("a path outside every zone is NOT contained", () => {
    expect(isContained(join(ROOT, "commands/some-command.md"), ROOT)).toBe(false);
  });
});

describe("relativeToClaudeRoot + isPatternAllowlisted", () => {
  test("relativeToClaudeRoot strips the CLAUDE_ROOT prefix", () => {
    expect(relativeToClaudeRoot(join(ROOT, "hooks/lib/containment-zones.ts"), ROOT)).toBe(
      "hooks/lib/containment-zones.ts",
    );
    expect(relativeToClaudeRoot(ROOT, ROOT)).toBe("");
  });

  test("a path outside CLAUDE_ROOT is returned unchanged", () => {
    expect(relativeToClaudeRoot("/Users/someone/Projects/x.ts", ROOT)).toBe("/Users/someone/Projects/x.ts");
  });

  test("isPatternAllowlisted matches a known allowlist file (relative path)", () => {
    expect(isPatternAllowlisted("hooks/ContainmentGuard.hook.ts")).toBe(true);
    expect(isPatternAllowlisted("hooks/lib/containment-zones.ts")).toBe(true);
    expect(isPatternAllowlisted("hooks/not/allowlisted.ts")).toBe(false);
  });
});

describe("zone/allowlist tables are non-empty (guards an accidental wipe)", () => {
  test("CONTAINMENT_ZONES and PATTERN_ALLOWLIST_FILES both have entries", () => {
    expect(CONTAINMENT_ZONES.length).toBeGreaterThan(0);
    expect(PATTERN_ALLOWLIST_FILES.length).toBeGreaterThan(0);
    // private-skills zone still exists and is underscore-scoped (the crux of the revert).
    const priv = CONTAINMENT_ZONES.find((z) => z.name === "private-skills");
    expect(priv?.patterns).toContain("skills/_*/**");
  });
});
