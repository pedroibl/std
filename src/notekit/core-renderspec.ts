// Story 1.1 — the RenderSpec: the single artifact crossing `core → edge` (NK-1). Pure (D1): zero
// node:*/fs/DOM/network, no process/document refs.
//
// Three things live here: the `nk-v1` RenderSpec type, the render seam (`noteToRenderSpec`), and
// `validate` with its per-version branch table. The rules this file encodes:
//
//   - The spec is plain JSON data — no functions, class instances, dates, or load-time-computed
//     values. `JSON.parse(JSON.stringify(spec))` deep-equals `spec` (NK-1 rule 1).
//   - The rubric is resolved BEFORE the seam and arrives as an argument, so the spec is already
//     field-selected — one spec yields one output on both the CLI-preview and vault-edge paths.
//     `core` never reads the caller-local note-type registry (NK-1 rule 2 / D4), and `kind` rides
//     the rubric: the caller resolved the note type from the fence info string before picking it.
//   - Field VALUES come from the nk-fence body (NK-1.8): the caller runs `parseFenceBody` and hands
//     the fields in. `core` never reads frontmatter — that carries only the `nk-type:` opt-in.
//   - Timestamps and ids are INJECTED arguments, never computed here (D4, snapshot determinism).
//   - Versioning is additive, branch-per-version (NK-1.6). The branch table is data, so an `nk-v2`
//     arm can be added without touching the `nk-v1` arm — and a test can prove it.
//   - Malformed input travels as `{ok:false,error}` naming the gap; anything unclassified is
//     RE-THROWN, never swallowed (the estate fail-loud doctrine, src/core/result.ts).
//
// v1 is deliberately thin: one `kind` (`card`), one version. No speculative keys (D2).

import { classify } from "../core";
import type { Classified, Result } from "../core";
import type { FenceFields } from "./core-fence";

/** The one shape the edge renders. Every value is plain JSON (NK-1 rule 1). */
export type RenderSpec = {
  version: "nk-v1";
  kind: "card";
  id: string;
  generatedAt: string;
  title: string;
  fields: RenderSpecField[];
};

/** A rendered row: the fence key it came from, its display label, and its value. */
export type RenderSpecField = { key: string; label: string; value: string | string[] };

/** One rubric entry — which fence key to show, and under what label (defaults to the key). */
export type RubricField = { key: string; label?: string };

/**
 * The caller-local field-selection rubric, injected as an argument (NK-1 rule 2 / D4). `kind` rides
 * here because the caller already resolved the note type from the fence info string; `core` is never
 * told it separately. `titleField` names the fence key that supplies the card's heading.
 */
export type Rubric = {
  kind: "card";
  titleField: string;
  fields: readonly RubricField[];
};

/** The values `core` must not compute for itself (D4, snapshot determinism). */
export type Injected = { id: string; generatedAt: string };

/** Copy list values so the spec never aliases the caller's array. */
function copyValue(value: string | string[]): string | string[] {
  return Array.isArray(value) ? [...value] : value;
}

/**
 * Read a fence field as DATA. `parseFenceBody` returns a null-prototype record, but a caller may
 * hand-build a plain object — and there `fields["constructor"]` would resolve to `Object` and get
 * copied into the spec as a function, which is not JSON. Own properties only.
 */
function fenceField(fields: FenceFields, key: string): string | string[] | undefined {
  return Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;
}

/**
 * The render seam: fence fields + injected rubric + injected ids → a versioned, field-selected
 * RenderSpec. A rubric key absent from the fence yields no row (the card just omits it); a missing
 * or empty title is left for `validate` to reject, so producing and checking stay separable.
 *
 * The 3-arg signature is fixed — Story 1.3's edge composes on it.
 */
