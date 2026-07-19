# Cy-review: provider icon on sidebar thread hover

- Target: `t3code/show-provider-icon-on-hover`
- Base: `dev`
- Date: 2026-07-19
- Diff base: uncommitted working-tree diff from `HEAD`
- Round: 1

## Review fleet

Two reviewers were sufficient for this narrow, single-file presentation change:

- Skeptical Code Reviewer: correctness, state gaps, running-thread regressions, and missing-provider behavior.
- Accessibility and Design/Reuse Reviewer: keyboard access, tooltip semantics, responsive behavior, and reuse of existing provider abstractions.

Both reviewers were instructed to use GPT-5.6 Sol at medium reasoning effort.

## Summary

- Raw findings: 4
- Deduplicated findings: 3
- Fix now: 2
- Deferred: 1
- Discarded: 0

## Combined findings

| ID    | File:line                                 | Sources       | Severity | Disposition | Rationale                                                                                                            |
| ----- | ----------------------------------------- | ------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| CR-01 | `apps/web/src/components/Sidebar.tsx:484` | SC-001, AR-01 | Medium   | Fix now     | Running rows without a resolved provider could fade their metadata while rendering no hover replacement.             |
| CR-02 | `apps/web/src/components/Sidebar.tsx:814` | AR-02         | Medium   | Fix now     | The provider/model tooltip trigger was not focusable, leaving the exact model unavailable to keyboard users.         |
| CR-03 | `apps/web/src/components/Sidebar.tsx:409` | SC-002        | Medium   | Defer       | Deleted or unavailable historical provider instances have no trustworthy driver kind for branded fallback rendering. |

## Deferred candidates

| ID    | Scope  | Reason                                                                                                                                                               |
| ----- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR-03 | Medium | A durable fallback requires choosing whether to persist provider presentation metadata, infer it from instance ids, or show a generic historical-provider indicator. |

## Discarded summary

No findings were discarded.
