# PR 29 cy-review round 2

- Target: `t3code/unarchive-project-settings-filter` -> `dev`
- PR: https://github.com/pandec/t3code/pull/29
- Date: 2026-07-24
- Diff base: `origin/dev`
- Round: 2

## Review fleet

| Reviewer                       | Primary responsibility                                    | Selection reason                                                           |
| ------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| Skeptical Correctness Reviewer | Scoped-ID resolution, snapshot merging, incomplete states | Round 1 materially changed the filter identity and aggregation logic.      |
| Adversarial Solution Reviewer  | Revised contract, boundaries, scope                       | The stable-ID design needed an independent challenge after implementation. |
| UI and State Reviewer          | Runtime navigation, controlled select, live announcements | The revised patch changed both sidebars and asynchronous status semantics. |
| Tests and Reuse Reviewer       | Helper API, race coverage, collisions                     | Round 1 introduced a shared helper module and new focused tests.           |

## Summary

- Raw findings: 9
- Kept after deduplication: 3
- Fix now: 3
- Deferred: 0
- Discarded: 0

## Combined findings

| ID   | File                                                  | Source roles  | Severity | Disposition | Rationale                                                                                                                       |
| ---- | ----------------------------------------------------- | ------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| R2-1 | `apps/web/src/components/settings/SettingsPanels.tsx` | all reviewers | HIGH     | fix now     | An empty environment catalog can look authoritative and clear a valid scoped URL before discovery and shell bootstrap complete. |
| R2-2 | `apps/web/src/components/settings/SettingsPanels.tsx` | all reviewers | MEDIUM   | fix now     | Same-name/same-path cross-environment options and the appended zero-archive option can still have identical visible labels.     |
| R2-3 | `apps/web/src/components/settings/SettingsPanels.tsx` | UI and State  | LOW      | fix now     | Loading and failure transitions are announced by both the compact live region and a status/alert section.                       |

## Deferred candidates

No items deferred this round.

## Discarded summary

No candidate findings were discarded.
