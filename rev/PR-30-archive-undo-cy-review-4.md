# PR #30 cy-review — round 4

- Target: `t3code/undo-archived-thread` → `dev`
- PR: https://github.com/pandec/t3code/pull/30
- Date: 2026-07-24
- Diff base: `origin/dev`
- Reviewed commit: `bddeab3e9`

## Fleet

| Reviewer                      | Primary responsibility                               |
| ----------------------------- | ---------------------------------------------------- |
| Correctness Reviewer          | Final correctness and regression review              |
| Adversarial Solution Reviewer | Shortcut ownership and interaction-boundary critique |
| Async/Focus Specialist        | Marker cleanup and stale-state lifecycle risks       |

## Summary

- Raw findings: 4
- Deduplicated kept findings: 4
- Fix now: 3
- Deferred: 1
- Discarded: 0

## Combined findings

| ID    | File:line                                    | Severity | Disposition | Rationale                                                                                                                                                                           |
| ----- | -------------------------------------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY4-1 | `apps/web/src/routes/_chat.tsx:128`          | MEDIUM   | fix now     | Command+Z with no archive candidate returned before configured shortcut dispatch, suppressing another command if the user assigned the same chord.                                  |
| CY4-2 | `apps/web/src/hooks/useThreadActions.ts:177` | MEDIUM   | defer       | Multi-select archive is one UI action but the latest-only undo contract restores only the final archived thread. Batch versus repeated single-thread undo needs a product decision. |
| CY4-3 | `apps/web/src/archiveUndo.ts:82`             | MEDIUM   | fix now     | The floating-layer selector missed generic `aria-modal` dialogs such as the expanded-image viewer.                                                                                  |
| CY4-4 | `apps/web/src/draftSubmissionState.ts:15`    | LOW      | fix now     | Successful draft IDs were retained until shortcut evaluation rather than being cleared by normal server-thread observation.                                                         |

## Fix verification

- CY4-1: Command+Z falls through to normal configured shortcut dispatch when no archive candidate exists.
- CY4-3: Any open `[aria-modal="true"]` layer now blocks background archive undo.
- CY4-4: ChatView clears the durable marker as soon as it observes the server thread.
- Focused tests: 11 passed.
- Required gates: `vp check` and `vp run typecheck` passed.

## Discarded summary

No findings were discarded.
