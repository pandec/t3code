# PR #30 cy-review — round 2

- Target: `t3code/undo-archived-thread` → `dev`
- PR: https://github.com/pandec/t3code/pull/30
- Date: 2026-07-24
- Diff base: `origin/dev`
- Reviewed commit: `5ca94fadf69167119d8ea21337bd12287fefd954`

## Fleet

| Reviewer                      | Primary responsibility                                        |
| ----------------------------- | ------------------------------------------------------------- |
| Skeptical Code Reviewer       | Fresh correctness and regression review after round-1 fixes   |
| Adversarial Solution Reviewer | Re-check interaction boundaries and state ownership           |
| Async/Focus Specialist        | Promotion, focus, and route races during asynchronous restore |

Three reviewers were sufficient for the narrowed second pass because round 1 had already covered reuse and general maintainability.

## Summary

- Raw findings: 1
- Deduplicated kept findings: 1
- Fix now: 1
- Deferred: 0 new; the round-1 preview/webview item remains deferred
- Discarded: 0

## Combined findings

| ID    | File:line                          | Sources | Severity | Disposition | Rationale                                                                                                                                                                                                      |
| ----- | ---------------------------------- | ------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY2-1 | `apps/web/src/routes/_chat.tsx:56` | AF2-1   | MEDIUM   | fix now     | A first send clears composer content before the draft has `promotedTo` or a readable server shell, so archive undo can misclassify a visible optimistic conversation as an empty new thread and navigate away. |

## Deferred candidates

No new deferred items. CY5 from round 1 remains valid.

## Fix verification

- CY2-1: Draft submissions now publish a synchronous in-flight signal before the composer is cleared and remove it when the first-send attempt finishes.
- Blank-draft classification treats that signal like a materialized conversation, so a visible optimistic send stays in place and receives the restore toast.
- Focused tests: 9 passed.
- Required gates: `vp check` and `vp run typecheck` passed.

## Discarded summary

No findings were discarded.
