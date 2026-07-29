# PR 60 cy-review: Sidebar V2 compact project accents

- Target: PR #60, `feature/sidebar-v2-compact-project-accents` into `dev`
- URL: https://github.com/pandec/t3code/pull/60
- Date: 2026-07-29
- Diff base: `origin/dev`
- Round: 1

## Review fleet

Four Sol-medium reviewers were used because this is a stateful, contract-changing UI feature spanning
settings persistence, project grouping, row rendering, and accessibility.

- Skeptical correctness: regressions in grouping, persistence, filters, and coverage.
- Adversarial solution: challenged accent ownership and compact/filter UX contracts.
- Design and reuse: checked existing picker reuse, write frequency, and maintainability.
- Accessibility and UI state: checked focus semantics, accessible status, responsive layout, and stale state.

## Summary

- Raw findings: 7
- Deduplicated findings: 5
- Fix now: 5
- Deferred: 0
- Discarded: 0

## Combined findings

| ID   | File                                          | Sources         | Severity | Disposition | Rationale                                                                                                                                                                                         |
| ---- | --------------------------------------------- | --------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY-1 | `apps/web/src/components/SidebarV2.tsx:1267`  | SKEP-1          | MEDIUM   | fix now     | The accent lookup map covers only winning project IDs, not every preserved duplicate ref.                                                                                                         |
| CY-2 | `apps/web/src/components/SidebarV2.tsx:1541`  | SKEP-2, UI-1    | MEDIUM   | fix now     | The project dialog holds a snapshot that can become stale after changing grouping.                                                                                                                |
| CY-3 | `apps/web/src/components/SidebarV2.tsx:2922`  | DESIGN-2        | MEDIUM   | fix now     | Native color dragging can produce repeated whole-settings persistence; reuse the debounced picker.                                                                                                |
| CY-4 | `apps/web/src/components/SidebarV2.tsx:2601`  | UI-2            | LOW      | fix now     | The project-menu accent status is hidden from assistive technology.                                                                                                                               |
| CY-5 | `apps/web/src/components/Sidebar.logic.ts:49` | DESIGN-1, ADV-1 | MEDIUM   | fix now     | Grouped colors need deterministic precedence when separately configured members are regrouped. Group edits intentionally synchronize all physical members so the color survives later separation. |

## Deferred candidates

None. The physical-key persistence contract was retained because it preserves colors across grouping-mode
changes. Conflicting member colors resolve through the group's deterministic representative, while an
explicit grouped edit normalizes every current member.

## Discarded summary

No deduplicated findings were discarded.