export function noteToRenderSpec(
  fields: FenceFields,
  rubric: Rubric,
  injected: Injected,
): RenderSpec {
  const selected: RenderSpecField[] = [];
  for (const entry of rubric.fields) {
    const value = fenceField(fields, entry.key);
    if (value === undefined) continue;
    selected.push({ key: entry.key, label: entry.label ?? entry.key, value: copyValue(value) });
  }

  const rawTitle = fenceField(fields, rubric.titleField);
  const title =
    typeof rawTitle === "string" ? rawTitle : Array.isArray(rawTitle) ? rawTitle.join(", ") : "";

  return {
    version: "nk-v1",
    kind: rubric.kind,
    id: injected.id,
    generatedAt: injected.generatedAt,
    title,
    fields: selected,
  };
}

// ── validate ────────────────────────────────────────────────────────────────────────────────────

/** The malformed-input codes `validate` classifies. Anything else re-throws. */
export type RenderSpecErrorCode = "nk-missing-field" | "nk-unknown-version";

/**
 * The estate `Classified` payload plus the name of the gap (AC2: the error NAMES the missing field
 * or the version mismatch). `field` is the offending path — `"title"`, `"fields[1].value"`,
 * `"version"`.
 */
export type RenderSpecError = Classified<RenderSpecErrorCode> & { field: string };

const KNOWN_CODES = ["nk-missing-field", "nk-unknown-version"] as const;

/** Throw a classifiable violation — `code` feeds `classify`, `field` names the gap. */
function fail(code: RenderSpecErrorCode, field: string, message: string): never {
  throw Object.assign(new Error(message), { code, field });
}

/** Recover the `field` off a thrown violation (absent on anything we did not throw). */
function fieldOf(e: unknown): string {
  if (typeof e === "object" && e !== null && "field" in e) {
    const field = (e as { field: unknown }).field;
    if (typeof field === "string") return field;
  }
  return "";
}

/** A short, safe rendering of an unexpected value for an error message. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/**
 * `path` is what the error REPORTS; `key` is what we look up. They differ inside a field row, where
 * the property is `key`/`label` but the offending path is `fields[n].key` / `fields[n].label`.
 */
function requireNonEmptyString(
  candidate: Record<string, unknown>,
  key: string,
  path: string = key,
): string {
  const value = candidate[key];
  if (typeof value !== "string" || value.length === 0) {
    fail("nk-missing-field", path, `nk-v1 RenderSpec: "${path}" must be a non-empty string`);
  }
  return value;
}

/**
 * A dense array of strings. Indexed explicitly because `Array.prototype.every` SKIPS holes: a sparse
 * `new Array(1)` would satisfy `every` vacuously, and the hole then serializes to `null` — which
 * breaks the JSON round-trip the RenderSpec promises (NK-1 rule 1).
 */
function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) {
    if (!(i in value) || typeof value[i] !== "string") return false;
  }
  return true;
}

function requireFields(candidate: Record<string, unknown>): RenderSpecField[] {
  const raw = candidate.fields;
  if (!Array.isArray(raw)) {
    fail("nk-missing-field", "fields", `nk-v1 RenderSpec: "fields" must be an array`);
  }

  // Walked by index rather than `map` for the same reason as `isStringArray`: `map` skips holes and
  // COPIES them into its result, so a sparse `fields` would validate and then stringify to `[null]`.
  const rows: RenderSpecField[] = [];
  for (let index = 0; index < raw.length; index++) {
    const at = `fields[${index}]`;
    if (!(index in raw)) {
      fail("nk-missing-field", at, `nk-v1 RenderSpec: ${at} is missing — "fields" must be dense`);
    }
    const entry = raw[index];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail("nk-missing-field", at, `nk-v1 RenderSpec: ${at} must be an object`);
    }
    const row = entry as Record<string, unknown>;
    const key = requireNonEmptyString(row, "key", `${at}.key`);
    const label = requireNonEmptyString(row, "label", `${at}.label`);
    const value = row.value;
    if (typeof value !== "string" && !isStringArray(value)) {
      fail(
        "nk-missing-field",
        `${at}.value`,
        `nk-v1 RenderSpec: ${at}.value must be a string or a dense string[]`,
      );
    }
    rows.push({ key, label, value: copyValue(value as string | string[]) });
  }
  return rows;
}

