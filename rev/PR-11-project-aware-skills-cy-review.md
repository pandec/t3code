# PR #11 cy-review

- Target: `agent/project-aware-skills` -> `dev`
- PR: https://github.com/pandec/t3code/pull/11
- Date: 2026-07-20
- Diff base: `origin/dev`
- Round: 1

## Review fleet

Three parallel Sol-medium reviewers were used, the largest fleet available alongside the accountable primary agent and sufficient for this focused cross-layer change.

- Skeptical code reviewer: correctness, regressions, and test coverage.
- Adversarial solution reviewer: solution scope, ownership, and upstream-maintenance cost.
- Async integration reviewer: process lifecycle, cache behavior, performance, and client integration.

## Summary

- Raw findings: 2
- Kept findings: 2
- Fix now: 2
- Deferred: 0
- Discarded: 0

## Combined findings

| ID   | Location                                                  | Source            | Severity | Disposition | Rationale                                                                                                                                                                            |
| ---- | --------------------------------------------------------- | ----------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CY-1 | `apps/web/src/components/ChatView.tsx:5405`               | Async integration | MEDIUM   | Fix now     | Sent-message rendering still receives snapshot-only skills, so repo-local skill chips disappear after sending.                                                                       |
| CY-2 | `apps/mobile/src/features/threads/ThreadComposer.tsx:425` | Skeptical code    | MEDIUM   | Fix now     | Mobile composer and feed still use snapshot-only skills; the new-task editor also lacks the existing skill suggestion popover despite having environment, instance, and project cwd. |

## Deferred candidates

None.

## Discarded summary

No findings were discarded.
