// PROOF-ONLY SHIM (Story 13.3, Option A) — NOT deployed.
// Reproduces the `ParsedTranscript` type + `parseTranscript()` surface of ~/.claude/PAI/TOOLS/
// TranscriptParser.ts that IntegrityCheck (value: parseTranscript) and DocCrossRefIntegrity /
// SystemIntegrity (type-only: ParsedTranscript) consume. Frozen — the rewrites keep importing
// `../PAI/TOOLS/TranscriptParser` / `../../PAI/TOOLS/TranscriptParser` by the identical relative string.
// Nested StructuredResponse/ResponseState kept permissive — the rewrites treat ParsedTranscript opaquely
// (pass-through to handleSystemIntegrity / buildInferenceContext), so field-exact shapes aren't needed.
export type ResponseState = string;
export type StructuredResponse = Record<string, unknown>;

export interface ParsedTranscript {
  raw: string;
  lastMessage: string;
  currentResponseText: string;
  voiceCompletion: string;
  plainCompletion: string;
  structured: StructuredResponse;
  responseState: ResponseState;
}

/** Real impl reads + parses the JSONL transcript. Proof never invokes it on the happy path. */
export function parseTranscript(_transcriptPath: string): ParsedTranscript {
  return {
    raw: "",
    lastMessage: "",
    currentResponseText: "",
    voiceCompletion: "",
    plainCompletion: "",
    structured: {},
    responseState: "",
  };
}
