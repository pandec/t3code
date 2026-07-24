# PR #33 cy-review — user-controlled message queueing, round 3

## Target

- Branch: `t3code/queued-messages`
- Base: `origin/dev`
- PR: https://github.com/pandec/t3code/pull/33
- Review date: 2026-07-24
- Post-round-2 range: `e5679cbcb..751f62e24`
- Final PR diff: `origin/dev...HEAD`
- Round: 3 (terminal)
- Pass started: 2026-07-24T11:53:00Z

The exact post-round-2 diff (58 files, 3,456 additions / 175 deletions) and
final PR diff (41 files, 2,444 additions / 750 deletions) were saved before the
fleet started. The worktree was clean. The pass focused on the fresh
`origin/dev` merge (`4e505b752`), queue interactions with the merged
turn-completion/navigation state, and projector expectation fix `751f62e24`.

The two accepted deferrals — cross-tab web outbox ownership and persisted
terminal-delivery failure UX — were explicitly excluded and remain unchanged.

## Review fleet

| Reviewer                      | Primary responsibility                                              | Why selected                                                                                        |
| ----------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Skeptical code reviewer       | Broad correctness, regressions, tests                               | The merge introduced new turn-completion projection state adjacent to automatic queued delivery.    |
| Merge/integration specialist  | ChatView send ordering and merged notification/navigation data flow | The main risk was semantic interaction between the queue feature and freshly merged `dev` behavior. |
| Queue regression specialist   | FIFO, dispatch ownership, edit/delete races, attachments            | The terminal pass needed a fresh check of the round-2 concurrency fixes.                            |
| Adversarial solution reviewer | Challenge direct-send/outbox ownership boundaries                   | The web composer and drain still use two delivery entry paths.                                      |

All four reviewers ran read-only with `gpt-5.6-sol` at medium reasoning effort.

## Summary

- Raw findings: 3
- Deduplicated candidates: 2
- Kept after verification: 2
- Fix now: 2
- Newly deferred: 0
- Discarded: 0

## Combined findings

| ID     | File:line                                                | Source roles                   | Severity | Disposition | Rationale                                                                                                                                                                               |
| ------ | -------------------------------------------------------- | ------------------------------ | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FIFO-3 | `apps/web/src/components/ChatView.tsx:4658`              | Merge/integration, adversarial | HIGH     | fix now     | A fresh composer send can use the idle direct path while the same thread already has queued work or an active outbox dispatch, overtaking FIFO or becoming unintended steering.         |
| TURN-3 | `packages/client-runtime/src/state/threadReducer.ts:459` | Skeptical, root verification   | MEDIUM   | fix now     | A late checkpoint for turn N after queued turn N+1 starts reconciles completion IDs against the newer turn; the server projections also need to preserve the newer latest-turn pointer. |

## Discarded summary

No candidate findings were discarded after deduplication. The queue regression
specialist found no additional material issue. The projector test-only commit
correctly adds the newly defaulted `completedTurnAssistantMessageIds: []` field
to an exact expected object and does not mask behavior.

## Raw-output audit notes

- `P3MI-01` and `P3AD-1` were deduplicated into `FIFO-3`.
- `P3SK-001` became `TURN-3`; root verification extended the same invariant to
  the in-memory and persisted server latest-turn projections.
- `P3QR-000` reported no material findings.

## Fix outcome

- `FIFO-3`: fixed by treating same-thread queued rows and the live dispatch
  claim as busy work, so a fresh web composer send joins the outbox instead of
  overtaking it.
- `TURN-3`: fixed by reconciling a late checkpoint against its own prior-turn
  assistant message while preserving newer latest-turn state in client,
  in-memory server, and persisted projections.
- Focused verification: 6 test files, 127 tests passed.
- Repository gates: `vp check` and `vp run typecheck` passed.
- No additional items were deferred.
