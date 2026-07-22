// dashkit-verify — check the note-report vault against dashkit's declared plugin envelope (AD-6).
//
//   std dashkit verify --vault <dir>
//
// THIN WIRING over the promoted engine (Story 8.4 D-2), the exact sibling of `cn-verify.ts`. Everything
// edge-agnostic — the vault read, the fixed line format, the fail-loud error type, and the `0|1|2` dispatch
// — lives in `./edge-verify` and is SHARED. This file supplies only dashkit's `VerifySpec`
// (`{ edge: "dashkit", contract: DASHKIT_PLUGIN_CONTRACT }`) and re-exposes the dashkit-bound surface.
//
// dashkit MUST NOT import cn (AD-8): both verify commands reach the SHARED `edge-verify` module and the
// pure `core` comparator, never each other. The CONTRACT + comparator are pure; only the vault READ is Bun.
//
// IDENTITY-FREE (D4/NFR3). The vault path arrives only as `--vault`.

import { DASHKIT_PLUGIN_CONTRACT } from "../dashkit/plugins";
import {
  type EdgeVerifyDeps,
  EdgeVerifyError,
  readVaultPlugins,
  renderFindings,
  runVerify,
} from "./edge-verify";

/**
 * dashkit's verify-error type, an alias of the promoted `EdgeVerifyError` (the SAME class the engine
 * throws) so `toThrow(DashkitVerifyError)` and every `instanceof` keep matching.
 */
export { EdgeVerifyError as DashkitVerifyError };
export { readVaultPlugins, renderFindings };
/** The deps shape `main.ts` threads through for the `dashkit verify` callsite. */
export type DashkitVerifyDeps = EdgeVerifyDeps;

/**
 * `std dashkit verify --vault <dir>`. Returns a process exit code, mirroring `dashkit deploy`'s contract
 * exactly: 0 ok, 1 fail-loud, 2 usage (a missing `--vault` is usage; every other guard is a real failure).
 * A thin delegate to the promoted engine, wired with dashkit's edge label + contract (D-2/D-3).
 */
export function runDashkitVerify(argv: string[], deps: DashkitVerifyDeps = {}): number {
  return runVerify({ edge: "dashkit", contract: DASHKIT_PLUGIN_CONTRACT }, argv, deps);
}
