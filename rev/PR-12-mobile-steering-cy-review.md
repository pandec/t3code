# PR 12 cy-review

- Branch: `agent/mobile-steering`
- Base: `dev`
- PR: https://github.com/pandec/t3code/pull/12
- Date: 2026-07-20
- Diff base: `origin/dev...HEAD`
- Round: 1

## Review fleet

- Skeptical Code Reviewer: correctness, provider failure paths, and regression coverage.
- Adversarial Solution Reviewer: solution boundary, ownership, and simpler alternatives.
- Mobile Outbox/Concurrency Reviewer: FIFO delivery, retries, status transitions, and UI semantics.

Three reviewers were sufficient for this narrow but asynchronous mobile scheduling change. The fleet covered broad correctness, adversarial design, and the principal concurrency risk without adding low-value reviewers.

## Summary

- Raw findings: 1
- Kept findings: 1
- Fix now: 1
- Deferred: 1 narrowed follow-up
- Discarded: 0

## Combined findings

| ID  | File:line                                                            | Source                  | Severity | Disposition                     | Rationale                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------- | ----------------------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SK1 | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:289` | Skeptical Code Reviewer | HIGH     | Fix now, with deferred fallback | A rejected steering attempt currently clears a still-running session's status and active turn. Preserve the live lifecycle while recording the failure. Automatically retrying the accepted user message after a non-steerable turn needs a broader provider-delivery acknowledgement contract and is tracked separately. |

## Deferred candidates

| Item                                                                                      | Why deferred                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatically deliver messages rejected because the active provider turn is non-steerable | The command is acknowledged and the user message is persisted before asynchronous provider delivery. Retrying safely after the turn finishes requires correlating provider acceptance/failure back to the durable mobile outbox or adding a server-owned pending-delivery state; neither exists in the current command contract. |

## Discarded summary

No findings were discarded.
