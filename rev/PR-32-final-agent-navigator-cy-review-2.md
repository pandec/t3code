# PR 32 cy-review — final agent navigator

- Target: `t3code/add-user-message-navigator` → `dev`
- PR: https://github.com/pandec/t3code/pull/32
- Date: 2026-07-24
- Diff base: `origin/dev`
- Round: 2

## Review fleet

| Reviewer                               | Primary responsibility                                       |
| -------------------------------------- | ------------------------------------------------------------ |
| Skeptical Code Reviewer                | Re-test lifecycle correctness and pass-1 fixes               |
| Adversarial Solution Reviewer          | Challenge inference boundaries and timeline semantics        |
| Accessibility and Interaction Reviewer | Re-test accessible labels, keyboard behavior, and geometry   |
| Design and Efficiency Reviewer         | Re-test maintainability, state ownership, cost, and coverage |

The same four risk areas were reviewed against the updated diff because pass 1 changed lifecycle
classification and accessibility behavior.

## Summary

- Raw findings: 4
- Kept findings after deduplication: 2
- Fix now: 2
- Deferred: 0
- Discarded: 0

## Combined findings

| ID    | File                                                     | Severity | Sources                                   | Disposition | Rationale                                                                                                                                                                                                                      |
| ----- | -------------------------------------------------------- | -------- | ----------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CY2-1 | `apps/web/src/components/chat/MessagesTimeline.logic.ts` | HIGH     | Skeptical, Adversarial, Design/Efficiency | fix now     | Client-side latest-turn, checkpoint, and trailing-work signals cannot durably distinguish completed final responses from interrupted historical commentary. Persisted turn state must provide affirmative completion identity. |
| CY2-2 | `apps/web/src/components/chat/MessagesTimeline.tsx`      | MEDIUM   | Adversarial                               | fix now     | Independently spacing filtered right-rail items makes them stop aligning with their corresponding user turns. Items need positions in the complete turn sequence and nearest-marker pointer selection.                         |

## Deferred candidates

None.

## Discarded summary

No candidate findings were discarded. The accessibility reviewer found the pass-1 accessible-label fix
complete.

## Resolution

- CY2-1: Added an additive thread-detail field populated from persisted completed turn rows. Live
  reducers maintain the same completed-response IDs, while interrupted, errored, late-checkpoint, and
  steer-superseded turns are excluded.
- CY2-2: Minimap items now retain positions in the complete user-turn sequence. Rendering uses that
  shared coordinate space and pointer selection chooses the nearest rendered response marker.

Focused lifecycle, snapshot, reducer, minimap, and rendering tests pass, including late checkpoint,
late commentary, interruption, and sparse-response alignment regressions.
