// cli — the Tier-1, zero-dep dispatch edge (Bun). A consumer passes its manifest to `run`; the engine
// sequences the steps and shells out to the consumer's own scripts, reimplementing none of them (D3).
//
// The manifest is validated, versioned, serializable data (config.ts) — `discover`/`resolveConfigPath`/
// `load` find and reduce it; `run`/`dispatchSteps` branch only on the `kind`/`verdict` enums.

export {
  REVIEW_ADAPTERS,
  SCHEMA_VERSION,
  STEP_KINDS,
  defineConfig,
  discover,
  globalConfigPath,
  load,
  resolveConfigPath,
  validate,
  type AdapterStep,
  type Command,
  type ExecStep,
  type Manifest,
  type ReviewAdapter,
  type Step,
  type StepKind,
  type Verdict,
} from "./config";

export {
  adapterVerdict,
  defaultCapability,
  defaultAdapterExec,
  makeAdapterExec,
  makeResolver,
  resolveAdapter,
  type AdapterExec,
  type AdapterResolver,
  type Capability,
} from "./adapters";

export {
  HOSTS,
  detectHost,
  hostFromRemoteUrl,
  type DetectHostOptions,
  type Host,
} from "./host";

export {
  dispatchSteps,
  formatHelp,
  jsonResult,
  parseArgs,
  run,
  stepVerdict,
  verdictToExit,
  type DispatchOptions,
  type DispatchResult,
  type Exec,
  type JsonResult,
  type ParsedArgs,
} from "./dispatch";

export {
  NAV_NAME_GRAMMAR,
  RepoNavError,
  defaultTargets,
  generateRepoNav,
  generateStdCompletion,
  installAlias,
  runAlias,
  validateRegistry,
  type AliasDeps,
  type InstallOptions,
  type InstallResult,
  type InstallTargets,
  type RepoConfig,
  type RepoRegistry,
} from "./repo-nav";
