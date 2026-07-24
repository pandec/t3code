# PR #30 cy-review — round 1

- Target: `t3code/undo-archived-thread` → `dev`
- PR: https://github.com/pandec/t3code/pull/30
- Date: 2026-07-24
- Diff base: `origin/dev`
- Reviewed commit: `4f8e97785a143677cb55d025635029dc5fea16d1`

## Fleet

| Reviewer                      | Primary responsibility                                                |
| ----------------------------- | --------------------------------------------------------------------- |
| Skeptical Code Reviewer       | Correctness, regressions, failure paths, and missing coverage         |
| Adversarial Solution Reviewer | Interaction boundaries, ownership, and simpler alternatives           |
| Design and Reuse Reviewer     | State lifecycle, existing patterns, and maintainability               |
| Async/Focus Specialist        | Keyboard propagation, focus arbitration, races, and navigation timing |

Four reviewers were justified because the change is stateful, asynchronous, route-sensitive, and spans archive lifecycle plus browser keyboard behavior.

## Summary

- Raw findings: 10
- Deduplicated kept findings: 5
- Fix now: 4
- Deferred: 1
- Discarded: 0

## Combined findings

| ID  | File:line                                    | Sources            | Severity | Disposition | Rationale                                                                                                                                                                        |
| --- | -------------------------------------------- | ------------------ | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY1 | `apps/web/src/routes/_chat.tsx:116`          | AD1                | MEDIUM   | fix now     | A promoted/materialized conversation can remain temporarily on a draft URL after send, so route kind plus empty composer is not sufficient to identify a blank new-thread state. |
| CY2 | `apps/web/src/hooks/useThreadActions.ts:224` | AD2, AF2, DR1, SK3 | MEDIUM   | fix now     | Deleting the archived candidate leaves an impossible undo entry that is re-armed after every failed restore.                                                                     |
| CY3 | `apps/web/src/routes/_chat.tsx:111`          | AF3, DR2, SK2      | LOW      | fix now     | Repeated keydown events can immediately retry a failed restore and stack mutations/toasts.                                                                                       |
| CY4 | `apps/web/src/routes/_chat.tsx:107`          | SK1                | MEDIUM   | fix now     | Non-editable controls inside an open dialog, menu, popover, select, or combobox can trigger archive undo behind the active overlay.                                              |
| CY5 | `apps/web/src/routes/_chat.tsx:95`           | AF1                | MEDIUM   | defer       | Electron webview key events do not bubble to the host shortcut listener; changing guest-page Command+Z ownership requires a broader product and IPC decision.                    |

## Deferred candidates

| ID  | Scope                                        | Reason                                                                                                                                                                                                                   |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CY5 | Embedded preview/webview shortcut forwarding | The confirmed request covered app chrome such as empty space and the sidebar. Forwarding Command+Z out of guest content could override webpage-native undo and needs an explicit product decision plus desktop IPC work. |

## Fix verification

- CY1: Blank-draft detection now excludes promoted or otherwise materialized server conversations and re-checks the live state after unarchive completes.
- CY2: Both successful thread deletion paths invalidate the matching undo candidate.
- CY3: Repeated keydown events no longer match the archive-undo shortcut.
- CY4: Open dialogs, sheets, menus, popovers, selects, comboboxes, autocompletes, command dialogs, and model pickers suppress archive undo.
- Focused tests: 8 passed.
- Required gates: `vp check` and `vp run typecheck` passed.

## Discarded summary

No findings were discarded.
