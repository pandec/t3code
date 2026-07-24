# PR 29 cy-review round 3

- Target: `t3code/unarchive-project-settings-filter` -> `dev`
- PR: https://github.com/pandec/t3code/pull/29
- Date: 2026-07-24
- Diff base: `origin/dev`
- Round: 3

## Review fleet

| Reviewer              | Primary responsibility                                   | Selection reason                                                              |
| --------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| End-to-end Reviewer   | Scoped routing, grouping, filtering, partial states      | Two prior rounds materially changed the URL and archive aggregation contract. |
| Adversarial Reviewer  | Startup authority and unresolved project behavior        | The previous fix introduced readiness-based cleanup of unresolved filters.    |
| UI and Tests Reviewer | Controlled select semantics and accessible announcements | The previous fix changed fallback options and live-region ownership.          |

## Summary

- Raw findings: 3
- Kept after deduplication: 3
- Fix now: 3
- Deferred: 0
- Discarded: 0

## Combined findings

| ID       | File                                                  | Source role  | Severity | Disposition | Rationale                                                                                                                  |
| -------- | ----------------------------------------------------- | ------------ | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| R3-ADV-1 | `apps/web/src/components/settings/SettingsPanels.tsx` | Adversarial  | HIGH     | fix now     | Catalog readiness can precede primary-environment discovery, so automatic cleanup can erase a valid scoped URL on startup. |
| R3-UI-1  | `apps/web/src/components/settings/SettingsPanels.tsx` | UI and Tests | MEDIUM   | fix now     | An unresolved controlled project value had no matching select item during loading or failure.                              |
| R3-UI-2  | `apps/web/src/components/settings/SettingsPanels.tsx` | UI and Tests | LOW      | fix now     | A partial archive failure with zero filtered matches could be announced by two live regions.                               |

## Deferred candidates

No items deferred this round.

## Discarded summary

No candidate findings were discarded.
