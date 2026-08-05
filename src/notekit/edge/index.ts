// notekit/edge — the EDGE barrel, and the deploy bundle's entrypoint (Story 1.4, FR12 / AD-5).
//
// ⚠️-1: this is NOT `src/notekit/index.ts`. That file is the `"./notekit"` package barrel and is
// typechecked under the root (no-DOM) config; THIS file is the DOM half and typechecks under
// `src/notekit/edge/tsconfig.json` (`lib: ["ESNext","DOM"]`, `types: []`). `std notekit deploy` names
// this path as `EdgeSpec.entrypoint` and hands it to `Bun.build`, which follows the imports BY PATH —
// no import edge from a root-typechecked file to `edge/**` ever forms, which is the whole point.
//
// Story 1.3 shipped `nkcard.ts` + `dispatch.ts` + `post-processor.ts` and NO barrel (its JS-Engine
// entry was `post-processor.ts` directly). Story 1.4 adds this one so the bundle has a single named
// entrypoint and the vault's loader glue has a single named surface to call.
//
// WHAT THE VAULT ACTUALLY CALLS is `postProcess` — one function, once per rendered note, with the
// note-type registry INJECTED (D4: the edge reads no config file and knows no vault path). The rest of
// the surface is exported because the bundle is the vault's ONLY copy of this vocabulary: a note that
// wants to preview a fence, validate a spec, or render a card to a string has nowhere else to get it.
// That mirrors `src/dashkit/index.ts`, which re-exports the `core` vocabulary it consumes for exactly
// the same reason.
//
// AD-8: nothing here imports `src/cn/**` or `src/dashkit/**`. Shared logic goes DOWN into `core`,
// never sideways between two edges of the same vault.

// ── the entry the vault's note-level host calls ───────────────────────────────────────────────────
export { postProcess } from "./post-processor";
export type { PostProcessInput, PostProcessResult } from "./post-processor";

// ── DOM rendering (the `nk-` element tree, and the styles it needs) ───────────────────────────────
export { ensureStyles, nkTreeToDom, renderCardDom } from "./nkcard";

// ── routing (renderer ID → the function that draws it) ────────────────────────────────────────────
export { dispatch, rendererFor } from "./dispatch";
export type { Renderer } from "./dispatch";

// ── the pure vocabulary, riding inside the bundle (there is no other copy in the vault) ───────────
export { parseFenceBody, serializeFenceBody } from "../core-fence";
export type { FenceFields } from "../core-fence";

export { NK_BRANCHES, makeValidate, noteToRenderSpec, validate } from "../core-renderspec";
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
} from "../core-renderspec";

export { cardTree, NK_MAX_DEPTH, NK_TAGS } from "../core-nknode";
export type { NkNode } from "../core-nknode";

export { nkTreeToHtml, renderCardHtml } from "../core-html";

export { resolveTemplate } from "../core-registry";
export type {
  NoteTypeRegistry,
  NoteTypeTemplate,
  RendererId,
  TemplateId,
} from "../core-registry";
