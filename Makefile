# std-public — the round-trip Makefile
# ============================================================================
# ONE map, TWO directions, and a full ship pipeline between them.
#
#   repo  --deploy-->  ~/.claude/PAI/TOOLS      (byte-verbatim, from the door pin)
#   repo  <--sync-in--  ~/.claude/PAI/TOOLS     (bring live edits back to edit properly)
#
# WHY A MAP AT ALL: the live filenames are NOT the repo filenames. `proof/harvester.ts`
# deploys as `SessionHarvester.ts` because PULSE.toml:93 spawns THAT path by name, and the
# three siblings keep their kebab names because `SessionHarvester.ts` carries a RUNTIME
# `from "./skill-classifier"` import — the filename is dictated by the import specifier.
# Change a name here and something breaks silently. See `make notes`.
#
# THE DEPLOY IS EXPLICIT PER-FILE ON PURPOSE. Story 17.6 lost a deploy to a shell loop:
# zsh does not word-split unquoted `$var`, so `for x in $map` ran ONCE with the whole
# string and copied the wrong content — and compressed output hid it. So `deploy` uses
# Make's own $(foreach) to EMIT one literal command per file (run `make -n deploy` and
# you will see four separate cp lines), and `verify` cmp's each file INDEPENDENTLY
# against the immutable pinned git blob, printing its own line.

SHELL       := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

REPO        := $(shell git rev-parse --show-toplevel)
CLAUDE      ?= $(HOME)/.claude
TOOLS       ?= $(CLAUDE)/PAI/TOOLS
VENDOR      ?= $(CLAUDE)/PAI/vendor/std

# The door pin: the SHA the live tools resolve `std/*` against, and the ONLY honest
# deploy source. Never deploy from the working tree — deploy what the pin can serve.
PIN          = $(shell git -C $(VENDOR) rev-parse HEAD 2>/dev/null || echo NO-DOOR)
MAIN         = $(shell git rev-parse origin/main 2>/dev/null || git rev-parse main)

# dest-basename:repo-basename  (no extensions — added below)
MAP := SessionHarvester.ts:harvester \
       skill-classifier.ts:skill-classifier \
       gotchas-promoter.ts:gotchas-promoter \
       adr-generator.ts:adr-generator

dest = $(word 1,$(subst :, ,$(1)))
src  = $(word 2,$(subst :, ,$(1)))

BRANCH ?=
CHECK_WAIT ?= 120
MSG    ?=
YES    ?=

# ── help ────────────────────────────────────────────────────────────────────
.PHONY: help
help:  ## List all targets
	@echo "std-public — repo <-> live PAI/TOOLS round trip"
	@echo ""
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  door pin : $(PIN)"
	@echo "  main     : $(MAIN)"
	@echo "  live     : $(TOOLS)"
	@echo ""
	@echo "  Vars: CLAUDE= TOOLS= VENDOR= BRANCH= MSG= YES=1 (skip confirmations)"

.PHONY: notes
notes:  ## Why the filename map exists and what breaks if you change it
	@echo "SessionHarvester.ts  <- proof/harvester.ts"
	@echo "    FROZEN NAME. PULSE.toml:93 spawns it by path (--recent 20);"
	@echo "    hooks/lib/containment-zones.ts:88 lists the same path."
	@echo "skill-classifier.ts  <- proof/skill-classifier.ts"
	@echo "    CO-DEPLOY IS LOAD-BEARING. SessionHarvester.ts has a RUNTIME value import"
	@echo "    'from \"./skill-classifier\"' — without this sibling same-dir it dies at import."
	@echo "gotchas-promoter.ts / adr-generator.ts  <- same basename"
	@echo "    Their './harvester' imports are TYPE-ONLY and erase, so no rival harvester"
	@echo "    copy is needed (or wanted) live."

# ── gates ───────────────────────────────────────────────────────────────────
.PHONY: test
test:  ## bun test
	@bun test

.PHONY: typecheck
typecheck:  ## tsc for src/ and proof/
	@bun run typecheck
	@bun run typecheck:proof

