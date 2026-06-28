// cli — the Tier-1, zero-dep dispatch edge (Bun). A consumer passes its manifest to `run`; the engine
// sequences the steps and shells out to the consumer's own scripts, reimplementing none of them (D3).
//
// The manifest is validated, versioned, serializable data (config.ts) — `discover`/`resolveConfigPath`/
// `load` find and reduce it; `run`/`dispatchSteps` branch only on the `kind`/`verdict` enums.

export {
  SCHEMA_VERSION,
  STEP_KINDS,
  defineConfig,
  discover,
  globalConfigPath,
  load,
  resolveConfigPath,
  validate,
  type Command,
  type Manifest,
  type Step,
  type StepKind,
  type Verdict,
} from "./config";

export {
  dispatchSteps,
  run,
  stepVerdict,
  verdictToExit,
  type DispatchOptions,
  type DispatchResult,
  type Exec,
} from "./dispatch";
