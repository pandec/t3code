# PR 67 cy-review — failover routing extraction

- Branch: `failover-routing-extraction`
- Base: `origin/dev`
- Diff: `git diff origin/dev...HEAD`
- Diff base: `f5c0e79c7dec8742ab69ae1492ed6de1549bd1b8`
- PR: https://github.com/pandec/t3code/pull/67
- Date: 2026-07-29
- Round: 1

## Review fleet

Three Sol-medium reviewers were used because the session provides four total
agent slots including the executing agent.

- Semantic equivalence reviewer — differential truth-table reasoning against the
  pre-extraction reactor, with emphasis on restart, notice, and selection-state
  triggers.
- Adversarial integration reviewer — Effect service binding, error channels,
  reroute info/driver ownership, call-site ordering, and scope coherence.
- Contract-test reviewer — whether the new unit tests pin the old contract
  independently of the extracted implementation.

## Summary

- Raw findings: 4
- Kept findings: 4
- Fix now: 4
- Deferred: 0
- Discarded: 0

The production extraction is behaviorally equivalent to the inline
implementation. The fixes below strengthen independent evidence for two subtle
contract boundaries and remove one unrelated documentation edit.

## Combined findings

| ID     | File:line                                                       | Source                  | Severity | Disposition | Rationale                                                                                                                                                                               |
| ------ | --------------------------------------------------------------- | ----------------------- | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADV-1  | `README.md:44`                                                  | Adversarial integration | LOW      | fix now     | The Claude-shadow wording change is unrelated to the failover-routing extraction and weakens the PR's pure-refactor boundary.                                                           |
| TST-1  | `apps/server/src/provider/rateLimitFailoverRouting.test.ts:129` | Contract tests          | LOW      | fix now     | No test proves that a typed missing-target lookup failure is converted to “stay on preferred,” although both old and new production code intentionally use `Effect.option`.             |
| TST-2  | `apps/server/src/provider/rateLimitFailoverRouting.test.ts:261` | Contract tests          | LOW      | fix now     | No test pins the old distinction where instance equality can produce a return notice but full selection equality is still required for implicit restart comparison and state recording. |
| EXEC-1 | `apps/server/src/provider/rateLimitFailoverRouting.test.ts:97`  | Executing reviewer      | LOW      | fix now     | No direct test pins the old initialization from an explicit request on the no-failover path: restart comparison must remain the request and state recording must remain enabled.        |

## Differential equivalence evidence

- `recordSelectionState` is algebraically equivalent to the old
  `shouldRecordSelectionState`: explicit requests record; valid failovers always
  record; omitted requests record only for the full-equality route-back branch.
- `restartComparisonSelection` matches the old
  `effectiveRequestedModelSelection`: requested selection initially, rerouted
  target on failover, preferred selection on a full-equality implicit route
  back, otherwise undefined.
- The new instance-only `routingBack` predicate matches the old return-notice
  block. Its additional full `Equal.equals` check applies only to restart
  comparison, matching the old `else if`.
- Return-notice resolution remains after failover-target resolution and
  independently follows the outcome guard, including explicit requests.
- `boundInfo` is the failover target's routing info after reroute, so
  continuation guards still compare against the target.
- `desiredDriverKind` and `preferredProvider` remain derived before reroute.
  This is equivalent because a valid failover target is required to have the
  same `driverKind`.
- `ProviderService.getInstanceInfo` is an arrow closure over `registry`, so
  storing it as a bare dependency does not lose `this`.
- `Effect.option` remains around the same typed lookup; typed service failures
  become “no target,” while defects and interruption still propagate.
- Reuse, restart, and fresh-start paths retain the same activity append and
  selection-state ordering.

## Deferred candidates

None.

## Resolution and verification

- Removed the unrelated Claude-shadow README wording change.
- Added focused tests for explicit-request state initialization, typed
  missing-target fallback, and the instance-only notice/full-selection restart
  boundary.
- `vp test run apps/server/src/provider/rateLimitFailoverRouting.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
  passed: 63 tests.
- `vp run typecheck` passed.
- `vp check` passed with 0 errors and 11 pre-existing warnings outside the
  reviewed files.

## Discarded summary

No candidate findings were discarded.
