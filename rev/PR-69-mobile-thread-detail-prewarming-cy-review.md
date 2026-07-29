# PR 69 cy-review — mobile thread-detail prewarming

- Branch: `t3code/ios-background-message-sync`
- Base: `origin/dev`
- Diff: `git diff origin/dev...HEAD`
- Diff base: `27a50aa6c7a8bc2b460fa5f3db34357db2c17e69`
- Reviewed head: `0b4cf1ecec441bc4f8603467d46d6beb955516cb`
- PR: https://github.com/pandec/t3code/pull/69
- Date: 2026-07-29
- Round: 1

## Review fleet

Four Sol-medium reviewers were used in two waves because the session provides
four total agent slots including the executing agent.

- Skeptical code reviewer — broad correctness, regression, and focused-test
  coverage across the full diff.
- Async lifecycle specialist — supervisor generations, wakeups, environment
  re-registration, scoped stream cleanup, and dynamic atom dependencies.
- Cache/concurrency specialist — cooldown scheduling, concurrent counters,
  sequence guards, SQLite persistence ordering, and mounted-thread interaction.
- Adversarial solution reviewer — challenged the local design and persistence
  boundaries while honoring the explicitly accepted v1 trade-offs.

## Summary

- Raw reviewer findings: 7
- Unique candidates after deduplication: 4
- Kept findings: 3
- Fix now: 3
- Deferred: 0
- Discarded: 1

The lifecycle, dependency provisioning, and atom-mounting design is coherent:
`ConnectionWakeups` comes from the same mobile connection layer used by thread
state; `followStreamInEnvironment` switches the scoped stream when an entry is
removed, replaced, or re-added; and dynamic atom dependencies unmount removed
environment streams. `Stream.changes` correctly deduplicates repeated connected
states within one supervisor while allowing a new generation or replacement
supervisor to trigger.

The mutable counters inside `Effect.forEach({ concurrency: 2 })` are also safe
in this runtime. Each increment is synchronous JavaScript between Effect yield
points, and the aggregate is read only after `forEach` joins both fibers.

The environment-global sequence comment is correct in the direction it claims:
a detail snapshot taken at or after the shell high-water cursor includes every
thread event visible to that older shell. It is deliberately conservative in
the other direction and can refetch after unrelated environment activity.

## Combined findings

| ID      | File:line                                                                                                   | Source roles                                         | Severity | Disposition | Rationale                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LIFE-1  | `packages/client-runtime/src/state/threadPrewarm.ts:199`                                                    | Skeptical, lifecycle, cache/concurrency, adversarial | MEDIUM   | fix now     | The cooldown timestamp is recorded before prerequisites or a completed run exist. A foreground wakeup during reconnect can return no status and suppress the subsequent connected-generation run for 60 seconds. Record cooldown only after a real pass returns a status, and add a foreground-before-connect regression test.                                                                                       |
| CACHE-1 | `packages/client-runtime/src/state/threadPrewarm.ts:90`; `packages/client-runtime/src/state/threads.ts:114` | Cache/concurrency, executing verification            | MEDIUM   | fix now     | Cache write ordering is only guarded on the warmer side, and that guard still permits equal-sequence replacement. A mounted thread can later persist an older snapshot over a newer prewarm; conversely, an equal-sequence prewarm can replace a richer artifact-hydrated open-thread snapshot. Reject equal-or-newer stored data in the warmer and reject strictly newer stored data in mounted-thread persistence. |
| CACHE-2 | `packages/client-runtime/src/state/threadPrewarm.ts:142`                                                    | Adversarial                                          | MEDIUM   | fix now     | A cached settled candidate can start streaming before its detail fetch completes. Recheck the fetched detail before persistence so the warmer preserves the established rule that active thread snapshots are server-authoritative and not written to offline cache.                                                                                                                                                 |

## Deferred candidates

None.

## Discarded summary

One efficiency suggestion proposed skipping detail fetches when a cached
thread's shell-visible timestamp matched the candidate. The global cursor is
coarse and may cause redundant fetches after unrelated events, but the proposed
timestamp shortcut is not a complete thread-detail freshness contract and
could skip real detail-only changes. The current five-thread limit and cooldown
make the conservative predicate preferable for this v1.

## Resolution and verification

- Cooldown begins only after a pass returns a status, so missing prerequisites,
  timeouts, and failures do not suppress the next valid lifecycle trigger.
- Prewarm persistence rejects equal-or-newer stored snapshots and rechecks the
  fetched session state before writing.
- Mounted thread persistence checks the stored sequence and cannot overwrite a
  newer prewarmed snapshot; equal-sequence saves remain allowed so the open path
  can persist message-artifact hydration.
- Focused tests passed: 23 tests across `threadPrewarm.test.ts` and
  `threads-sync.test.ts`.
- `vp run typecheck` passed with pre-existing suggestions only.
- `vp check` passed with 0 errors and 11 pre-existing warnings outside the
  reviewed files.
