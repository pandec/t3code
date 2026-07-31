# PR 86 Mobile Attention Filter — cy-review

- Date: 2026-07-31
- Round: 1
- Branch: `t3code/mobile-attention-filter`
- Base: `origin/dev` at `96b4fc63a`
- PR: https://github.com/pandec/t3code/pull/86
- Diff: `origin/dev...048685cea`

## Fleet

| Reviewer                    | Primary responsibility                                                             |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Correctness and regression  | Sticky membership, desktop parity, pending tasks, multi-environment behavior       |
| Persistence and concurrency | Preference hydration, races, write frequency, failure paths                        |
| Native UI and accessibility | Header order, icon fidelity, disabled/loading semantics, compact and split layouts |
| Adversarial solution review | State ownership, lifecycle, performance, and design assumptions                    |

Four reviewers were used because this is stateful, cross-layout mobile UI with durable local state.

## Summary

- Raw findings: 11
- Kept after deduplication and source verification: 9
- Fix now: 9
- Deferred: 0
- Discarded: 0

## Combined findings

| Area                              | Source roles             | Severity | Disposition | Rationale                                                                                          |
| --------------------------------- | ------------------------ | -------- | ----------- | -------------------------------------------------------------------------------------------------- |
| Visit persistence write frequency | Persistence, adversarial | High     | Fix now     | Writing the full preference blob on every shell update can queue storage work during active turns. |
| Visit save failure retry          | Persistence              | Medium   | Fix now     | Preference rollback could retrigger the route effect indefinitely for one failed visit save.       |
| Visit-map update race             | Persistence              | Medium   | Fix now     | Whole-map patches derived in separate route effects could overwrite markers.                       |
| Visit-marker pruning              | Correctness, adversarial | Medium   | Fix now     | A 1,000-entry cap and cross-environment timestamp ordering diverged from desktop semantics.        |
| Pre-existing pending tasks        | Correctness              | Medium   | Fix now     | All queued rows bypassed the attention snapshot instead of only tasks appearing afterward.         |
| Hidden v2 filter lifecycle        | Adversarial              | Medium   | Fix now     | Disabling and re-enabling Thread List v2 could resurrect a stale sticky snapshot.                  |
| Android icon geometry             | Native UI                | Medium   | Fix now     | The Tabler approximation did not match the desktop ListFilter geometry.                            |
| Split-view disabled styling       | Native UI                | Low      | Fix now     | The disabled fallback control remained visually enabled during bootstrap.                          |
| Legacy iOS loading label          | Native UI                | Low      | Fix now     | VoiceOver announced the action rather than the loading state while the control was disabled.       |

## Fixes applied

- Visit markers now live in one provider-owned in-memory map, hydrate safely from preferences, and persist through one 500 ms coalescing path.
- Visit markers are no longer pruned, matching the desktop map semantics.
- Attention snapshots track queued-task identities separately: existing queued rows are excluded and newly appearing rows are admitted.
- Turning Thread List v2 off clears the shared sticky state.
- Android uses an exact SVG port of the desktop three-line ListFilter icon.
- Disabled styling and loading accessibility labels now match the other native header paths.

## Deferred candidates

None.