.PHONY: checks
checks:  ## the 4 fitness-function gates (core-purity, dep-root, single-source, no-consumer-ids)
	@bun run check:core-purity
	@bun run check:dep-root
	@bun run check:single-source
	@bun run check:no-consumer-ids

.PHONY: gates
gates: test typecheck checks  ## EVERYTHING — the full pre-merge gate set
	@echo "✅ all gates green"

.PHONY: src-delta
src-delta:  ## prove src/** is untouched vs a baseline (BASE=<sha>, default origin/main)
	@base="$${BASE:-$$(git rev-parse origin/main)}"; \
	 if [ -n "$$(git diff --stat $$base -- src/)" ]; then \
	   echo "❌ src/** delta vs $$base:"; git diff --stat $$base -- src/; exit 1; \
	 else echo "✅ src/** delta ZERO vs $$base"; fi

# ── door ────────────────────────────────────────────────────────────────────
.PHONY: pin
pin:  ## show the door pin vs main, and whether a bump would change std/src
	@echo "door pin : $(PIN)"
	@echo "main     : $(MAIN)"
	@if [ "$(PIN)" = "$(MAIN)" ]; then echo "✅ pin == main"; else \
	   echo "⚠ pin != main. src/ delta between them:"; \
	   git diff --stat $(PIN) $(MAIN) -- src/ || true; \
	   echo "(empty above = a bump is a std/src NO-OP and is safe)"; fi

.PHONY: pin-bump
pin-bump:  ## bump the vendored door pin to main (refuses if it would change std/src)
	@if [ -n "$$(git diff --stat $(PIN) $(MAIN) -- src/)" ]; then \
	   echo "❌ bumping the pin WOULD change std/src — review before proceeding:"; \
	   git diff --stat $(PIN) $(MAIN) -- src/; exit 1; fi
	@git -C $(VENDOR) fetch -q origin main
	@git -C $(VENDOR) checkout -q $(MAIN)
	@echo "✅ door pin $(PIN) -> $$(git -C $(VENDOR) rev-parse HEAD) (std/src NO-OP)"

# ── repo -> live ────────────────────────────────────────────────────────────
.PHONY: deploy
deploy: preflight  ## byte-verbatim deploy of all mapped tools from the door pin -> live
	$(foreach p,$(MAP),git show $(PIN):proof/$(call src,$(p)).ts > $(TOOLS)/$(call dest,$(p));)
	$(foreach p,$(MAP),chmod 755 $(TOOLS)/$(call dest,$(p));)
	@$(MAKE) --no-print-directory verify

