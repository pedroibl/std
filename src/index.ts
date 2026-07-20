// std — Pedro's personal standard.
//
// Runtime split:
//   core   → pure vocabulary, no runtime   (cite, severity, stat, counts)
//   report → Bun → markdown string         (loom, sesh-harvest, scripts, functions)
//   cn     → Obsidian → DOM                 (CodeScript Toolkit + Dataview, `cn-` CSS prefix)
//   glab   → Bun → glab api wrapper
//
// Consumers import the slice they need: `import { cite } from "std/core"`.

export * from "./core/index";
