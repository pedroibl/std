// notekit — the `"./notekit"` package barrel (Story 1.4, FR14 / NK-1.2).
//
// ⚠️-1, THE ONE RULE THIS FILE EXISTS TO OBEY: **nothing from `./edge/**` may be re-exported here.**
//
// This file lives under the ROOT `tsconfig.json`, which is Bun-shaped (`lib: ["ESNext"]`, `types:
// ["bun"]`) and has NO DOM lib — that absence IS the compile-time barrier keeping DOM out of the pure
// half of the slice (root tsconfig `//exclude-notekit`). `src/notekit/edge/**` is excluded from that
// program precisely because it uses `document`/`HTMLElement`. A single `export … from "./edge/…"`
// here would drag those files back INTO the root program and fail `tsc` with `TS2304: Cannot find
// name 'HTMLElement'`. `export type` does not save it either — tsc still loads and checks the file.
// The estate already documents the identical trap at `src/cli/dashkit-deploy.ts:82`.
//
// So notekit is the estate's FIRST MIXED pure/edge slice, and its package barrel is NOT its deploy
// entrypoint:
//
//   src/notekit/index.ts       ← THIS FILE. The `"./notekit"` exports entry. Pure surface + the
//                                config TYPE. What a bun/node consumer and the vault's hand-authored
//                                `notekit.config.ts` import. Root-typechecked, DOM-free.
//   src/notekit/edge/index.ts  ← the deploy bundle's entrypoint, bundled BY PATH (never imported into
//                                a root-typechecked file), typechecked under `edge/tsconfig.json`.
//
// `cn` and `dashkit` are wholesale DOM edges, so for them the package barrel IS the entrypoint. Do not
// carry that assumption over: here they are two different files, and conflating them breaks the build.
//
// NO SECOND CONFIG TYPE (NK-1.2). Story 1.3 was forced to create `core-registry.ts` for exactly this
// reason — the registry had to be DOM-FREE so this barrel could export it — and the shape it defines
// (`nk-type → template → renderer-ID`, ids as plain strings) IS the config shape. `NotekitConfig` below
// is therefore an ALIAS of that one type, never a parallel declaration: a second `core-config.ts`
// stating the same fields would be the fork this note exists to prevent, and would drift the moment
// either side gained a field. The DOM-typed `Renderer` stays edge-internal by the same rule (⚠️-4).

export { createFence, locateFence, parseFenceBody, serializeFenceBody, spliceFence } from "./core-fence";
export type { FenceFields, LocatedFence } from "./core-fence";

export { CATALOG_VERSION, capabilities } from "./core-capabilities";
export type {
  CapabilitiesCatalog,
  CapabilitiesField,
  CapabilitiesNoteType,
} from "./core-capabilities";

export {
  NK_BRANCHES,
  makeValidate,
  noteToRenderSpec,
  validate,
} from "./core-renderspec";
export type {
  Injected,
  RenderSpec,
  RenderSpecError,
  RenderSpecErrorCode,
  RenderSpecField,
  Rubric,
  RubricField,
  VersionBranch,
  VersionBranches,
} from "./core-renderspec";

export { cardTree, NK_MAX_DEPTH, NK_TAGS } from "./core-nknode";
export type { NkNode } from "./core-nknode";

export { nkTreeToHtml, renderCardHtml } from "./core-html";

export { resolveTemplate } from "./core-registry";
export type {
  NoteTypeRegistry,
  NoteTypeTemplate,
  RendererId,
  TemplateId,
} from "./core-registry";

import type { NoteTypeRegistry } from "./core-registry";

/**
 * The type a caller-local `notekit.config.ts` is checked against (`satisfies NotekitConfig`) — FR13/
 * FR14, NK-1.2.
 *
 * An ALIAS of {@link NoteTypeRegistry}, deliberately: the registry the vault hand-authors and the
 * registry the edge dispatches over are the SAME value, so they must be the same type. The name exists
 * because a config file reading `satisfies NoteTypeRegistry` describes what the value is used FOR less
 * well than what it IS, and the vault author writes the config far more often than the dispatcher.
 *
 * ⚠ It is an alias and not a `type NotekitConfig = { noteTypes: …; templates: … }` restatement. A
 * restatement compiles identically today and diverges silently the first time either side gains a
 * field — and the file it would diverge from is the one the edge actually reads at runtime.
 *
 * DOM-FREE by construction (⚠️-1/⚠️-4): the renderer is named by a string ID here, and the edge
 * resolves that ID to a DOM-typed function on its own side. That indirection is what lets a vault
 * config name a renderer without importing one.
 */
export type NotekitConfig = NoteTypeRegistry;
