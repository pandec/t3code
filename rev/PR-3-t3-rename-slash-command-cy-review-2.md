# PR #3 cy-review round 2 — `/t3-rename` slash command

- Branch: `feat/t3-rename-slash-command`
- Base: `dev`
- Diff base: `origin/dev...HEAD`
- Reviewed head: `dbb84d4387ee9309e13aca683ce9f5b0a2439fae`
- PR: https://github.com/pandec/t3code/pull/3
- Date: 2026-07-16
- Round: 2
- Pass started: 2026-07-16T10:04:00+02:00

## Review fleet

Three fresh reviewers covered the revised web, mobile, and cross-platform design risks without repeating the round-1 contexts.

- **Skeptical web concurrency reviewer** — revised dispatch ordering, pending-input ownership, route/context snapshot clearing, failures, and navigation races.
- **Mobile async/state reviewer** — outbox persistence timing, compare-and-clear behavior, callback dependencies, thread switching, and Live Activity behavior.
- **Adversarial solution/shared reviewer** — hidden dispatch paths, standalone eligibility, parser/autocomplete edges, test adequacy, and safer ownership boundaries.

All reviewers were instructed to use `gpt-5.6-sol` with medium reasoning effort and inspected both the frozen full PR diff and the isolated round-1 fix commit.

## Summary

- Raw findings: 6
- Combined kept findings: 4
- Fix now: 4
- Deferred: 0
- Discarded: 0

## Combined findings

| ID    | File:line                                                 | Source roles               | Severity | Disposition | Rationale                                                                                                                                                                                                                                                                                            |
| ----- | --------------------------------------------------------- | -------------------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-C1 | `apps/web/src/components/ChatView.tsx:3972`               | skeptical web              | HIGH     | fix_now     | Pending-question text is owned by `pendingUserInputAnswersByRequestId`, so clearing only the composer draft leaves the command visible and permits a second submit to send it as an answer. Clear the captured pending custom answer conditionally and preserve the unrelated normal composer draft. |
| R2-C2 | `apps/web/src/components/ChatView.tsx:3925`               | skeptical web, adversarial | HIGH     | fix_now     | Standalone eligibility uses filtered sendable terminal contexts, so an expired pill is silently cleared by a local rename. Use the raw context count so every attached context keeps the text on the normal-message path.                                                                            |
| R2-C3 | `apps/mobile/src/features/threads/ThreadComposer.tsx:513` | mobile async, adversarial  | MEDIUM   | fix_now     | Round 1 delayed Live Activity arming until after serialized outbox storage, which can lose the foreground-only ActivityKit window. Invoke an early callback after local-command classification but immediately before persistence.                                                                   |
| R2-C4 | `apps/mobile/src/state/use-thread-composer-state.ts:189`  | mobile async               | MEDIUM   | fix_now     | The adjacent normal outbox path still clears unconditionally after async persistence and can erase edits made during the write. Reuse the new atomic compare-and-clear helper and cover attachment changes.                                                                                          |

## Deferred candidates

None.

## Raw-output notes

- Parser regex, autocomplete memo dependencies, mobile command-selection fall-through, route capture, and round-1 context identity comparisons otherwise reviewed cleanly.
- Baseline focused tests passed before round-2 fixes: 4 files, 75 tests.
