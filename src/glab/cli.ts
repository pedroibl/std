#!/usr/bin/env bun
// Reference entry point. A per-repo wrapper mirrors this, passing its own repo:
//   import { run } from "std/glab";
//   process.exit(run(process.argv.slice(2), { repo: "pedroibl/loom" }));

import { run } from "./index";

const repo = process.env.REPO_PATH;
if (!repo) {
  console.error("set REPO_PATH=<owner/repo>, e.g. REPO_PATH=pedroibl/loom");
  process.exit(2);
}

process.exit(run(process.argv.slice(2), { repo }));
