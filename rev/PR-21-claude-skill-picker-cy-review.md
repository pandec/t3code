# PR #21 cy-review

## Target

- PR: https://github.com/pandec/t3code/pull/21
- Branch: `fix/claude-skill-picker-v2`
- Base: `origin/dev`
- Diff base: `fc5f21c204deea15b0b66d45759a81440925c1e0`
- Reviewed head: `7cc3981234118c4e949ef15b41f0affc4b127d34`
- Date: 2026-07-22
- Round: 1

Accepted constraints excluded from review: project settings necessarily run workspace `SessionStart` hooks during discovery, and `strictMcpConfig: true` is intentional so workspace `.mcp.json` servers do not start.

## Review fleet

| Reviewer                      | Primary responsibility                                    | Reason selected                                                                               |
| ----------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Skeptical code reviewer       | Correctness, regressions, async cleanup, tests            | The change adds an async SDK query lifecycle and a shared contract change.                    |
| SDK lifecycle specialist      | Installed SDK control protocol and cancellation semantics | `initializationResult()` plus `reloadSkills()` is an integration-facing control-request flow. |
| Design and reuse reviewer     | Boundaries, reuse, and cross-client contract consumers    | `ServerProviderSkill.path` now has wider semantics across web and mobile.                     |
| Adversarial solution reviewer | Challenge the chosen integration and assumptions          | The feature bridges provider-native skill metadata into a provider-neutral picker.            |

## Summary

- Raw findings: 5
- Unique candidates: 3
- Kept findings: 1
- Fix now: 1
- Deferred: 0
- Discarded: 2 unique candidates (4 raw reports after deduplication)

## Combined findings

| ID   | File:line                                               | Source roles                                           | Severity | Disposition | Rationale                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ------------------------------------------------------- | ------------------------------------------------------ | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY-1 | `apps/server/src/provider/providerSkills.ts:16`         | skeptical code                                         | MEDIUM   | fix_now     | The shared 10-second timeout was designed for Codex, while Claude's equivalent SDK initialization already has a documented 25-second budget for Bedrock. A timeout falls back to an empty Claude snapshot skill list.                                                                                                                                     |
| CY-2 | `apps/server/src/provider/Layers/ClaudeProvider.ts:554` | skeptical code, design and reuse, adversarial solution | HIGH     | discard     | The reviewers inferred that `$name` cannot activate a Claude skill because `/name` is the native command syntax. Current PR evidence includes a live end-to-end run where the selected `$skill` produced a real Claude `Skill` tool invocation, so a prompt rewrite would contradict verified behavior and the requested provider-neutral `$` experience. |
| CY-3 | `packages/contracts/src/server.ts:84`                   | adversarial solution                                   | MEDIUM   | discard     | An older client would reject a new pathless skill, but this repository already treats mismatched client/server versions as potentially RPC-incompatible and tells users to synchronize them. Inventing an opaque filesystem path would weaken the contract semantics without an established rolling-compatibility requirement.                            |

## Deferred candidates

No candidates deferred.

## Discarded summary

- One duplicated invocation-syntax concern was contradicted by the PR's current live end-to-end evidence and would change intended prompt semantics.
- One rolling-version compatibility concern assumed a guarantee the repository does not make and proposed misleading path data.

## Raw-output appendix

- SDK lifecycle specialist: no findings after checking SDK 0.3.170 types and implementation, control-request sequencing, abort handling, close idempotence, and concurrent request behavior.
- Three reviewers independently raised the invocation-syntax candidate; it was deduplicated and checked against current live verification evidence before disposition.
- The skeptical reviewer also identified the provider-specific timeout mismatch retained as CY-1.

## Fix applied

- Added an optional adapter-owned workspace skill discovery timeout.
- Claude reuses its existing 25-second SDK initialization budget; other adapters retain the 10-second default.
- Added virtual-clock coverage proving the adapter-specific budget is honored and direct Claude adapter coverage for the configured value.

## Verification

- `vp test run apps/server/src/provider/providerSkills.test.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts apps/server/src/provider/Layers/ClaudeProvider.skills.test.ts apps/web/src/providerSkillPresentation.test.ts packages/contracts/src/server.test.ts` — 5 files, 80 tests passed.
- `vp check` — passed with pre-existing non-blocking warnings.
- `vp run typecheck` — passed across all 15 tasks with pre-existing non-blocking suggestions.
- `git diff --check` — passed.
