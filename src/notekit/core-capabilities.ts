// Story 2.1 — the capabilities catalog generator (NK-1.7, FR-11). Pure (D1): zero node:*/fs/DOM/
// network, no process/document refs.
//
// THE FILENAME IS LOAD-BEARING. `check:core-purity` globs `src/notekit/core-*.ts`
// (scripts/check-core-purity.ts PURE_GLOBS), so a file named `capabilities.ts` — which is what the
// architecture spine's Structural Seed sketches — would sit OUTSIDE the purity gate. A pure generator
// outside the purity gate is a purity breach waiting to happen, so the `core-` prefix stays.
//
// THE GENERATOR IS NOT A SECOND REGISTRY (NK-1.7). It reads the SAME caller-local `NoteTypeRegistry`
// that `resolveTemplate` routes on, and it resolves every entry THROUGH `resolveTemplate` rather than
// re-walking the two levels itself. That is what makes NFR5 true by construction rather than by
// discipline: a note type the dispatcher cannot route is a note type the catalog cannot list, and a
// type absent from the registry is absent from the catalog. Two walkers would be two answers.
//
// TOTALITY, like the registry it reads: every malformed shape DEGRADES — a registry that is not a
// registry yields an empty catalog, an entry that will not resolve is omitted — and nothing throws.
// `notekit capabilities` therefore has no failure verdict to report, which is why its exit set is
// {0, 2} and never 1.

import { resolveTemplate, type NoteTypeRegistry } from "./core-registry";
import type { RubricField } from "./core-renderspec";

/**
 * The catalog schema version. ADDITIVE, BRANCH-PER-VERSION (spine #NK-1 rule 6, the discipline
 * `NK_BRANCHES` already embodies in `core-renderspec.ts`): inside `nk-cap-v1` a field may be ADDED but
 * never renamed or removed, because Story 2.3's dispatcher and Epic 3's `doctor` read this shape. A
 * breaking change ships as `nk-cap-v2` BESIDE this, never as an edit to it.
 */
export const CATALOG_VERSION = "nk-cap-v1";

/** One advertised field: the fence key the card reads, and the label it renders under. */
export type CapabilitiesField = { key: string; label: string };

/**
 * One advertised note type. `fields` are the required FENCE fields, not frontmatter keys — NK-1.8
 * rules 1-2 put card field values in the nk-fence body and leave frontmatter carrying only the
 * `nk-type:` opt-in, so a "required frontmatter" list would name a source the render seam never reads.
 * The epic's AC wording predates that ruling; the spine governs and the divergence is declared.
 */
export type CapabilitiesNoteType = {
  nkType: string;
  templateId: string;
  renderer: string;
  titleField: string;
  fields: CapabilitiesField[];
};

/** What `notekit capabilities` emits: the whole advertised surface, JSON round-trippable. */
export type CapabilitiesCatalog = {
  catalogVersion: typeof CATALOG_VERSION;
  noteTypes: CapabilitiesNoteType[];
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
 * Project a rubric's field list onto the advertised rows, OWN INDICES ONLY — the `ownIndex` discipline
 * `core-renderspec.ts` states in full: `map`/spread/`every` all resolve an index through the prototype
 * chain, so a hole in a sparse `fields` array reads as a present element with `Array.prototype[n]`
 * poisoned, and a phantom row would enter the catalog.
 *
 * `label` defaults to `key` — the EXACT default `noteToRenderSpec` applies — so the catalog advertises
 * the label the card will actually render. Leaving it `undefined` would make `JSON.stringify` drop the
 * key entirely, breaking both the row shape and the round-trip promise.
 */
function advertisedFields(rubric: object): CapabilitiesField[] {
  const raw = own(rubric, "fields");
  if (!Array.isArray(raw)) return [];
  const rows: CapabilitiesField[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(raw, i)) continue; // a hole contributes no row
    const entry = raw[i] as RubricField | undefined;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const key = own(entry, "key");
    if (typeof key !== "string") continue; // a non-string key selects nothing in the render seam
    const label = own(entry, "label");
    rows.push({ key, label: typeof label === "string" ? label : key });
  }
  return rows;
}

/**
 * Generate the capabilities catalog from the caller-local registry (FR-11, NFR5).
 *
 * Enumeration is `Object.keys` on the OWN `noteTypes` record, so nothing reachable through
 * `Object.prototype` becomes a note type. An OWN key literally named `"constructor"`/`"toString"` is a
 * DIFFERENT case and IS emitted: `resolveTemplate` reads through its own `own()` helper and routes it
 * normally, so a catalog that refused it would advertise a different set than the dispatcher accepts —
 * breaking the single-source identity this generator exists to guarantee.
 */
export function capabilities(registry: NoteTypeRegistry): CapabilitiesCatalog {
  const noteTypes = ownRecord(registry, "noteTypes");
  if (noteTypes === null) return { catalogVersion: CATALOG_VERSION, noteTypes: [] };

  const rows: CapabilitiesNoteType[] = [];
  for (const nkType of Object.keys(noteTypes)) {
    // `resolveTemplate` returns `{renderer, rubric}` and deliberately DISCARDS `templateId` (it
    // rebuilds its result so extra keys cannot smuggle through), but the catalog row carries it — so
    // the id is read straight off the own `noteTypes` entry and the row is emitted only when BOTH
    // resolve. Reconstructing the template by hand instead would be the second registry walk NK-1.7
    // forbids.
    const templateId = own(noteTypes, nkType);
    if (typeof templateId !== "string" || templateId.length === 0) continue;
    const template = resolveTemplate(nkType, registry);
    if (template === null) continue;

    // `Rubric` declares `titleField: string`; off-type data reaches here anyway, because
    // `resolveTemplate` shape-checks the rubric as an object and no further. An absent title is the
    // card's own modeled outcome (`validate` rejects an empty title), so the row is still advertised.
    const titleField = own(template.rubric, "titleField");
    rows.push({
      nkType,
      templateId,
      renderer: template.renderer,
      titleField: typeof titleField === "string" ? titleField : "",
      fields: advertisedFields(template.rubric),
    });
  }
  return { catalogVersion: CATALOG_VERSION, noteTypes: rows };
}
