---
name: sync-upstream
description: Synchronize this T3 Code private fork by fast-forwarding mirror-only main from upstream-sync/main, pushing origin/main, reconciling fork behavior with upstream, merging main into dev, running required checks, and pushing origin/dev. Use only when explicitly invoked in this repository; never trigger proactively.
---

# Sync T3 Code From Upstream

Synchronize this private fork while making deliberate choices about fork behavior that upstream overlaps or supersedes. Explicit invocation authorizes fetching both remotes, updating and pushing `main`, merging into and pushing `dev`, and running required checks. Read the current `AGENTS.md` first.

## Fixed topology

- `origin`: `pandec/t3code`, the writable private fork
- `upstream-sync`: `pingdotgg/t3code`, fetch-only upstream
- `main`: clean mirror of `upstream-sync/main`
- `dev`: fork integration and build branch

Verify these from live Git state and stop if they no longer match; never rewrite configuration to make them true.

## Safety rules

- `main` only ever fast-forwards to upstream; `dev` receives `main` through a merge commit (no rebase, no squash).
- Push normally; a rejected push means fetch and re-prove, never force.
- Leave pre-existing changes, unrelated worktrees, and stashes untouched; stop instead of stashing, committing, or discarding them.
- Resolve mechanical conflicts autonomously. When upstream and fork need different behavior, or intent is uncertain, stop and ask.

## 1. Preflight

Check status, remotes, worktrees, any in-progress Git operation, and stashes. Record the old tips of `main`, `origin/main`, and `dev`, the stash list, and the time (again at each phase boundary, for the report). Fetch both remotes with pruning, then pin the fetched `upstream-sync/main` tip as this sync's **target**: every later step synchronizes to it and `upstream-sync` is not fetched again. Chasing a moving upstream once stretched a sync to six hours; anything newer is the next sync's range. If `dev` is not checked out, use a temporary sibling worktree and remove it once the sync completes cleanly.

## 2. Fast-forward main

Prove local `main` and `origin/main` are both ancestors of the target (stop and report fork-only commits if not), fast-forward `main` to it, push `main:main`, and verify both identify the target.

## 3. Review behavioral overlap

Read `LEDGER.md` beside this skill and apply its rules. For each watchpoint whose paths the upstream range touches, launch one read-only reviewer for its question, all in one batch. Reviewers inspect committed objects only, spawn nothing, and must all return before the merge starts.

Compare upstream's range (old `main` → target) with the fork's changes since the merge base. A clean textual merge does not prove behavioral compatibility. Classify every overlap:

- **Complementary:** both provide distinct value and coexist. Continue.
- **Superseding:** upstream now implements the same goal or competes with the fork's approach. Collect all of these and present them to the user as one decision batch, with fork trimming as an explicit option, before touching `dev`.

The same gate applies when a conflict during the merge reveals an overlap the review missed.

## 4. Merge into dev

One agent owns the merge state through the push: only the owner runs Git commands that touch refs, the index, or the worktree. On broad merges (roughly 15+ conflicted files) the owner may hand disjoint file sets, coupled files together, to sub-agents that only edit and report.

1. Run `git merge --no-ff --no-commit main`.
2. Resolve mechanical conflicts. Treat conflicts in behavior, control flow, state, persistence, APIs, schemas, security, failure semantics, feature removal, or test expectations as semantic: never pick `ours`/`theirs` or invent a hybrid to finish. Leave the merge recoverable and report each file's upstream intent, fork intent, and realistic options.
3. Before validating, assert merge-state sanity. Stage through the real `.agents/...` paths, never the `.claude/...` symlinks. This scan must print nothing:
   ```sh
   git diff --cached --name-only --diff-filter=ACMR -z |
     LC_ALL=C xargs -0 awk '/^(<<<<<<<|=======|>>>>>>>)/{print FILENAME ":" FNR}'
   ```
   Also require `.git/MERGE_HEAD` to name the target, no unrelated root `package.json` change, and no fork file under `apps/server/src/persistence/Migrations/`.

## 5. Validate and publish

1. Re-read the merged `AGENTS.md`, then run `vp install --frozen-lockfile`, `vp check`, `vp run typecheck`, and focused tests for conflict resolutions and risky overlap. Run focused tests from inside the package (`(cd apps/web && vp test run <files>)`) so package-local plugins resolve and nested worktrees are not discovered.
2. Audit the complete staged merge, including cleanly merged overlap, for integration defects. Fix confirmed defects and rerun the checks they touch; report anything that needs a product or architecture choice. Wait for the audit to finish before the full suite.
3. Run the full suite once: `env -u CLAUDE_CONFIG_DIR -u ELECTRON_RUN_AS_NODE -u ELEVENLABS_API_KEY vp run test`. Add `vp run lint:mobile` when native mobile code, config, dependencies, or patches changed, and the affected build or smoke check when packaging, preload, build config, or update behavior changed.
4. Skip browser, simulator, device, and installed-app verification unless the user asks; this workflow is the authorized exception to `AGENTS.md`'s integrated-verification guidance.
5. If the range touches `apps/server/src/mcp`, `packages/contracts/src/orchestratorMcp.ts`, orchestration commands, thread groups, archive scheduling, or project-script settings, confirm the fork's MCP tools still behave as their tests expect and are not superseded by upstream. Align them where needed; report upstream equivalents as trim candidates rather than removing them mid-sync.
6. Update `LEDGER.md` under its own entry rules and line cap.
7. Commit the merge once every applicable gate passes. Judge the result from Git state, not hook output: two parents, no merge in progress, clean tree, stash list unchanged.
8. Fetch `origin`. If `origin/dev` moved, merge it with `--no-ff --no-commit` under the same conflict rules, rerun the gates the new delta invalidates (source changes need at least check, typecheck, and the full suite), commit, and repeat until `origin/dev` is an ancestor of `dev`. This loop never widens the target. Then push `dev:dev`.
9. Fetch `origin` and verify `dev` equals `origin/dev`, `main` equals `origin/main` at the target, and the tree is clean.

## Report

Deliver as soon as the sync is verified; follow-up work is a separate task. If stopped, separate completed safe work from the pending decision and say whether a merge is in progress. Include:

- old tips, target, the `main` and `dev` pushes, and per-phase durations
- what the fork gained from upstream, grouped into user-visible features, fixes, and notable internal changes, flagging anything touching fork-customized areas
- whether any conflict resolution could change behavior (one sentence when all were mechanical)
- checks run, and the MCP tool audit result with any trim candidates
- a rollout note: whether installed desktop and iOS apps can update one at a time against the new server or must update together, and anything needing a reinstall or data migration
- one line if the final fetch shows upstream already past the target

Then check the full-audit due date in `LEDGER.md`. If it has passed, or the upstream drop was unusually large, ask whether to run the cross-feature fork-vs-upstream audit now or postpone, and record the answer in the ledger.
