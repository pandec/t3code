# PR 29 cy-review

- Target: `t3code/unarchive-project-settings-filter` -> `dev`
- PR: https://github.com/pandec/t3code/pull/29
- Date: 2026-07-24
- Diff base: `origin/dev`
- Round: 1

## Review fleet

| Reviewer                         | Primary responsibility                                      | Selection reason                                                                        |
| -------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Skeptical Code Reviewer          | Correctness, partial archive state, regressions, tests      | The change combines multi-environment snapshots with new filtering behavior.            |
| Adversarial Solution Reviewer    | URL contract, ownership, interaction semantics              | The project identity is shared between sidebar grouping and a routable settings filter. |
| Routing and State Reviewer       | Search serialization, stale state, navigation failures      | The new entry point crosses a native context menu and TanStack Router state.            |
| Accessibility and Reuse Reviewer | Announcements, labels, responsive filter UI, sidebar parity | The filter adds a new keyboard-accessible control and live result status.               |

Four reviewers were used because the change is stateful, cross-module UI functionality with a
user-visible URL contract.

## Summary

- Raw findings: 11
- Kept after deduplication: 8
- Fix now: 8
- Deferred: 0
- Discarded: 0

## Combined findings

| ID   | File                                                  | Source roles               | Severity | Disposition | Rationale                                                                                           |
| ---- | ----------------------------------------------------- | -------------------------- | -------- | ----------- | --------------------------------------------------------------------------------------------------- |
| CR-1 | `apps/web/src/components/settings/SettingsPanels.tsx` | skeptical, accessibility   | MEDIUM   | fix now     | A filtered zero-result state can be announced while another environment is still loading or failed. |
| CR-2 | `apps/web/src/components/settings/SettingsPanels.tsx` | skeptical                  | LOW      | fix now     | A logical group without loaded archive data falls back to an arbitrary member title.                |
| CR-3 | `apps/web/src/components/SidebarV2.tsx`               | adversarial, accessibility | MEDIUM   | fix now     | Sidebar V2 replaces V1 but has no project-scoped archive entry point.                               |
| CR-4 | `apps/web/src/routes/settings.archived.tsx`           | adversarial, routing       | MEDIUM   | fix now     | A logical project key changes with grouping settings and makes history/deep links stale.            |
| CR-5 | `apps/web/src/components/Sidebar.tsx`                 | adversarial                | LOW      | fix now     | “Unarchive...” implies an immediate mutation although the action opens archive management.          |
| CR-6 | `apps/web/src/components/settings/SettingsPanels.tsx` | accessibility              | MEDIUM   | fix now     | Same-named projects produce indistinguishable filter options.                                       |
| CR-7 | `apps/web/src/components/settings/SettingsPanels.tsx` | adversarial                | LOW      | fix now     | The all-projects sentinel shares a namespace with valid project keys.                               |
| CR-8 | `apps/web/src/components/Sidebar.tsx`                 | routing                    | LOW      | fix now     | Router rejection is unhandled, and mobile closes before successful navigation.                      |

## Deferred candidates

No items deferred this round.

## Discarded summary

No candidate findings were discarded.
