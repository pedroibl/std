// cn tests — behaviour parity with the retired hand-authored vault file (Story 7.1 AC10).
//
// NO DOM DEPENDENCY. `bun test` has no DOM and devDeps stay at {@types/bun, typescript, yaml} (AC9), so
// this installs a hand-rolled minimal `document` on globalThis in beforeEach and restores it in
// afterEach. Assertions are on the resulting tree (class names, nesting, text) and on ensureStyles's
// id-guard — the renderer design is deferred (FR20 boundary-only), so these pin BEHAVIOUR, nothing more.
//
// This file is inside src/cn/, so it typechecks under src/cn/tsconfig.json (types: []) — which is why
// the stub is plain objects and never reaches for a Bun or node global.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ensureStyles, getDataview, statCard, statGrid } from "./index";

/** The minimal element shape cn touches: className, textContent, id, appendChild, children. */
interface StubEl {
  tag: string;
  className: string;
  textContent: string;
  id: string;
  children: StubEl[];
  appendChild(child: StubEl): StubEl;
}

function makeEl(tag: string): StubEl {
  const el: StubEl = {
    tag,
    className: "",
    textContent: "",
    id: "",
    children: [],
    appendChild(child: StubEl) {
      el.children.push(child);
      return child;
    },
  };
  return el;
}

function makeStubDoc() {
  const head = makeEl("head");
  return {
    head,
    createElement: (tag: string) => makeEl(tag),
    // Only ensureStyles's id-guard uses this: scan what has actually been appended to head.
    getElementById: (id: string) => head.children.find((c) => c.id === id) ?? null,
  };
}

/** Narrow an element from the stub tree back to StubEl for assertions. */
const as = (el: unknown) => el as unknown as StubEl;

const prev = (globalThis as Record<string, unknown>)["document"];
let doc: ReturnType<typeof makeStubDoc>;

beforeEach(() => {
  doc = makeStubDoc();
  (globalThis as Record<string, unknown>)["document"] = doc;
});

afterEach(() => {
  (globalThis as Record<string, unknown>)["document"] = prev;
});

describe("getDataview", () => {
  test("returns the api when the plugin is loaded", () => {
    const api = { pages: () => [], date: (d: unknown) => d };
    expect(getDataview({ plugins: { plugins: { dataview: { api } } } })).toBe(api);
  });

  test("returns null when the plugin is absent, and on a null app", () => {
    expect(getDataview({ plugins: { plugins: {} } })).toBeNull();
    expect(getDataview(null)).toBeNull();
    expect(getDataview(undefined)).toBeNull();
  });
});

describe("statCard", () => {
  test("appends a cn-stat-card holding value then label", () => {
    const container = makeEl("div");
    const card = as(statCard(container as unknown as HTMLElement, { label: "Open", value: 7 }));

    expect(container.children).toHaveLength(1);
    expect(card.className).toBe("cn-stat-card");
    expect(card.children.map((c) => c.className)).toEqual(["cn-stat-value", "cn-stat-label"]);
    expect(card.children[0]!.textContent).toBe("7"); // number stringified
    expect(card.children[1]!.textContent).toBe("Open");
  });

  test("appends cn-stat-hint only when a hint is given", () => {
    const container = makeEl("div");
    const withHint = as(
      statCard(container as unknown as HTMLElement, { label: "L", value: "v", hint: "since Tue" }),
    );
    expect(withHint.children.map((c) => c.className)).toEqual([
      "cn-stat-value",
      "cn-stat-label",
      "cn-stat-hint",
    ]);
    expect(withHint.children[2]!.textContent).toBe("since Tue");

    // Empty-string hint is falsy — parity with the original `if (opts.hint)` guard.
    const noHint = as(statCard(container as unknown as HTMLElement, { label: "L", value: "v", hint: "" }));
    expect(noHint.children).toHaveLength(2);
  });
});

describe("statGrid", () => {
  test("wraps one cn-stat-card per stat in a cn-stat-grid", () => {
    const container = makeEl("div");
    const grid = as(
      statGrid(container as unknown as HTMLElement, [
        { label: "A", value: 1 },
        { label: "B", value: 2 },
        { label: "C", value: 3 },
      ]),
    );

    expect(grid.className).toBe("cn-stat-grid");
    expect(grid.children).toHaveLength(3);
    expect(grid.children.every((c) => c.className === "cn-stat-card")).toBe(true);
    expect(grid.children.map((c) => c.children[1]!.textContent)).toEqual(["A", "B", "C"]);
  });

  test("an empty stats array still produces the grid, with no cards", () => {
    const container = makeEl("div");
    const grid = as(statGrid(container as unknown as HTMLElement, []));
    expect(grid.className).toBe("cn-stat-grid");
    expect(grid.children).toHaveLength(0);
  });
});

describe("ensureStyles", () => {
  test("appends one <style> carrying the cn- rules", () => {
    ensureStyles();
    expect(doc.head.children).toHaveLength(1);
    const style = doc.head.children[0]!;
    expect(style.tag).toBe("style");
    expect(style.id).toBe("cn-base-styles");
    expect(style.textContent).toContain(".cn-stat-grid");
    expect(style.textContent).toContain(".cn-stat-card");
    expect(style.textContent).toContain(".cn-stat-value");
    expect(style.textContent).toContain(".cn-stat-label");
    expect(style.textContent).toContain(".cn-stat-hint");
  });

  test("is id-guarded — calling it twice appends exactly one <style>", () => {
    ensureStyles();
    ensureStyles();
    ensureStyles();
    expect(doc.head.children).toHaveLength(1);
  });

  test("a distinct id gets its own <style> (the guard is per-id, not global)", () => {
    ensureStyles();
    ensureStyles("cn-other-styles");
    ensureStyles("cn-other-styles");
    expect(doc.head.children.map((c) => c.id)).toEqual(["cn-base-styles", "cn-other-styles"]);
  });
});
