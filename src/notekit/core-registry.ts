// Story 1.3 — the note-type registry: the DOM-FREE half of dispatch (NK-1.7). Pure (D1): zero
// node:*/fs/DOM/network, no process/document refs. Lives beside the other `core-*` files, and the
// `core-` filename prefix puts it under `check:core-purity` (scripts/check-core-purity.ts PURE_GLOBS).
//
// WHY THIS IS A `core-*` FILE AND NOT AN `edge/` ONE — this is ⚠️-4, structurally resolved.
// `edge/**` is excluded from the root (no-DOM) tsconfig, so anything Story 1.4's barrel
// (`src/notekit/index.ts`) re-exports must NOT live there: a single `export type { … } from
// "./edge/dispatch"` drags `edge/dispatch.ts` into the root program, where the DOM-typed `Renderer`
// fails `TS2304: Cannot find name 'HTMLElement'`. `import type` does not save it — tsc still loads
// and checks the file. The estate documents the same trap at `src/cli/dashkit-deploy.ts`. So the
// split runs exactly along the DOM line:
//
//   here (DOM-free, root-typechecked, exportable)   the note-type → template → renderer-ID map
//   edge/dispatch.ts (DOM-typed, edge-only)         renderer ID → the function that returns an element
//
// Story 1.4's `notekit.config` type describes THIS shape and never forks it — the same no-fork
// discipline Story 1.2 set for `NkNode`.
//
// TOTALITY: every lookup here is TOTAL — an unusable registry, an unknown type, a malformed template
// all return `null`, never a throw. That is not laxness, it is the modeled outcome: `null` IS the
// "unknown type" state the edge degrades on (FR4 — a visible, non-corrupting notice), so the edge's
// "never throw into the note" contract holds by construction rather than by a `try` at the top. It is
// the opposite call from `cardTree`, which throws on a non-object spec, and deliberately so: there,
// a bad spec means the caller skipped `validate` and there is no designed degrade; here, "no template
// for this type" is a first-class outcome the ACs name.
//
// Every read is OWN-PROPERTY. A bare `registry.noteTypes[nkType]` walks the prototype chain, so a
// note whose fence reads ```nk-constructor``` would resolve to `Object` — a function returned as if
// it were a registered template. That is the same class of bug Story 1.1 shipped in `validate`'s
// branch table (`version: "constructor"` returned `{ok:true}` on an unvalidated object), and the
// registry is the identical shape: a plain record indexed by a string that comes from the note.

import type { Rubric } from "./core-renderspec";

/** The id of a renderer. Resolved to a DOM-typed function EDGE-side; a plain string here (⚠️-4). */
export type RendererId = string;

/** The id of a template — the middle level of the two-level route (NK-1.7). */
export type TemplateId = string;

/**
 * One template: which renderer draws it, and the rubric that selects the fence fields it shows.
 * `Rubric` is DOM-free (`core-renderspec.ts`), so this whole type stays root-typecheckable.
 *
 * The rubric lives HERE, on the template, rather than arriving as a separate post-processor argument,
 * because NK-1.7 pins "the SINGLE registry is the caller-local note-type registry". Splitting the
 * rubric into a second injected map would give the vault two registries to keep in step, which is the
 * drift NK-1.7 exists to prevent.
 */
export type NoteTypeTemplate = {
  renderer: RendererId;
  rubric: Rubric;
};

/**
 * The caller-local note-type registry (D4 — caller-local, never in `src/`; the real file is the
 * vault's `notekit.config.ts`, Story 1.4). Two levels, exactly as NK-1.7 pins them:
 *
 *   noteTypes:  "card" → "catalog-card"        the fence info string's type → a template id
 *   templates:  "catalog-card" → { renderer: "nk-card", rubric }
 *
 * The middle level is what lets FR15's primer/protocol/pattern note types be three templates over the
 * ONE `nk-card` renderer (SM-C1: v1 ships no second renderer, D2).
 */
export type NoteTypeRegistry = {
  noteTypes: Readonly<Record<string, TemplateId>>;
  templates: Readonly<Record<TemplateId, NoteTypeTemplate>>;
};

/** Read a property as DATA — own properties only, so no inherited name can masquerade as an entry. */
function own(record: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

/** An own property that is a plain object (not null, not an array) — the shape a level must have. */
function ownRecord(source: unknown, key: string): object | null {
  if (typeof source !== "object" || source === null) return null;
  const value = own(source, key);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

/**
 * Resolve a fence info string's type through both levels of the registry, or `null` when it is not
 * registered — the "unknown type" outcome AC #2 degrades on.
 *
 * `null` is returned rather than thrown for every failure mode, including a registry that is not a
 * registry at all: the caller here is the vault post-processor, and a throw from a config typo would
 * take out the whole note render. The template is shape-checked before it is handed back, so a
 * half-written entry (`renderer: 42`, a missing rubric) reads as unregistered instead of reaching the
 * renderer table and failing further downstream where the message would name nothing useful.
 */
export function resolveTemplate(nkType: string, registry: NoteTypeRegistry): NoteTypeTemplate | null {
  if (typeof nkType !== "string" || nkType.length === 0) return null;

  const noteTypes = ownRecord(registry, "noteTypes");
  if (noteTypes === null) return null;
  const templateId = own(noteTypes, nkType);
  if (typeof templateId !== "string" || templateId.length === 0) return null;

  const templates = ownRecord(registry, "templates");
  if (templates === null) return null;
  const template = own(templates, templateId);
  if (typeof template !== "object" || template === null || Array.isArray(template)) return null;

  const renderer = own(template, "renderer");
  if (typeof renderer !== "string" || renderer.length === 0) return null;
  const rubric = own(template, "rubric");
  if (typeof rubric !== "object" || rubric === null || Array.isArray(rubric)) return null;

  // Rebuilt rather than passed through, so the returned value carries exactly the two properties this
  // type declares — a registry entry with extra keys cannot smuggle one into the render path.
  return { renderer, rubric: rubric as Rubric };
}
