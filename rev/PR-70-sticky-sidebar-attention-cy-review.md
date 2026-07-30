# PR #70 cy-review — sticky sidebar attention filter

- Date: 2026-07-30
- Round: 1
- Branch: `t3code/fix-sidebar-active-ordering`
- Base: `origin/dev`
- PR: https://github.com/pandec/t3code/pull/70
- Diff: `origin/dev...HEAD`

## Review fleet

Four Sol-medium reviewers were used because the diff is narrow but stateful and multi-environment:

- Skeptical correctness reviewer — snapshot semantics, lifecycle regressions, and tests
- Adversarial solution reviewer — state ownership, admission boundaries, and simpler alternatives
- React lifecycle specialist — hydration, reconnects, effects, and stale state
- Accessibility/test specialist — toggle semantics, labels, touch target, and coverage

## Summary

- Raw findings: 8
- Deduplicated candidates: 5
- Fix now: 4
- Deferred: 0
- Discarded after verification: 1

## Combined findings

| ID    | File                                           | Sources                   | Severity | Disposition | Rationale                                                                                                                                                                                                              |
| ----- | ---------------------------------------------- | ------------------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY-01 | `apps/web/src/components/Sidebar.logic.ts:565` | ADV-02, SKEP-002, LIFE-01 | Medium   | Fix now     | Comparing the browser clock with a remote environment's `createdAt` can permanently reject a genuinely new CLI or other-client thread. Admit every previously unknown shell key after the activation baseline instead. |
| CY-02 | `apps/web/src/components/SidebarV2.tsx:1504`   | SKEP-001, LIFE-02         | High     | Fix now     | Activation before shell bootstrap can capture an incomplete baseline. Disable activation until the existing all-environment bootstrap signal says current shells are available.                                        |
| CY-03 | `apps/web/src/components/SidebarV2.tsx:1540`   | ADV-01                    | Medium   | Fix now     | Capturing only the current project scope makes later scope changes asymmetric. Capture attention membership across all unarchived threads and keep project scope as a render-time intersection.                        |
| CY-04 | `apps/web/src/components/SidebarV2.tsx:2857`   | A11Y-001                  | Low      | Fix now     | The toggle's accessible name should stay stable, and “Show all threads” overstates what clearing the attention filter does while a project scope remains active.                                                       |
| CY-05 | `apps/web/src/components/Sidebar.logic.ts:574` | ADV-03                    | Medium   | Discard     | Adding existing nonmembers when their status later changes would violate the user's explicit frozen-snapshot rule. Only previously unknown thread identities join until the user toggles the filter off and on again.  |

## Deferred candidates

None.

## Discarded summary

One proposed monotonic status filter was rejected because it conflicts with the requested sticky snapshot semantics. The reviewed React effect itself converges by reference equality, has no Strict Mode loop, and synchronously includes newly admitted keys without a one-frame omission.
