// cn-verify — check a vault against cn's declared plugin envelope (AD-6).
//
//   std cn verify --vault <dir>
//
// THIN WIRING over the promoted engine (Story 8.4 D-2). Everything edge-agnostic — the vault read
// (`readVaultPlugins`), the fixed line format (`renderFindings`), the fail-loud error type, and the
// `0|1|2` dispatch (`runVerify`) — now lives in `./edge-verify` and is SHARED with `dashkit-verify.ts`.
// This file supplies only cn's `VerifySpec` (`{ edge: "cn", contract: CN_PLUGIN_CONTRACT }`) and
// re-exposes the cn-bound surface the tests and `cn-deploy.ts` already import from `./cn-verify`.
//
// The vault READ and dispatch are a Bun edge; the CONTRACT and the COMPARATOR are pure and live in
// `src/cn/plugins.ts` (data) + `src/core/plugin-contract.ts` (comparator). Putting fs code in `src/cn/`
// would drag it into the graph `Bun.build` walks and ship it inside the deployed vault artifact.
//
// IDENTITY-FREE (D4/NFR3). The vault path arrives only as `--vault`.

import { CN_PLUGIN_CONTRACT } from "../cn/plugins";
import {
  type EdgeVerifyDeps,
  EdgeVerifyError,
  readVaultPlugins,
  renderFindings,
  runVerify,
} from "./edge-verify";

/**
 * cn's verify-error type, kept as an alias of the promoted `EdgeVerifyError` so `toThrow(CnVerifyError)`
 * and every `instanceof` in the tests keep matching the class the engine actually throws (SAME class).
 */
export { EdgeVerifyError as CnVerifyError };
// Re-export the generic surface cn's tests and `cn-deploy.ts` already import from `./cn-verify`, so the
// promotion is import-path-transparent to them (the test diff is the promotion, not an assertion change).
export { readVaultPlugins, renderFindings };
/** The deps shape `main.ts` threads through for the `cn verify` callsite. */
export type CnVerifyDeps = EdgeVerifyDeps;

/**
 * `std cn verify --vault <dir>`. Returns a process exit code, mirroring `cn deploy`'s contract exactly:
 * 0 ok, 1 fail-loud, 2 usage (a missing `--vault` is usage; every other guard is a real failure). A thin
 * delegate to the promoted engine, wired with cn's edge label + contract (D-2/D-3).
 */
export function runCnVerify(argv: string[], deps: CnVerifyDeps = {}): number {
  return runVerify({ edge: "cn", contract: CN_PLUGIN_CONTRACT }, argv, deps);
}
