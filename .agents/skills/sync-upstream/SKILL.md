---
name: sync-upstream
description: Synchronize this T3 Code private fork by fast-forwarding mirror-only main from upstream-sync/main, pushing origin/main, reconciling fork behavior with upstream, merging main into dev, running required checks, and pushing origin/dev. Use only when explicitly invoked in this repository; never trigger proactively.
---

# Sync T3 Code From Upstream

Synchronize this private fork while making deliberate choices about fork behavior that upstream overlaps or supersedes. Explicit invocation authorizes fetching both remotes, updating and pushing `main`, merging into and pushing `dev`, and running required checks. Never push to `upstream-sync`.

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
- Preserve compatible fork additions that remain intentionally distinct after the behavioral-overlap review.
- Resolve mechanical conflicts autonomously. Stop for the user's decision when upstream and fork logic require different behavior or intent is uncertain.
- Read and follow the current `AGENTS.md` before acting.

## 1. Preflight

1. Inspect `git status --short --branch`, `git remote -v`, `git worktree list --porcelain`, branch tracking, any in-progress Git operation, and `git stash list`.
2. Record the old tips of local `main`, `origin/main`, local `dev`, and `upstream-sync/main`, plus the existing stash refs so hook-created leftovers can be detected later. Note the time (`date`) now and at each later numbered-phase boundary so the report can state per-phase durations.
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

Read `LEDGER.md` next to this skill first. Apply its standing decisions instead of re-deliberating them. For each ledger watchpoint whose path is touched by the incoming upstream range, spawn one targeted sub-agent to answer that entry's question (whether the fork change there is still needed and compatible); untouched watchpoints need no check.

Review agents are read-only: they inspect committed Git objects (`git show`, `git diff`, `git log`) and report; they never edit files or run any Git command that changes refs, the index, or a worktree. Each targeted reviewer answers its ledger question directly without spawning sub-agents or workflows. Launch the touched-watchpoint reviews as one batch and block until every reviewer has returned. If a coordinator must spawn descendants, it owns their lifecycle and returns only after every descendant has completed or been stopped; its report includes the spawned count and confirms zero live descendants. The merge starts only after the whole review tree is quiescent.

Before changing `dev`, compare:

- upstream changes from old `main` to new `main`
- fork changes from the relevant old-main merge base to `dev`

Inspect overlapping files plus nearby callers, contracts, schemas, tests, configuration, state transitions, persistence, protocols, and failure handling. A clean textual merge does not prove behavioral compatibility.

Classify every behavioral overlap before changing `dev`:

- **Complementary:** both implementations provide distinct value and can coexist without conflicting behavior. Continue.
- **Superseding:** upstream now implements the same goal, replaces the fork's approach, or moves close enough that keeping both would create redundant or competing functionality. Assess whether the fork code still provides distinct value or should be simplified or removed in favor of upstream. Collect every superseding overlap and present them to the user together as one decision batch — tradeoffs, with fork trimming as an explicit option — before starting the `dev` merge.

Continue only after every superseding overlap has an explicit user decision. Apply the same gate if a semantic conflict discovered during the merge reveals an overlap that the pre-merge review could not identify.

## 4. Merge into dev

One agent owns the merge state from here through the push: only the owner runs Git commands that touch refs, the index, or the worktree (`merge`, `checkout`, `add`, `rm`, `restore`, `reset`, `stash`, `commit`). Delegate conflict resolution only on broad merges (roughly 15+ conflicted files) and only as disjoint-file editors: each sub-agent edits its assigned files and reports, coupled files stay in one assignment, and the owner stages and verifies everything. On any unexpected Git state, the owner finishes alone.

1. In the clean `dev` worktree, run a no-fast-forward, no-commit merge of `main` when it adds commits. Do not create the merge commit yet.
2. Resolve only clearly mechanical conflicts such as independent adjacent edits, formatting, imports, documentation, straightforward renames, or generated files that can be regenerated with the documented toolchain.
3. Treat conflicts involving behavior, control flow, state, persistence, APIs, schemas, security, failure semantics, feature removal, or incompatible test expectations as semantic.
4. For semantic conflicts:
   - never choose `ours`, `theirs`, or invent a hybrid merely to finish
   - resolve unrelated mechanical conflicts only if it clarifies the remaining choice
   - leave the merge in a recoverable in-progress state
   - report each file, upstream intent, fork intent, incompatibility, and realistic options
   - apply the behavioral-overlap gate above and ask the user which option to take
5. After resolution, assert merge-state sanity before spending time on validation. Stage tracked files through their real `.agents/...` paths, never the `.claude/...` symlinks. Scan staged files safely with:
   ```sh
   git diff --cached --name-only --diff-filter=ACMR -z |
     xargs -0 awk '/^(<<<<<<<|=======|>>>>>>>)/{print FILENAME ":" FNR}'
   ```
   Require no output, `.git/MERGE_HEAD` to name the merged `main` tip, no unrelated root `package.json` modification, and unique migration numeric prefixes. The ledger's verification gotchas explain the failure modes.

## 5. Validate and publish

Complete the applicable local verification before pushing `dev`.

1. Re-read the merged `AGENTS.md` after conflict resolution; upstream may have changed the instructions that were read during preflight. Determine the applicable checks from the complete merged diff, the merged instructions, affected package scripts, and changed repository tooling. Run every relevant check that is available locally before pushing; do not omit a relevant check merely because it is conditional or slower than the baseline.
2. Install the merged dependency graph with `vp install --frozen-lockfile`.
3. Run the cheap gates first in the merged worktree:
   - `vp check`
   - `vp run typecheck`
   - focused tests for conflict resolutions, fork-customized areas, and other risky behavioral overlap: `vp test run --root <package-dir> <test-files>` so nested worktrees are not discovered by the root test runner. Use a package's own test script only when it specifically requires one.
