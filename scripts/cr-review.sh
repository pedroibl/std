#!/usr/bin/env bash
# Local CodeRabbit review — mirrors the CI advisory gate (.gitlab-ci.yml `coderabbit-review`)
# but runs against your working tree. The API key is pulled from 1Password at call time so it
# is never pasted, stored in shell history, or committed.
#
#   key: op://development/coderabbit-type-agentic/credential   (agentic)
#
# The CLI requires an AGENTIC key — "user"-type keys are rejected with "User API keys are not
# supported for the CLI." Same key the pipeline uses (CODERABBIT_API_KEY); op is the single SoT.
#
# Usage:
#   scripts/cr-review.sh                 # review all local changes (committed + uncommitted)
#   scripts/cr-review.sh --base main     # review the current branch against main
#   bun run review:cr -- --base main     # same, via the package.json script
#
# Any extra args are passed straight through to `coderabbit review`.
#
# Note: if you have already run `coderabbit auth login` (browser OAuth), the plain
# `coderabbit review` works without this helper. Use this when you want op as the single
# source of truth for the key (fresh machine, CI parity, no stored session).
#
# Secret handling: the CLI has no env/file key input (only `--api-key`), so the key is passed
# in argv for the duration of the run — briefly readable via the process list on a shared host.
# On a single-user machine this is low-risk; for a zero-exposure path use browser OAuth above.
set -euo pipefail

command -v op >/dev/null 2>&1 || { echo "cr-review: 1Password CLI (op) not found on PATH" >&2; exit 1; }
command -v coderabbit >/dev/null 2>&1 || { echo "cr-review: coderabbit CLI not found — see https://cli.coderabbit.ai" >&2; exit 1; }

KEY="$(op read 'op://development/coderabbit-type-agentic/credential')"
exec coderabbit review --plain --api-key "$KEY" "$@"
