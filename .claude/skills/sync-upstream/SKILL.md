---
name: sync-upstream
description: Safely synchronize this T3 Code fork from upstream-sync/main and merge it into dev without overriding conflicting fork behavior.
user-invocable: true
disable-model-invocation: true
---

# Sync T3 Code From Upstream

Synchronize this private fork without sacrificing intentional fork behavior. Explicit invocation authorizes fetching both remotes, updating and pushing `main`, merging into and pushing `dev`, and running required checks. Never push to `upstream-sync`.

## Fixed topology

- `origin`: `pandec/t3code`, the writable private fork
- `upstream-sync`: `pingdotgg/t3code`, fetch-only upstream
- `main`: clean mirror of `upstream-sync/main`
- `dev`: fork integration and build branch

Verify these facts from live Git state before changing anything. Stop if the remotes or branches no longer match; do not rewrite configuration to make the assumptions true.

## Safety rules

- Never merge `dev` or fork commits into `main`.
- Merge synchronized `main` into `dev`; do not rebase or squash `dev`.
- Never force-push, destructively reset, discard changes, or commit unrelated work.
- Preserve compatible fork additions.
- Resolve mechanical conflicts autonomously. Stop for the user's decision when upstream and fork logic require different behavior or intent is uncertain.
- Read and follow the current `AGENTS.md` before acting.

## 1. Preflight

1. Inspect `git status --short --branch`, `git remote -v`, `git worktree list --porcelain`, branch tracking, and any in-progress Git operation.
2. Record the old tips of local `main`, `origin/main`, local `dev`, and `upstream-sync/main`.
3. Fetch `origin` and `upstream-sync` with pruning.
4. Require clean worktrees for branches that will change. Leave unrelated worktrees untouched. If `dev` is not checked out, create a temporary sibling worktree rather than switching an active worktree; remove it only after successful completion while it is clean.
5. Stop instead of stashing, committing, or discarding pre-existing changes.

## 2. Fast-forward main

1. Prove both local `main` and `origin/main` are ancestors of `upstream-sync/main`. Stop and report unexpected commits if either has diverged or contains fork-only work.
2. Advance local `main` with fast-forward-only semantics:
   - In a clean `main` worktree, use `git merge --ff-only upstream-sync/main`.
   - If `main` is not checked out, atomically update `refs/heads/main` only after the ancestry proof and while requiring its recorded old tip.
3. Push `main:main` to `origin` normally. If rejected, fetch again and repeat the ancestry checks. Never force the push.
4. Verify `main`, `origin/main`, and `upstream-sync/main` now identify the same commit.

## 3. Review behavioral overlap

Before changing `dev`, compare:

- upstream changes from old `main` to new `main`
- fork changes from the relevant old-main merge base to `dev`

Inspect overlapping files plus nearby callers, contracts, schemas, tests, configuration, state transitions, persistence, protocols, and failure handling. A clean textual merge does not prove behavioral compatibility.

Continue when upstream and fork changes are clearly complementary. Stop and explain the choice before merging when upstream removed, replaced, or redefined behavior intentionally customized by the fork.

## 4. Merge into dev

1. In the clean `dev` worktree, run a no-fast-forward, no-commit merge of `main` when it adds commits. Do not create the merge commit yet.
2. Resolve only clearly mechanical conflicts such as independent adjacent edits, formatting, imports, documentation, straightforward renames, or generated files that can be regenerated with the documented toolchain.
3. Treat conflicts involving behavior, control flow, state, persistence, APIs, schemas, security, failure semantics, feature removal, or incompatible test expectations as semantic.
4. For semantic conflicts:
   - never choose `ours`, `theirs`, or invent a hybrid merely to finish
   - resolve unrelated mechanical conflicts only if it clarifies the remaining choice
   - leave the merge in a recoverable in-progress state
   - report each file, upstream intent, fork intent, incompatibility, and realistic options
   - ask the user which behavior to preserve
5. Inspect the complete staged merge before committing, including cleanly merged behavioral overlap. Stop if it exposes an unresolved product or architecture choice.

## 5. Validate and publish

1. Run `vp check` and `vp run typecheck`.
2. Run `vp run lint:mobile` when native mobile code changed.
3. Run focused tests when the integration touches risky behavior; use `vp test` for built-in Vite+ tests and `vp run test` only for the package script.
4. Diagnose failures instead of bypassing them. Fix only clear integration defects; ask when a fix requires choosing upstream or fork behavior.
5. When checks pass, create the merge commit, review the graph and final diff, and push `dev:dev` to `origin` normally.
6. Verify `origin/main` equals `upstream-sync/main` and `origin/dev` contains that tip.

## Report

Report old and new upstream tips, the `main` update and push, the `dev` merge and push, conflicts resolved, fork behavior preserved, and checks run. If stopped, separate completed safe work from the user decision and state whether a merge remains in progress. Do not call the sync complete until required checks pass and both origin branches are verified.

After a completed sync, summarize what the fork gained from upstream: group the incorporated upstream commits into user-visible features, fixes, and notable internal changes, highlighting anything that affects fork-customized areas. Write it for the fork owner deciding what to try or watch out for, not as a raw commit list.

State whether any conflict resolution could impact functionality. When every resolution was purely mechanical, one sentence saying so is enough — skip per-file detail. Only elaborate on resolutions that touched behavior and could plausibly change how something works.

End with a rollout note: based on the protocol/contract, persistence, and update-feed changes in this sync, state whether the installed apps (desktop flavors, iOS) can be updated gradually one by one while older clients keep working against the new server, or whether everything should be closed and updated together, and call out anything that needs a reinstall or data migration.
