// Story 1.3 — the edge dispatcher (FR4, NK-1.7). The DOM-TYPED half of routing.
//
// ⚠️-4, THE RULE THIS FILE EXISTS TO OBEY: `Renderer` returns an `HTMLElement`, so it is DOM-typed,
// so it must NEVER be re-exported through `src/notekit/index.ts` (Story 1.4's package barrel). That
// barrel is typechecked under the ROOT config, which has no DOM lib — one `export type { Renderer }`
// there drags this file into the root program and fails `TS2304: Cannot find name 'HTMLElement'`.
// `import type` does not save it; tsc loads and checks the file either way. The estate hit exactly
// this trap once already, at `src/cli/dashkit-deploy.ts`.
//
// So routing is split along the DOM line, and the DOM-free half lives one directory up:
//
//   ../core-registry.ts   nk-type → template → renderer ID   (plain strings; Story 1.4 exports THIS)
//   this file             renderer ID → Renderer             (DOM-typed; never leaves `edge/`)
//
// The id indirection is not ceremony — it is what lets the caller-local `notekit.config.ts` name a
// renderer without importing one, keeping the vault's config file DOM-free and compiler-checkable
// against a type the root program can actually see.
//
// `dispatch` shares its name with `core.dispatch` (the CLI argument router, `src/core/args.ts`).
// Different module, different job, and neither is re-exported into the other's namespace; the
// single-source gate tracks the shared vocabulary (`cite`/`severity`/`stat`/`counts`), which this is
// not. Named for what it does in the story's own words, rather than renamed to dodge a collision
// that does not exist.

import { resolveTemplate } from "../core-registry";
import type { NoteTypeRegistry, RendererId } from "../core-registry";
import type { RenderSpec } from "../core-renderspec";
import { renderCardDom } from "./nkcard";

/**
 * A renderer: a validated RenderSpec in, a detached element out. DOM-typed — EDGE-INTERNAL, never
 * re-exported through the package barrel (see the header).
 */
export type Renderer = (spec: RenderSpec) => HTMLElement;

/**
 * The renderer table — the one place a renderer ID becomes a function. v1 has exactly one entry
 * (D2 / SM-C1: a second renderer waits for a real note that a card cannot express); FR15's
 * primer/protocol/pattern note types are three TEMPLATES over this one renderer, which is what the
 * registry's middle level is for.
 */
// ⚠ EXPORTED FOR ONE READER: `renderer-count.test.ts`, the SM-C1 scan. The alternative was a gate that
// regex-scrapes this object literal out of the source text, which would silently change what it counts
// on a reformat or a computed key — an unfailable gate. Enumeration cannot drift. The token costs
// nothing at the package surface because the test imports it from `./dispatch` DIRECTLY; re-exporting it
// through `src/notekit/index.ts` would drag this DOM-typed file into the root program and fail TS2304
// (see the header).
export const RENDERERS: Readonly<Record<RendererId, Renderer>> = {
  "nk-card": renderCardDom,
};

/**
 * Resolve a renderer ID to its function, or `null` when nothing is registered under it.
 *
 * The lookup is OWN-PROPERTY, and that is the whole point of the function. A bare
 * `RENDERERS[id]` walks the prototype chain, so a config entry reading `renderer: "constructor"`
 * resolves to `Object` — a callable, returned as a valid `Renderer`, then invoked on the spec and its
 * result appended to the note. Story 1.1 shipped that exact bug in `validate`'s version table and
 * this is the same shape: a record indexed by a string that comes from a file the vault owns.
 */
export function rendererFor(id: RendererId): Renderer | null {
  if (typeof id !== "string" || id.length === 0) return null;
  if (!Object.prototype.hasOwnProperty.call(RENDERERS, id)) return null;
  const renderer = RENDERERS[id];
  return typeof renderer === "function" ? renderer : null;
}

/**
 * Route a fence info string's type to its renderer through the two registry levels (NK-1.7), or
 * `null` when the type is unregistered — the outcome AC #2 degrades on with a visible notice.
 *
 * The registry is an INJECTED argument (D4): the edge reads no config file, so nothing here knows a
 * vault path or a note-type name. Tests pass a fixture; the vault passes its `notekit.config.ts`
 * (Story 1.4). Total by construction — every failure on either level is `null`, never a throw, so a
 * config typo degrades the one card instead of taking out the note render.
 *
 * THE CALLER RESOLVES THE TEMPLATE TOO, AND THAT SECOND WALK STAYS. A combined `resolveRoute` returning
 * `{template, renderer}` would save it, and it is not worth taking: the two calls answer different
 * questions — `resolveTemplate` yields the RUBRIC, which is data the post-processor feeds to `core`
 * before any renderer is involved, while this yields the FUNCTION that draws the result. Collapsing
 * them ties a `core-registry` lookup to a DOM-typed return, on the one seam Story 1.4 builds its
 * exported, DOM-FREE config type over (⚠️-4). The cost avoided is a handful of own-property reads on a
 * small record, once per note render.
 */
export function dispatch(nkType: string, registry: NoteTypeRegistry): Renderer | null {
  const template = resolveTemplate(nkType, registry);
  return template === null ? null : rendererFor(template.renderer);
}
