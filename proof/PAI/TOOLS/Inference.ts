// PROOF-ONLY SHIM (Story 13.3, Option A) — NOT deployed.
// Reproduces the `inference()` surface of ~/.claude/PAI/TOOLS/Inference.ts that DocCrossRefIntegrity
// consumes. AC5 mandate: the PAI Inference tool is KEPT AS-IS (NOT routed through std/http) — so the
// rewrite still imports `../../PAI/TOOLS/Inference` by the identical relative string; this copy exists
// ONLY so proof/hooks/handlers/DocCrossRefIntegrity.ts typechecks. Signatures copied verbatim.
export type InferenceLevel = "fast" | "standard" | "smart";

export interface InferenceOptions {
  systemPrompt: string;
  userPrompt: string;
  level?: InferenceLevel;
  expectJson?: boolean;
  timeout?: number;
  imagePaths?: string[];
}

export interface InferenceResult {
  success: boolean;
  output: string;
  parsed?: unknown;
  error?: string;
  latencyMs: number;
  level: InferenceLevel;
}

/** Real impl calls Anthropic (fallback OpenRouter). The proof never invokes it (DocCrossRef's inference
 *  path is not exercised by the hermetic tests, which drive the pure splitter/parse helpers). */
export async function inference(options: InferenceOptions): Promise<InferenceResult> {
  return { success: false, output: "", error: "proof shim", latencyMs: 0, level: options.level ?? "standard" };
}
