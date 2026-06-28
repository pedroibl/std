import { test, expect } from "bun:test";
import { STD_CONSUMERS, consumerNames } from "./STD_CONSUMERS";

// AD-3 serialization invariant: sorted by name + one entry per name. This is what makes a same-name
// collision a real git merge conflict (and a programmatic failure here), never a silent merge.

test("STD_CONSUMERS names are unique (a duplicate = a promotion collision)", () => {
  const names = consumerNames();
  expect(new Set(names).size).toBe(names.length);
});

test("STD_CONSUMERS is sorted by name (so entries land in a stable, conflict-surfacing order)", () => {
  const names = consumerNames();
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  expect(names).toEqual(sorted);
});

test("STD_CONSUMERS records the two real bun-link cli callers that promoted std/cli", () => {
  const names = consumerNames();
  expect(names).toContain("loom");
  expect(names).toContain("zsh-planning");
});

test("every consumer links via bun link (NFR7 — never file:../)", () => {
  for (const c of STD_CONSUMERS) {
    expect(c.adopted).toBe("bun link");
  }
});

test("every consumer carries name, repo, and a surface", () => {
  for (const c of STD_CONSUMERS) {
    expect(c.name.length).toBeGreaterThan(0);
    expect(c.repo.length).toBeGreaterThan(0);
    expect(c.surface.length).toBeGreaterThan(0);
  }
});