/** The `nk-v1` schema branch. Additive versioning means this arm never changes when `nk-v2` lands. */
function branchV1(candidate: Record<string, unknown>): RenderSpec {
  if (candidate.kind !== "card") {
    fail(
      "nk-missing-field",
      "kind",
      `nk-v1 RenderSpec: "kind" must be "card", got ${describe(candidate.kind)}`,
    );
  }
  return {
    version: "nk-v1",
    kind: "card",
    id: requireNonEmptyString(candidate, "id"),
    generatedAt: requireNonEmptyString(candidate, "generatedAt"),
    title: requireNonEmptyString(candidate, "title"),
    fields: requireFields(candidate),
  };
}

/** One schema branch: validates a candidate already known to carry that `version`. */
export type VersionBranch = (candidate: Record<string, unknown>) => RenderSpec;

/** The branch table, keyed by `version` — additive by construction (NK-1.6). */
export type VersionBranches = Readonly<Record<string, VersionBranch | undefined>>;

/** The shipped branches. `nk-v2` would be a NEW key here, never an edit to `branchV1`. */
export const NK_BRANCHES: VersionBranches = { "nk-v1": branchV1 };

/** The versions a table can actually dispatch — own keys holding a function, in insertion order. */
function knownVersions(branches: VersionBranches): string[] {
  const table = branches as Record<string, unknown>;
  return Object.keys(table).filter((v) => typeof table[v] === "function");
}

function dispatch(candidate: unknown, branches: VersionBranches): RenderSpec {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    fail("nk-missing-field", "version", `RenderSpec must be an object, got ${describe(candidate)}`);
  }
  const record = candidate as Record<string, unknown>;
  const version = record.version;
  if (typeof version !== "string" || version.length === 0) {
    fail("nk-missing-field", "version", `RenderSpec is missing its "version" field`);
  }
  // A bare `branches[version]` lookup walks the PROTOTYPE CHAIN: `version: "constructor"` resolved
  // to `Object`, which was then called with the candidate and handed it back UNVALIDATED as
  // `{ok:true}` — a partial render, exactly what AC #2 forbids. `"toString"` returned the string
  // `"[object Undefined]"` as a RenderSpec; `"__proto__"`/`"valueOf"` crashed with a raw TypeError.
  // Require an OWN property holding a function, so every inherited name falls through to the
  // nk-unknown-version path like any other unrecognized version.
  const branch = Object.prototype.hasOwnProperty.call(branches, version)
    ? branches[version]
    : undefined;
  if (typeof branch !== "function") {
    fail(
      "nk-unknown-version",
      "version",
      `unrecognized RenderSpec version "${version}" — known: ${knownVersions(branches).join(", ")}`,
    );
  }
  return branch(record);
}

/**
 * Build a validator over a branch table. Exported so a caller (and the forward-compatibility
 * regression test) can add a version arm as DATA and prove the existing arms are untouched.
 */
export function makeValidate(
  branches: VersionBranches,
): (candidate: unknown) => Result<RenderSpec, RenderSpecError> {
  return (candidate) => {
    try {
      return { ok: true, value: dispatch(candidate, branches) };
    } catch (e) {
      // `classify` is the fail-loud gate: a known code becomes data, anything else RE-THROWS
      // (src/core/result.ts). `toResult` is not used here because it cannot carry the extra
      // `field` — this is the same contract with the offending path attached.
      return { ok: false, error: { ...classify(e, KNOWN_CODES), field: fieldOf(e) } };
    }
  };
}

/**
 * Validate a candidate RenderSpec. Malformed input → `{ok:false,error}` naming the missing field or
 * the version mismatch, never a partial render; an unexpected error propagates (fail-loud).
 */
export const validate = makeValidate(NK_BRANCHES);
