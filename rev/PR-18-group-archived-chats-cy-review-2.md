# PR 18 cy-review — round 2

- Target: `t3code/group-archived-chats` → `dev`
- PR: https://github.com/pandec/t3code/pull/18
- Date: 2026-07-21
- Diff base: `origin/dev...HEAD`
- Round: 2

## Review fleet

| Reviewer                      | Primary responsibility                                | Reason                                                       |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| Skeptical code reviewer       | Correctness and producer-contract validation          | Recheck round-1 data-membership fix against the server query |
| Adversarial solution reviewer | Existing grouping semantics and normalization         | Detect divergence from sidebar duplicate handling            |
| Accessibility/UI specialist   | Disclosure semantics, announcements, responsive names | Recheck the revised interaction and shared layout            |

All reviewers ran read-only with `gpt-5.6-sol` at medium reasoning effort.

## Summary

- Raw findings: 6
- Unique kept findings: 5
- Fix now: 5
- Newly deferred: 0
- Carried deferred: 1
- Deduplicated: 1

## Combined findings

| ID    | File:line                                                  | Sources       | Severity | Disposition | Rationale                                                                                                                                                          |
| ----- | ---------------------------------------------------------- | ------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CR2-1 | `apps/web/src/archivedThreadGrouping.ts:45`                | SK2-1, ADV2-1 | Medium   | Fix now     | The server omits primary members without archived threads, making the round-1 test fixture impossible; live project membership must supplement archived snapshots. |
| CR2-2 | `apps/web/src/archivedThreadGrouping.ts:47`                | ADV2-2        | Medium   | Fix now     | Independent grouping bypasses the sidebar's duplicate physical-project winner policy and can split stale records.                                                  |
| CR2-3 | `apps/web/src/components/settings/settingsLayout.tsx:44`   | AX2-1         | Medium   | Fix now     | `aria-controls` references an unmounted element while collapsed.                                                                                                   |
| CR2-4 | `apps/web/src/components/settings/SettingsPanels.tsx:1675` | AX2-2         | Medium   | Fix now     | Async partial and total archive failures are not announced to assistive technology.                                                                                |
| CR2-5 | `apps/web/src/components/settings/settingsLayout.tsx:40`   | AX2-3         | Medium   | Fix now     | Dynamic project/thread headings lack shrink constraints, allowing long names to overflow.                                                                          |

## Deferred candidates

No new items deferred this round. The identity-less archived-project boundary from round 1 remains valid.

## Discarded summary

- The producer-contract finding was independently reported twice and merged into CR2-1.
