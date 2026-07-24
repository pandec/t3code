# PR 32 cy-review — final agent navigator

- Target: `t3code/add-user-message-navigator` → `dev`
- PR: https://github.com/pandec/t3code/pull/32
- Date: 2026-07-24
- Diff base: `origin/dev`
- Round: 3

## Review fleet

| Reviewer                      | Primary responsibility                                                   |
| ----------------------------- | ------------------------------------------------------------------------ |
| Lifecycle reviewer            | Persisted projection, replay, cache, and live reducer convergence        |
| Adversarial solution reviewer | Contract boundaries, forks/imports, and hidden failure modes             |
| Interaction reviewer          | Sparse geometry, pointer targeting, preview placement, and accessibility |
| Efficiency/test reviewer      | Hot-path allocation, query shape, maintainability, and coverage          |

## Summary

- Raw findings: 10
- Kept after deduplication: 9
- Fixed now: 7
- Partially fixed: 1
- Deferred: 2
- Discarded: 0

## Combined findings

| ID    | Severity | Disposition | Resolution                                                                                                                                                                      |
| ----- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY3-1 | HIGH     | fixed       | Same-sequence warm refreshes now hydrate authoritative completed-response IDs from the server.                                                                                  |
| CY3-2 | HIGH     | fixed       | Same-turn message and checkpoint rebinding removes the previous response ID before adding its replacement.                                                                      |
| CY3-3 | HIGH     | fixed       | A late `missing` checkpoint can no longer overwrite a previously persisted ready/error checkpoint turn.                                                                         |
| CY3-4 | MEDIUM   | fixed       | Sparse pointer targeting compares continuous rail position directly with rendered marker positions.                                                                             |
| CY3-5 | LOW      | fixed       | Preview edge clamping now uses endpoints in the full turn-position space.                                                                                                       |
| CY3-6 | MEDIUM   | fixed       | Running assistant chunks preserve the completed-ID array when membership is unchanged.                                                                                          |
| CY3-7 | LOW      | fixed       | Snapshot ordering now follows the existing `(thread_id, requested_at)` turn index.                                                                                              |
| CY3-8 | HIGH     | partial     | Forks now copy completed turn identity with rewritten assistant IDs. Imported history remains conservatively unmarked because its event contract has no turn/finality metadata. |
| CY3-9 | MEDIUM   | deferred    | Delayed final messages for a non-latest historical turn cannot be classified live from the current event payload; the next authoritative snapshot converges the state.          |

## Verification

Focused reducer, cache synchronization, projection, snapshot, minimap, and component tests pass (135
tests), including warm-cache hydration, same-turn rebinding, ready-to-missing checkpoint replay,
forked completed turns, streaming no-op identity, and sparse marker geometry.
