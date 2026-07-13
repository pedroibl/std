// stdio — Bun-edge stdin/stdout JSON framing (AD-9 plumbing topology; Story 13.2 / AD-9.4 Rule 1).
// Public surface: `readStdinJson` (read side). The write side (`writeStdoutJson`/`respondJson`) is
// deferred until a hook rewrite confirms the stdout-envelope idiom converges (AD-9.4 Rule 1.3).
export { readStdinJson } from "./read";