.PHONY: preflight
preflight:  ## refuse to deploy from a dirty tree or a missing door
	@if [ "$(PIN)" = "NO-DOOR" ]; then echo "❌ no door at $(VENDOR)"; exit 1; fi
	@if [ -n "$$(git status --porcelain proof/)" ]; then \
	   echo "❌ proof/ is dirty — commit first; the pin is the deploy source, not your worktree"; \
	   git status --porcelain proof/; exit 1; fi
	@for p in $(MAP); do d=$${p%%:*}; s=$${p##*:}; \
	   git cat-file -e $(PIN):proof/$$s.ts 2>/dev/null || { echo "❌ $(PIN) has no proof/$$s.ts — bump the pin"; exit 1; }; \
	 done
	@echo "✅ preflight: door $(PIN), proof/ clean, all sources present at the pin"

.PHONY: verify
verify:  ## cmp EACH live file against the immutable pinned blob — one line each
	@fail=0; \
	 for p in $(MAP); do d=$${p%%:*}; s=$${p##*:}; \
	   if git show $(PIN):proof/$$s.ts | cmp -s - $(TOOLS)/$$d; then \
	     printf "✅ %-24s IDENTICAL to %s:proof/%s.ts\n" "$$d" "$(PIN)" "$$s"; \
	   else printf "❌ %-24s MISMATCH vs %s:proof/%s.ts\n" "$$d" "$(PIN)" "$$s"; fail=1; fi; \
	 done; \
	 [ $$fail -eq 0 ] || { echo "deploy is NOT byte-verbatim — do not commit"; exit 1; }

.PHONY: smoke
smoke:  ## read-only / dry-run smokes of every deployed tool against live state
	@echo "── runtime coupling (harvester -> ./skill-classifier)"
	@bun -e 'import("$(TOOLS)/skill-classifier.ts").then(m=>console.log("✅ resolves:",Object.keys(m).length,"exports")).catch(e=>{console.log("❌",e.message);process.exit(1)})'
	@echo "── --help exits 0"
	@bun $(TOOLS)/gotchas-promoter.ts --help >/dev/null && echo "✅ gotchas-promoter --help"
	@bun $(TOOLS)/adr-generator.ts    --help >/dev/null && echo "✅ adr-generator --help"
	@echo "── frozen PULSE contract (spawn-by-path, dry-run)"
	@q=$$(ls $(CLAUDE)/PAI/MEMORY/KNOWLEDGE/_harvest-queue 2>/dev/null | wc -l | tr -d ' '); \
	 bun run $(TOOLS)/SessionHarvester.ts --recent 20 --dry-run >/dev/null && echo "✅ SessionHarvester --recent 20 --dry-run"; \
	 bun run $(TOOLS)/SessionHarvester.ts --mine --recent 3 --dry-run >/dev/null && echo "✅ SessionHarvester --mine --dry-run"; \
	 a=$$(ls $(CLAUDE)/PAI/MEMORY/KNOWLEDGE/_harvest-queue 2>/dev/null | wc -l | tr -d ' '); \
	 [ "$$q" = "$$a" ] && echo "✅ queue unchanged ($$q before, $$a after) — dry-runs wrote nothing" \
	                   || { echo "❌ queue changed $$q -> $$a"; exit 1; }
	@bun run $(TOOLS)/adr-generator.ts --dry-run >/dev/null && echo "✅ adr-generator --dry-run"
	@bun run $(TOOLS)/gotchas-promoter.ts >/dev/null && echo "✅ gotchas-promoter (read-only by design)"

.PHONY: commit-live
commit-live:  ## commit ONLY the mapped tools + the pin in ~/.claude, staged BY NAME
	@cd $(CLAUDE) && git add PAI/vendor/std $(foreach p,$(MAP),PAI/TOOLS/$(call dest,$(p))) && \
	 echo "staged:" && git diff --cached --name-only && \
	 git commit -q -m "PAI/TOOLS: deploy std-public tools @ $(PIN)" \
	   -m "Byte-verbatim from the door pin; each file cmp-verified against the pinned blob." && \
	 echo "✅ $$(git log --oneline -1)"

# ── live -> repo ────────────────────────────────────────────────────────────
.PHONY: diff-live
diff-live:  ## show where LIVE has drifted from the pinned blob (both directions)
	@for p in $(MAP); do d=$${p%%:*}; s=$${p##*:}; \
	   if git show $(PIN):proof/$$s.ts | diff -q - $(TOOLS)/$$d >/dev/null 2>&1; then \
	     printf "   %-24s in sync\n" "$$d"; \
	   else printf "⚠  %-24s DRIFTED — live differs from %s:proof/%s.ts\n" "$$d" "$(PIN)" "$$s"; \
	     git show $(PIN):proof/$$s.ts | diff -u --label "repo/proof/$$s.ts" --label "live/$$d" - $(TOOLS)/$$d | head -40; fi; \
	 done

.PHONY: sync-in
sync-in:  ## bring LIVE edits back into proof/ so you can edit + review them properly
	@$(MAKE) --no-print-directory diff-live
	@if [ -z "$(YES)" ]; then \
	   read -p "Copy live -> proof/ (overwrites your worktree copies)? [y/N] " a; \
	   [ "$$a" = "y" ] || { echo "aborted"; exit 1; }; fi
	$(foreach p,$(MAP),cp $(TOOLS)/$(call dest,$(p)) $(REPO)/proof/$(call src,$(p)).ts;)
	@git status --porcelain proof/
	@echo "✅ live copied into proof/ — now edit, test, and 'make ship'"

# ── the full round trip ─────────────────────────────────────────────────────
.PHONY: ship
ship:  ## FULL PIPELINE: gates -> branch+commit -> push -> PR -> merge -> re-gate -> deploy -> verify
	@[ -n "$(BRANCH)" ] || { echo "❌ BRANCH= is required (e.g. BRANCH=fix/adr-window)"; exit 1; }
	@[ -n "$(MSG)"    ] || { echo "❌ MSG= is required"; exit 1; }
	@if [ -z "$$(git status --porcelain)" ]; then echo "❌ nothing to ship — worktree is clean"; exit 1; fi
	@echo "── 1/8 gates (must be green BEFORE anything leaves this machine)"
	@$(MAKE) --no-print-directory gates
	@$(MAKE) --no-print-directory src-delta
	@echo "── 2/8 branch + commit"
	@git rev-parse --verify $(BRANCH) >/dev/null 2>&1 || git checkout -q -b $(BRANCH)
	@git checkout -q $(BRANCH)
	@git add -A && git commit -q -m "$(MSG)"
	@git --no-pager log --oneline -1
	@echo "── 3/8 push"
	@git push -q -u origin $(BRANCH)
	@echo "── 4/8 open PR"
	@gh pr create --base main --head $(BRANCH) --title "$(MSG)" --body "$(MSG)" 2>/dev/null \
	   || echo "   (PR already exists — reusing it)"
	@gh pr view --json url --jq .url
	@echo "── 5/8 wait for checks"
	@# `gh pr checks` exits NON-ZERO when no checks have REGISTERED yet, which on a fresh push
	@# is a race, not a failure — treating it as failure once aborted a perfectly good ship.
	@# So: poll until checks appear (up to CHECK_WAIT s), THEN watch them.
	@waited=0; \
	 until gh pr checks >/dev/null 2>&1 || [ $$waited -ge $(CHECK_WAIT) ]; do \
	   sleep 5; waited=$$((waited+5)); printf "\r   waiting for checks to register... %ss" "$$waited"; \
	 done; echo; \
	 if ! gh pr checks >/dev/null 2>&1; then \
	   echo "⚠ no checks registered after $(CHECK_WAIT)s — this PR has no CI to gate on."; \
	   if [ -z "$(YES)" ]; then read -p "   Merge anyway? [y/N] " a; [ "$$a" = "y" ] || { echo "stopped"; exit 1; }; \
	   else echo "   YES=1 set — proceeding without a CI gate (local gates were green)."; fi; \
	 else \
	   gh pr checks --watch --fail-fast || { echo "❌ checks failed — nothing merged"; exit 1; }; \
	 fi
	@if [ -z "$(YES)" ]; then \
	   read -p "Checks green. MERGE to main and redeploy live? [y/N] " a; \
	   [ "$$a" = "y" ] || { echo "stopped before merge; branch + PR are pushed"; exit 1; }; fi
	@echo "── 6/8 merge"
	@gh pr merge --squash --delete-branch
	@git checkout -q main && git pull -q origin main
	@echo "── 7/8 re-gate on merged main, then bump the door + deploy"
	@$(MAKE) --no-print-directory gates
	@$(MAKE) --no-print-directory pin-bump
	@$(MAKE) --no-print-directory deploy
	@echo "── 8/8 smoke live, then commit ~/.claude"
	@$(MAKE) --no-print-directory smoke
	@$(MAKE) --no-print-directory commit-live
	@echo ""
	@echo "🚀 shipped: repo -> PR -> main -> live, gates green at both ends"

.PHONY: redeploy
redeploy: pin-bump deploy smoke commit-live  ## bump pin + deploy + smoke + commit live (no PR — for an already-merged main)
	@echo "🚀 redeployed from $(PIN)"
