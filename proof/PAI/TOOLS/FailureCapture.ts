// PROOF-ONLY SHIM (Story 13.4, Option A) — NOT deployed.
// Reproduces the `captureFailure()` surface of ~/.claude/PAI/TOOLS/FailureCapture.ts that
// SatisfactionCapture consumes (rating ≤3 → write a FAILURES artifact). Kept AS A PAI TOOL (NOT routed
// through std) — the rewrite still imports `../PAI/TOOLS/FailureCapture` by the identical relative
// string; this copy exists ONLY so proof/hooks/SatisfactionCapture.hook.ts typechecks. Signatures faithful.
export interface FailureCaptureInput {
  transcriptPath: string;
  rating: number;
  sentimentSummary: string;
  detailedContext?: string;
  sessionId?: string;
}

/** Real impl reads the transcript + writes a FAILURES artifact for ratings 1-3. The proof never invokes
 *  it on the happy path (the null-stdin fire test exits 0 before any rating is computed). */
export async function captureFailure(_input: FailureCaptureInput): Promise<string | null> {
  return null;
}
