// PROOF-ONLY SHIM (Story 13.3, Option A) — NOT deployed.
// Reproduces the `getIdentity()` surface of ~/.claude/hooks/lib/identity.ts that DocCrossRefIntegrity
// consumes (only `mainDAVoiceID` is read, for the Pulse voice call). Frozen module (AC7). The DEPLOYED
// handler imports the REAL `../lib/identity` by the identical string; this copy exists ONLY for the proof.
export interface Identity {
  name: string;
  fullName: string;
  displayName: string;
  mainDAVoiceID: string;
  color: string;
}

export function getIdentity(): Identity {
  // Caller-local default = Pedro's actual DA (memory pai-template-defaults-are-pedros-data — `tome`,
  // never the template's `kai`). The proof never asserts on the value; the real lib reads settings.json.
  return {
    name: "Tomé",
    fullName: "Tomé",
    displayName: "Tomé",
    mainDAVoiceID: "21m00Tcm4TlvDq8ikWAM",
    color: "#3B82F6",
  };
}

// ── Observability config surface (added Story 13.3 for observability-transport.ts) ──
// Faithful signatures of ~/.claude/hooks/lib/identity.ts's observability exports; the rewrite consumes
// `ObservabilityTarget` (type) + `getObservabilityConfig()`. Real impl reads settings.json → observability.
export interface ObservabilityTarget {
  name: string;
  type: 'http' | 'cloudflare-kv';
  url?: string;
  headers?: Record<string, string>;
}

export interface ObservabilityConfig {
  targets: ObservabilityTarget[];
  server?: { port: number; enabled: boolean };
}

/** Default single local HTTP target (Pulse on :31337). Real impl merges settings.json overrides. */
export function getObservabilityConfig(): ObservabilityConfig {
  return {
    targets: [{ type: 'http' as const, url: 'http://localhost:31337', name: 'local' }],
    server: { port: 31337, enabled: true },
  };
}
