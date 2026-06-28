// cli — the Tier-1, zero-dep dispatch edge (Bun). A consumer passes its manifest to `run`; the engine
// sequences the steps and shells out to the consumer's own scripts, reimplementing none of them (D3).

export { dispatchSteps, run, type Command, type Exec, type Manifest, type Step } from "./dispatch";
