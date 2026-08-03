# cy-review: `t3code/gateway-usage-followups`

- Date: 2026-08-03
- Base: `origin/dev` (`8c29a3756`)
- Head reviewed: `b342b4930`
- Diff: `git diff origin/dev...HEAD`
- Round: 1
- PR context: follow-ups to merged PR #101

## Review fleet

| Reviewer                        | Primary responsibility                                            | Why selected                                                                                          |
| ------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Skeptical code reviewer         | Correctness, regressions, missing edge-case coverage              | The diff changes async state, persistence, and client behavior.                                       |
| Adversarial solution reviewer   | Challenge causal ordering and state ownership                     | Registry notifications and LWW tokens can each look locally correct while composing incorrectly.      |
| Effect concurrency specialist   | Effect v4 Cause semantics, fibers, subscriptions, and token races | The coordinator mixes scoped streams, semaphore queues, deferred single-flight, and Cause extraction. |
| Contract compatibility reviewer | RPC rolling compatibility and web/mobile behavior                 | `providerUsage.refresh` changes its response across independently updated clients.                    |

A required read-only Claude/Fable design pass independently confirmed the three causal/token findings. Its source-keyed tombstone proposal was not adopted because it would violate the accepted instance-bounded tombstone model; the fix will preserve that model with serialized reconciliation and current-adapter validation.

## Summary

- Raw findings: 6
- Consolidated kept findings: 4
- Fix now: 4
- Deferred: 0
- Discarded: 1

## Combined findings

| ID   | File:line                                                         | Source roles      | Severity | Disposition | Rationale                                                                                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------------- | ----------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY-1 | `apps/server/src/provider/Layers/ProviderUsageRefreshLive.ts:98`  | Skeptical, Effect | MEDIUM   | fix now     | A stale adapter queued behind the probe semaphore can allocate its token after the target-change clear and resurrect the old payload. Revalidate adapter identity after acquiring a permit, with the observation token allocated before that revalidation.           |
| CY-2 | `apps/server/src/provider/Layers/ProviderUsageRefreshLive.ts:321` | Adversarial       | HIGH     | fix now     | A refresh can resolve and report from target B before the delayed A-to-B registry notification is consumed; that late event then clears the valid B snapshot. Serialize target resolution/reconciliation and make refresh reads reconcile before returning adapters. |
| CY-3 | `apps/server/src/provider/Layers/ProviderUsageRefreshLive.ts:102` | Adversarial       | MEDIUM   | fix now     | `reportUsageSnapshot` can reject an older token, but the coordinator still marks the instance refreshed. Return whether the LWW write applied and derive `refreshed` from that result.                                                                               |
| CY-4 | `apps/server/src/provider/Layers/ProviderUsageRefreshLive.ts:327` | Skeptical         | MEDIUM   | fix now     | A no-target to gateway-target transition leaves the prior direct snapshot installed if the new probe fails. Diff the union of previous and next target IDs so any resolved source transition clears the old instance payload.                                        |

## Deferred candidates

None.

## Discarded summary

- One proposal would have replaced defect messages with a generic reason. The requested behavior explicitly defines `probeFailureReason` as squash, then `detail`, then `message`, then fallback; the Effect v4 implementation follows that order and the server retains full logging. No contract or compatibility reviewer found a concrete break in that requested behavior.

## Raw-output appendix

- Skeptical reviewer: queued-probe resurrection; no-target to gateway-target stale direct snapshot.
- Adversarial reviewer: delayed-event clear of a valid new-target snapshot; false refreshed result after an LWW loss; one discarded defect-message policy challenge.
- Effect specialist: queued-probe resurrection; Cause timeout/failure/defect handling and scoped subscription behavior otherwise sound; 30 focused server tests passed in its read-only worktree inspection.
- Contract compatibility reviewer: no findings.

## Implemented disposition

- Serialized gateway-target resolution, cache pruning, transition diffing, and snapshot clearing behind one semaphore used by both registry events and refresh reads.
- Revalidated an instance's adapter after it acquires a probe permit, with the observation token allocated before revalidation.
- Changed `reportUsageSnapshot` to atomically return whether its LWW write applied, and only marks that instance refreshed when it did.
- Diffed the union of previous and next resolved-target IDs, clearing stale direct data when a gateway target is added as well as clearing on target loss or replacement.
- Added focused regression coverage for queued stale adapters, delayed registry events, both source-transition directions, and honest refresh outcomes after an LWW loss.

## Verification

- `pnpm typecheck`: passed.
- `pnpm lint`: passed with 12 pre-existing warnings outside the reviewed diff.
- Focused server regression set: 56/56 passed with `CLAUDE_CONFIG_DIR` unset.
- Server package: 2,319 passed, 7 skipped; one unrelated `GitManager.test.ts` case timed out under full-suite load and then passed alone (1/1) with `CLAUDE_CONFIG_DIR` unset.
- Web package: 1,994/1,994 passed.
- Contracts package: 271/271 passed.
- `pnpm exec vp check`: passed with the same pre-existing warnings.
