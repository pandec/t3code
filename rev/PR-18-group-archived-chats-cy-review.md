# PR 18 cy-review — round 1

- Target: `t3code/group-archived-chats` → `dev`
- PR: https://github.com/pandec/t3code/pull/18
- Date: 2026-07-21
- Diff base: `origin/dev...HEAD`
- Round: 1

## Review fleet

| Reviewer                      | Primary responsibility                                       | Reason                                              |
| ----------------------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| Skeptical code reviewer       | Correctness, regressions, failure paths, tests               | Cross-environment async data and grouping behavior  |
| Adversarial solution reviewer | Boundaries, reuse, state ownership                           | Validate consistency with existing sidebar grouping |
| Accessibility/UI specialist   | Disclosure semantics, keyboard behavior, responsive metadata | New fold control and row presentation               |

All reviewers ran read-only with `gpt-5.6-sol` at medium reasoning effort.

## Summary

- Raw findings: 5
- Unique kept findings: 4
- Fix now: 3
- Deferred: 1
- Discarded or deduplicated: 1

## Combined findings

| ID  | File:line                                                  | Sources   | Severity | Disposition | Rationale                                                                                                                            |
| --- | ---------------------------------------------------------- | --------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| CR1 | `apps/web/src/components/settings/SettingsPanels.tsx:1708` | AX1, ADV1 | Medium   | Fix now     | Search forces a section open while its enabled minus control only mutates hidden future state.                                       |
| CR2 | `apps/web/src/components/settings/SettingsPanels.tsx:1675` | SK1       | Medium   | Fix now     | Successful snapshots can hide a simultaneous environment failure, presenting an incomplete archive as complete.                      |
| CR3 | `apps/web/src/archivedThreadGrouping.ts:58`                | ADV2      | Medium   | Fix now     | Project membership is derived only from members with archived threads, so the representative and label can diverge from the sidebar. |
| CR4 | `apps/web/src/archivedThreadGrouping.ts:58`                | SK2       | Medium   | Defer       | Without repository identity there is no safe cross-environment grouping key; title or basename heuristics risk false merges.         |

## Deferred candidates

| ID  | Follow-up boundary                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR4 | Decide whether repository identity must be persisted durably for archived projects or whether an explicit user-controlled fallback grouping policy is acceptable. |

## Discarded summary

- One collapse/search finding duplicated the same underlying interaction defect and was merged into CR1.
