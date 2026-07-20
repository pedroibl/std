// cn — reusable helpers for "creative notes" (`cn-`) in the Obsidian vault this slice deploys to.
//
// SOURCE OF TRUTH (GIT-SoT / AD-5). This file is std's copy; the vault gets a generated bundle:
//   std cn deploy --vault <dir>   ->   <vault>/Scripts/cn.js
// Loaded in the vault via CodeScript Toolkit:
//   const cn = await require("/Scripts/cn.js");
// CST's `modulesRoot` is the vault root, so "/Scripts/..." resolves from there.
//
// OBSIDIAN EDGE (runtime boundary = module boundary): standard DOM only. No `node:*`, no fs, no Bun
// globals — `src/cn/tsconfig.json` sets `types: []` so a stray `process`/`Bun` is a compile error.
// Imports nothing from report/glab/cli/dashkit (D1, AD-8). The host plugin APIs (Dataview, CodeScript
// Toolkit) are runtime-provided and typed structurally here, so nothing external is ever bundled.
//
// Keep helpers pure and side-effect-free. Never eval() user input.
// All emitted markup uses the `cn-` class prefix to stay scoped.
//
// AD-2 (rule 3) IN CN'S TERMS: a std renderer renders the DECLARED record only. `statCard`'s parameter
// is the structural `{ label, value, hint? }` — a caller passing a wider object (a variable, which is
// how a caller-local field actually reaches std, since TS's excess-property check fires on literals
// only) assigns cleanly, and the extra field is invisible: the body reads three fields and emits three
// nodes. THAT INVISIBILITY IS THE FORCING FUNCTION, not an oversight — when a SECOND caller needs the
// same extra field, it earns promotion into the shared record. Until then it stays caller-local, and
// `src/core/status.ts`'s OQ1 stands: the per-item stat record is an edge concern with one caller, so it
// is deliberately NOT promoted into core (Rule of Three / D2). `index.test.ts` proves the invisibility
// is real rather than accidental.

/** The slice of Dataview's API cn uses. Structural — erases at build, never an import (AD-5 rule 3). */
export type DvApi = {
  pages: (source?: string) => any;
  date: (d: unknown) => any;
};

/** Resolve the Dataview API from the running app, or null if unavailable. */
export function getDataview(app: any): DvApi | null {
  return app?.plugins?.plugins?.dataview?.api ?? null;
}

/** Create a <div> with a class and optional text — standard DOM, no Obsidian augmentation. */
function div(parent: HTMLElement, cls: string, text?: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  parent.appendChild(el);
  return el;
}

/** Render a single stat card into a container element. */
export function statCard(
  container: HTMLElement,
  opts: { label: string; value: string | number; hint?: string },
): HTMLElement {
  const card = div(container, "cn-stat-card");
  div(card, "cn-stat-value", String(opts.value));
  div(card, "cn-stat-label", opts.label);
  if (opts.hint) div(card, "cn-stat-hint", opts.hint);
  return card;
}

/** Render a horizontal grid of stat cards. */
export function statGrid(
  container: HTMLElement,
  stats: Array<{ label: string; value: string | number; hint?: string }>,
): HTMLElement {
  const grid = div(container, "cn-stat-grid");
  for (const s of stats) statCard(grid, s);
  return grid;
}

/** Inject scoped styles once per note (id-guarded to avoid duplicates). */
export function ensureStyles(id = "cn-base-styles"): void {
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    .cn-stat-grid { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 0.5rem 0; }
    .cn-stat-card { flex: 1 1 120px; padding: 0.75rem 1rem; border-radius: 10px;
      background: var(--background-secondary); border: 1px solid var(--background-modifier-border); }
    .cn-stat-value { font-size: 1.6rem; font-weight: 700; line-height: 1.1; }
    .cn-stat-label { font-size: 0.8rem; opacity: 0.75; text-transform: uppercase; letter-spacing: 0.03em; }
    .cn-stat-hint { font-size: 0.75rem; opacity: 0.55; margin-top: 0.2rem; }
  `;
  document.head.appendChild(style);
}
