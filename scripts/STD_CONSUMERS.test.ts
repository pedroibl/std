import { test, expect } from "bun:test";
import { STD_CONSUMERS, consumerNames } from "./STD_CONSUMERS";

// AD-3 serialization invariant: sorted by name + one entry per name. This is what makes a same-name
// collision a real git merge conflict (and a programmatic failure here), never a silent merge.

// Deterministic, locale-independent ordering — code-point compare, NOT localeCompare (whose ICU
// collation can vary by environment and silently flip the "sorted" verdict). The registry is
// hand-ordered to match this exact comparator.
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

test("STD_CONSUMERS is non-empty (guards the per-item loops below against a vacuous pass)", () => {
  expect(STD_CONSUMERS.length).toBeGreaterThan(0);
});

test("STD_CONSUMERS names are unique (a duplicate = a promotion collision)", () => {
  const names = consumerNames();
  const seen = new Set<string>();
  const duplicates = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
  // Naming the offender makes a collision actionable instead of an opaque count mismatch.
  expect(duplicates).toEqual([]);
});

test("STD_CONSUMERS is sorted by name (so entries land in a stable, conflict-surfacing order)", () => {
  const names = consumerNames();
  const sorted = [...names].sort(byCodePoint);
  expect(names).toEqual(sorted);
});

test("STD_CONSUMERS records the two real bun-link cli callers that promoted std/cli", () => {
  const names = consumerNames();
  expect(names).toContain("loom");
  expect(names).toContain("zsh-planning");
});

test("every consumer links via bun link (NFR7 — never file:../)", () => {
  expect(STD_CONSUMERS.length).toBeGreaterThan(0);
  for (const c of STD_CONSUMERS) {
    expect(c.adopted).toBe("bun link");
  }
});

test("every consumer carries a non-blank name, repo, and surface", () => {
  expect(STD_CONSUMERS.length).toBeGreaterThan(0);
  for (const c of STD_CONSUMERS) {
    // trim() so a whitespace-only value ("   ") can't satisfy the field.
    expect(c.name.trim().length).toBeGreaterThan(0);
    expect(c.repo.trim().length).toBeGreaterThan(0);
    expect(c.surface.trim().length).toBeGreaterThan(0);
  }
});
