# PR 66 cy-review — automatic rate-limit failover — round 1

- Branch: `claude-rate-limit-failover`
- Base: `origin/dev` at `2daba4d15b9646f8e8afb5a050210ada860242f9`
- Reviewed head: `980c233d502a02699015f4faf687ce83d8394ef9`
- Diff: `origin/dev...HEAD`
- PR: https://github.com/pandec/t3code/pull/66
- Round: 1
- Started: `2026-07-29T09:15:00Z`

## Fleet

Four Sol-medium reviewers covered the substantial cross-module change:

- Orchestration correctness reviewer — traced desired-to-effective selection state through every `ensureSessionForThread` consumer, recovery path, and activity-dedupe branch.
- Health and ingestion specialist — reviewed per-window state, TTL/clock behavior, concurrency, classification, event stamping, and ingestion failure isolation.
- Adversarial solution reviewer — challenged state ownership and integration boundaries while treating the explicitly accepted routing decisions as fixed constraints.
- Settings and test reviewer — reviewed select clearing, deletion cleanup, envelope-field preservation, and focused regression coverage.

The executor independently traced the same paths, verified every kept finding in surrounding code, and checked provider continuation identities and capability contracts before disposition.

## Summary

- Raw findings: 14
- Deduplicated findings kept for validation: 9
- Proposed fix now: 9
- Proposed deferred: 0
- Discarded at compilation: 5 duplicate reports

## Combined findings

| ID  | File:line                               | Sources               | Severity | Proposed disposition | Rationale                                                                                                                                                                                                |
| --- | --------------------------------------- | --------------------- | -------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `ProviderCommandReactor.ts:571,715`     | ORCH-1                | MEDIUM   | fix now              | A schema-valid turn without `modelSelection` does not detect that the active session is still on the failover target, so the preferred instance is not restored after its limit clears.                  |
| C2  | `ProviderCommandReactor.ts:588`         | ORCH-2, ADV-3         | MEDIUM   | fix now              | The activity feed announces failover before continuation validation or session start succeeds, leaving false and potentially repeated notices on failed starts and recovery.                             |
| C3  | `ProviderInstanceHealthLive.ts:51,111`  | HEALTH-1              | HIGH     | fix now              | Claude emits one status per rate-limit window, but an allowed event for one window clears a rejection for every window on the instance.                                                                  |
| C4  | `ProviderRuntimeIngestion.ts:1345,1396` | HEALTH-2              | HIGH     | fix now              | A stale/conflicting `turn.completed` mutates health before the lifecycle guard rejects it.                                                                                                               |
| C5  | `ProviderRuntimeIngestion.ts:1345`      | HEALTH-3, ADV-2, UI-3 | MEDIUM   | fix now              | A defect in auxiliary health reporting aborts ingestion of the original runtime event instead of logging and continuing.                                                                                 |
| C6  | `ProviderInstanceHealthLive.ts:147`     | HEALTH-4, ADV-1       | MEDIUM   | fix now              | Expiry uses a read-then-delete sequence that can erase a fresh concurrent rejection.                                                                                                                     |
| C7  | `SettingsPanels.tsx:1635`               | ADV-4, UI-1           | LOW      | fix now              | Deleting a target instance leaves inbound `failoverInstanceId` references dangling and silently inert.                                                                                                   |
| C8  | `ProviderInstanceHealthLive.ts:27`      | UI-2                  | MEDIUM   | fix now              | Unqualified `limit reached` text can classify output, recursion, context, or tool limits as an account rate limit and reroute later turns.                                                               |
| C9  | focused test files                      | UI-4                  | MEDIUM   | fix now              | Tests miss the concrete omitted-selection return, unsuccessful activity, cross-window state, stale completion, health-defect isolation, deletion cleanup, and false-positive classification paths above. |

## Deferred candidates

None.

## Discarded summary

Five raw reports duplicated C2, C5, C6, or C7. Adapter stamping was verified sound: Claude binds the instance before queue emission, while `ProviderService` independently stamps every source stream with its registry-owned instance. The seconds/milliseconds reset heuristic and Effect clock basis are appropriate for the provider payloads. The accepted in-memory, one-hop, stay-put, continuation-group, utilization-only, and auto-return decisions were not re-litigated.

## Validated disposition

All nine combined findings were local correctness or regression-proofing issues requiring no product decision:

- Routing now detects return from the configured failover when an unchanged selection is omitted, keeps the effective-selection cache aligned, and preserves the effective target across runtime-mode restarts until the next turn re-evaluates the preferred instance.
- Failover activity is emitted best-effort only after a successful session bind; failed starts and rejected switches do not leave a false notice.
- Health tracks Claude window verdicts independently, prunes expiry atomically, narrows unstructured failure classification, and applies turn outcomes only after lifecycle validation.
- Health reporting defects are logged locally and cannot suppress the runtime event; account-level signals are still learned before an unknown-thread bail.
- Deleting an instance removes inbound failover references while preserving every unrelated provider-envelope field.
- Focused tests cover the concrete regressions plus one-hop and continuation-compatibility contracts.

No item is deferred.
