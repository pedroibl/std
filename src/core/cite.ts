/**
 * Wrap a source path in backticks: cite("a/b.ts") → "`a/b.ts`".
 *
 * Pure, no runtime deps, so it lives in core — both report (Bun) and cn (Obsidian) use it.
 * Originally from loom's report-builder.ts.
 */
export function cite(path: string): string {
  return `\`${path}\``;
}
