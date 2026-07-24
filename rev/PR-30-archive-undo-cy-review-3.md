# PR #30 cy-review — round 3

- Target: `t3code/undo-archived-thread` → `dev`
- PR: https://github.com/pandec/t3code/pull/30
- Date: 2026-07-24
- Diff base: `origin/dev`
- Reviewed commit: `dd0c30143`

## Fleet

| Reviewer                      | Primary responsibility                                  |
| ----------------------------- | ------------------------------------------------------- |
| Correctness Reviewer          | Keyboard semantics, state ownership, and regressions    |
| Adversarial Solution Reviewer | Challenge the final route-state interaction contract    |
| Async/Focus Specialist        | Mutation, promotion, route, and error-recovery ordering |

## Summary

- Raw findings: 1
- Deduplicated kept findings: 1
- Fix now: 1
- Deferred: 0 new; the round-1 preview/webview item remains deferred
- Discarded: 0

## Combined findings

| ID    | File:line                                   | Sources | Severity | Disposition | Rationale                                                                                                                                                                                                          |
| ----- | ------------------------------------------- | ------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CY3-1 | `apps/web/src/components/ChatView.tsx:4874` | AS3-1   | MEDIUM   | fix now     | A successful first send could clear its in-flight signal before the subscribed thread shell or promotion marker arrived, briefly allowing archive undo to misclassify the active optimistic conversation as empty. |

## Fix verification

- CY3-1: Successful first submissions now keep a synchronous materialization marker until the promoted thread or server shell is observed; failed submissions clear it immediately.
- Focused tests: 10 passed.
- Required gates: `vp check` and `vp run typecheck` passed.

## Discarded summary

No findings were discarded.
