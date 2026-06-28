#!/usr/bin/env bun
// Reference entry point. Resolves the repo git-remote-first (the cwd repo's `origin`); set
// REPO_PATH=<owner/repo> to override. A per-repo wrapper can instead call run() with its own value:
//   import { run } from "std/glab";
//   process.exit(run(process.argv.slice(2), { repo: "owner/repo" }));

import { run } from "./index";

const override = process.env.REPO_PATH;
process.exit(run(process.argv.slice(2), override ? { repo: override } : {}));
