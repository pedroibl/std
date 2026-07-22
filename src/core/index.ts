// core — pure, runtime-agnostic vocabulary. No Bun-only or Obsidian-only imports here.
// Both `report` (Bun → markdown string) and `cn` (Obsidian → DOM) build on this.

export { dispatch, dispatchAsync, flagValue, hasFlag, positional } from "./args";
export { bar, type BarOpts } from "./bar";
export { cite } from "./cite";
export { GLYPH, NO_ACTION, severity, type Severity } from "./severity";
export { shouldColorize } from "./colorize";
export { emptyCounts, statusLine, type Counts } from "./status";
export { classify, toResult, type Classified, type Result } from "./result";
export { configValue, tryParse } from "./config";
export { dateParts, type DateParts, daysSince, isoDate, isoOffset } from "./date";
export { extractJson, parseFrontmatter, parseNdjson } from "./parse";
export {
  type PluginContractEntry,
  type PluginFinding,
  type PluginRole,
  type VaultPlugins,
  verifyPlugins,
} from "./plugin-contract";
export {
  collapse,
  contentHash,
  escapeHtml,
  escapeRegExp,
  normalizeTags,
  slugify,
  truncate,
} from "./text";
export {
  type Chunk,
  chunkContent,
  extractRelated,
  extractSection,
  extractWikilinks,
  findSection,
  getMetaField,
  insertInSection,
  type Related,
  type SectionBounds,
  type SectionRoot,
  sectionRootAt,
  sectionRoots,
} from "./markdown";
export {
  charOverlap,
  jaccard,
  type ScoreResult,
  type ScoreRule,
  scoreRules,
  tokenize,
} from "./similarity";
export {
  isClosed,
  isDone,
  isOpsKey,
  isProg,
  isStoryKey,
  parseOps,
  parseSprint,
  parseStatusMap,
  SPRINT_CLOSED,
  SPRINT_DONE,
  SPRINT_PROG,
  type SprintRow,
  type SprintSummary,
  summarize,
} from "./sprint";
