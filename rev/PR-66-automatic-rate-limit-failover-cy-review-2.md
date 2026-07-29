# PR 66 cy-review — automatic rate-limit failover — round 2

- Branch: `claude-rate-limit-failover`
- Base: `origin/dev` at `2daba4d15b9646f8e8afb5a050210ada860242f9`
- Reviewed head: `fdc8ffc3fdb3c8c09830ac47e6c0cc59e2a86f4b`
- Diff: `origin/dev...HEAD`
- PR: https://github.com/pandec/t3code/pull/66
- Round: 2
- Focus: second-order regressions from round-1 fixes
- Started: `2026-07-29`

## Fleet

Four Sol-medium reviewers covered the follow-up risk:

- Orchestration correctness reviewer — traced preferred and effective selections through turn start, runtime-mode changes, recovery, model caches, and one-hop routing.
- Health and ingestion specialist — reviewed concurrent evidence ownership, lifecycle admission, per-window aggregation, expiry, and classifier provenance.
- Adversarial solution reviewer — challenged the round-1 fixes at concurrency and state-boundary edges while keeping every accepted design decision fixed.
- Settings and test reviewer — checked deletion/clearing preservation and searched for missing regression tests around first-turn, runtime-mode, multi-window, and tool-error cases.

The executor independently validated the reported paths against the full branch diff and the round-1 fix commit before disposition.

## Summary

- Raw findings: 15
- Deduplicated findings kept for validation: 7
- Proposed fix now: 7
- Proposed deferred: 0
- Discarded at compilation: 8 duplicate reports

## Combined findings

| ID  | File:line                                             | Sources                 | Severity | Proposed disposition | Rationale                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------- | ----------------------- | -------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `ProviderCommandReactor.ts:245,759,847-876,1327-1332` | ORCH-1, ORCH-3, TEST-1  | HIGH     | fix now              | Round 1 stores effective B as the next routing origin. A runtime-mode change can therefore follow B's failover to C, and ignoring the runtime-mode ensure result leaves the effective Claude cache stale enough to cause a redundant restart. |
| C2  | `ProviderCommandReactor.ts:583-621`                   | ORCH-2, ADV-2, TEST-1   | MEDIUM   | fix now              | Omitted-selection auto-return depends on A's current config still naming active B. Clearing or changing that setting can strand an existing thread on B instead of re-resolving preferred A.                                                  |
| C3  | `ProviderInstanceHealthLive.ts:152-157`               | HEALTH-2, ADV-1         | HIGH     | fix now              | A successful turn clears structured provider-window rejections for the entire instance, so an older or concurrent success can erase a newer authoritative rejection.                                                                          |
| C4  | `ProviderRuntimeIngestion.ts:1418-1437`               | HEALTH-1                | HIGH     | fix now              | With no active turn, delayed or replayed completions are accepted for projection recovery and also mutate health before domain idempotency can reject duplicates. Health needs a stricter positive turn match than projection recovery.       |
| C5  | `ProviderInstanceHealthLive.ts:129-183`               | ADV-3                   | MEDIUM   | fix now              | A fallback turn-failure can survive a later structured rejection and its matching allowed verdict, keeping the instance limited for the fallback TTL after authoritative evidence cleared.                                                    |
| C6  | `ProviderInstanceHealthLive.ts:27-28`                 | HEALTH-3, ADV-4, TEST-3 | MEDIUM   | fix now              | Broad `rate.?limit` and `429` matches still classify recognizable tool/MCP/upstream-API throttles as provider-account limits and can reroute unrelated turns.                                                                                 |
| C7  | `ProviderInstanceHealthLive.ts:195-213`               | HEALTH-4, ADV-5, TEST-2 | MEDIUM   | fix now              | Multiple active windows return insertion order's first state, so the failover activity can advertise an earlier reset than the longest-lived active rejection.                                                                                |

## Deferred candidates

None.

## Discarded summary

Eight reports duplicated C1, C2, C3, C6, or C7. Settings review found no material defect: inbound failover references are removed with the deleted instance, provider-envelope fields are preserved, the `None` selection clears normally, and stale identifiers remain visibly clearable. Atomic `Ref` pruning, clock use, reset normalization, adapter stamping, missing-thread account signals, health-reporting isolation, and the accepted one-hop/compatibility/utilization/in-memory decisions otherwise remained sound.

## Validation plan

- Separate preferred routing provenance from effective bound-session selection, and update both turn-start and runtime-mode consumers.
- Make generic success own only generic turn-failure recovery; structured verdicts own structured window state.
- Apply turn-outcome health only to a positively matched active turn.
- Let structured verdicts supersede fallback turn-failure state.
- Reject recognizable tool/MCP-origin failures before account-limit pattern matching.
- Return the active health state with the latest effective expiry.
- Add focused regressions for runtime-mode no-chain, config-cleared auto-return, effective-cache refresh, concurrent structured rejection, no-active completion, structured-over-fallback ownership, tool/MCP false positives, and multiple active windows.

No item requires a product decision or deferral.

## Validated disposition

All seven combined findings were fixed:

- Thread selection state now retains both the preferred routing origin and the effective bound selection. Runtime-mode changes re-resolve from the preferred instance, update the effective cache, never chain through the failover target, and still return after the setting is cleared or changed.
- Generic success clears only generic turn-failure evidence. Structured rate-limit verdicts exclusively own provider-window state, supersede fallback failures, and aggregate to the longest-lived active rejection.
- Turn outcomes affect instance health only when the completion positively matches the active turn.
- Recognizable tool-execution, MCP, and upstream-API error prefixes are excluded from the unstructured account-limit fallback.
- Focused tests cover the first omitted turn, runtime-mode recovery and no-chain behavior, settings removal during failover, stale completions with and without an active turn, concurrent evidence ownership, tool-origin false positives, and multiple rejected windows.

Verification:

- `vp test run` on all eight test files changed by `origin/dev...HEAD`: 213 passed.
- `vp run typecheck`: passed.
- `vp check`: passed with 11 pre-existing warnings and no errors.
- `git diff --check`: passed.

No item is deferred.
