// core — pure, runtime-agnostic vocabulary. No Bun-only or Obsidian-only imports here.
// Both `report` (Bun → markdown string) and `cn` (Obsidian → DOM) build on this.

export { cite } from "./cite";
export { GLYPH, NO_ACTION, severity, type Severity } from "./severity";
export { shouldColorize } from "./colorize";
export { emptyCounts, statusLine, type Counts } from "./status";
export { classify, toResult, type Classified, type Result } from "./result";
export { configValue, tryParse } from "./config";
export { extractJson, parseFrontmatter, parseNdjson } from "./parse";