4. With the cheap gates green, audit the complete staged merge — including cleanly merged behavioral overlap — for integration defects. This is a hard barrier: do not start the full suite while the audit or any descendant reviewer is still live. Stop if the audit exposes an unresolved product or architecture choice. Fix confirmed defects and rerun the cheap checks they touch. Completion criterion: every finding is fixed or reported as a concrete unresolved decision, and the audit review tree has zero live descendants.
5. Only after step 4 is complete, run the full suite exactly once: `env -u CLAUDE_CONFIG_DIR vp run test` (the ledger's verification gotchas explain the cleared variable). If later convergence changes code, its required rerun is separate from this initial validation pass.
6. Add conditional static, generated-output, or build checks when the merged changes make them relevant:
   - run `vp run lint:mobile` when native mobile code, native configuration, mobile dependencies, or patches changed
   - run the affected build, smoke, or generated-asset check when packaging, preload code, build configuration, release/update behavior, or generated assets changed
   - inspect changes to repository tooling for newly introduced checks that protect code affected by the sync
7. Do not launch browser, simulator, emulator, physical-device, or installed-app verification during a routine upstream sync, even when upstream includes user-visible frontend or mobile changes. For this explicitly invoked workflow, this is the user-authorized exception to the integrated client verification rules in `AGENTS.md`. Perform runtime app verification only when the user explicitly requests it.
8. Diagnose failures instead of bypassing them. Fix only clear integration defects; ask when a fix requires choosing upstream or fork behavior. Do not push with a failing applicable gate.
9. Audit the fork-maintained CLI against the merged behavior. When upstream changes or merge resolutions touch project or thread lifecycle, orchestration commands or contracts, defaults, flags, JSON shapes, error semantics, or related documentation:
   - compare `apps/server/src/cli/`, its focused tests, and `docs/user/cli-automation.md` with the merged contracts and behavior
   - update repository-owned CLI implementation, tests, and documentation when alignment requires it, then rerun the affected checks
   - verify the global `t3-cli` skill at `~/.agents/skills/t3-cli` still describes the implemented command contract; when it has drifted, update it by default to match the merged contract (the user has standing authorization for these keep-in-sync edits), then report the exact change made. Note `~/.agents/skills/t3-cli` and `~/.claude/skills/t3-cli` are hardlinked copies, so editing one updates both. Still ask before any change beyond mechanical contract alignment (renames, removals, behavioral rewrites)
   - completion criterion: every CLI-affecting upstream or merge change is either reflected in the implementation, tests, and documentation or reported as a concrete unresolved decision
10. Update `LEDGER.md` as part of the sync commit: record new standing decisions made during this sync, add watchpoints for newly observed fork/upstream friction files, resolve watchpoint checks that ran, and apply the ledger's self-cleaning rules. Keep it scoped to what changes future syncs — never a fork feature list.
11. Only after the applicable local gates and CLI audit pass, create the merge commit. Verify the commit has the expected parents, no merge operation remains, the worktree and index are clean, and the stash refs still match preflight. A hook can print an error after Git has already created the commit, so determine the actual result from Git state rather than hook output alone.
12. Before pushing, enter an `origin/dev` convergence loop:
    - fetch `origin` with pruning immediately before the push and compare `origin/dev` with the last reviewed tip
    - if `origin/dev` advanced, inspect that exact new range and its behavioral overlap with the synchronized candidate, then merge `origin/dev` with `--no-ff --no-commit` under the same conflict rules
    - rerun every gate invalidated by the new delta; behavioral or source changes require at least `vp check`, `vp run typecheck`, `env -u CLAUDE_CONFIG_DIR vp run test`, and relevant focused or conditional checks
    - commit the reconciliation, perform the post-commit checks above, fetch again, and repeat until the freshly fetched `origin/dev` is an ancestor of local `dev`
    - push `dev:dev` normally only after that ancestry proof; if the push is rejected because `origin/dev` moved again, repeat the loop. Never force the push.
13. Fetch `origin` after the push. Verify `dev` equals `origin/dev`, `main` equals both `origin/main` and `upstream-sync/main`, `dev` contains the synchronized `main` tip, and the worktree is clean.

## Report

Report old and new upstream tips, the `main` update and push, the `dev` merge and push, conflicts resolved, fork behavior preserved, checks run, and per-phase durations from the recorded timestamps. If stopped, separate completed safe work from the user decision and state whether a merge remains in progress. Do not call the sync complete until required checks pass and both origin branches are verified. Deliver this report as soon as the sync is verified; follow-up work such as a full audit, a TestFlight build, cleanup, or feature PRs is a separate task that starts only after the report.

After a completed sync, summarize what the fork gained from upstream: group the incorporated upstream commits into user-visible features, fixes, and notable internal changes, highlighting anything that affects fork-customized areas. Write it for the fork owner deciding what to try or watch out for, not as a raw commit list.

State whether any conflict resolution could impact functionality. When every resolution was purely mechanical, one sentence saying so is enough — skip per-file detail. Only elaborate on resolutions that touched behavior and could plausibly change how something works.

Report the CLI alignment audit result, including any repository changes made or any required `t3-cli` dotfiles update.

End with a rollout note: based on the protocol/contract, persistence, and update-feed changes in this sync, state whether the installed apps (desktop flavors, iOS) can be updated gradually one by one while older clients keep working against the new server, or whether everything should be closed and updated together, and call out anything that needs a reinstall or data migration.

After the summary, check the full-audit due date in `LEDGER.md`. If it has passed (or this sync merged an unusually large upstream drop), ask the user whether to run the cross-feature fork-vs-upstream audit now or postpone; record the answer by updating the ledger's audit marker. Do not block or delay the sync itself on this.
