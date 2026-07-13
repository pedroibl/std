// PROOF-ONLY SHIM (Story 13.3, Option A) — NOT deployed.
// Reproduces the exported signatures of ~/.claude/hooks/lib/paths.ts that the 13.3 rewrites consume,
// so `proof/hooks/**` typechecks in isolation while the DEPLOYED hooks import the REAL `./lib/paths`
// by the identical relative string (byte-verbatim deploy holds). Frozen module (AD-9.4 Rule 3 / AC7) —
// paths.ts itself is untouched this story; this copy exists ONLY for the proof. Mirrors proof/isa-utils.ts.
import { homedir } from "node:os";
import { join } from "node:path";

export function expandPath(path: string): string {
  const home = homedir();
  return path
    .replace(/^\$HOME(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home)
    .replace(/^~(?=\/|$)/, home);
}

export function getPaiDir(): string {
  const envPaiDir = process.env.PAI_DIR;
  if (envPaiDir) return expandPath(envPaiDir);
  return join(homedir(), ".claude", "PAI");
}

export function getClaudeDir(): string {
  return join(homedir(), ".claude");
}

export function getSettingsPath(): string {
  return join(getClaudeDir(), "settings.json");
}

export function paiPath(...segments: string[]): string {
  return join(getPaiDir(), ...segments);
}

/** Authoritative .env path (~/.claude/.env). Added Story 13.3 for observability-transport's
 *  readEnvOrPaiEnv (DEFERRED dotenv parse — kept caller-local). Faithful to the real signature. */
export function getEnvPath(): string {
  return join(getClaudeDir(), ".env");
}
