# cy-review: PR 51 — steer by default

- Branch: `feat/steer-by-default`
- Base: `origin/dev`
- PR: https://github.com/pandec/t3code/pull/51
- Date: 2026-07-28
- Diff base: `git diff origin/dev...HEAD`
- Round: 1

## Review fleet

Three Sol-medium reviewers were used because the change is stateful and cross-component, while three
distinct risk seams covered the material surface within the available parallel-agent capacity.

- Skeptical contracts reviewer — all widened callback callers, ArrowUp precedence, and send/loss/stuck regressions.
- Outbox concurrency reviewer — grace scheduling, cleanup, retries, selection ordering, and dispatch completion.
- Adversarial solution reviewer — UI freshness, recall eligibility, solution boundaries, and focused test gaps.

## Summary

- Raw reviewer findings: 7
- Additional executing-reviewer findings: 1
- Kept after deduplication: 6
- Fix now: 6
- Deferred: 0
- Discarded: 0

## Combined findings

| ID           | File:line                                                            | Source                 | Severity | Disposition | Rationale                                                                                                                                                                                                                          |
| ------------ | -------------------------------------------------------------------- | ---------------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CON-1        | `packages/client-runtime/src/state/threadOutboxModel.ts:127`         | concurrency            | MEDIUM   | fix_now     | A parseable future `createdAt` produces an unbounded timer delay; sufficiently large delays clamp to a tiny timeout and repeatedly increment `retryTick`. Fail open for future timestamps, matching unreadable timestamp handling. |
| ADV-1        | `apps/web/src/components/chat/ChatComposer.tsx:1998`                 | adversarial            | MEDIUM   | fix_now     | Prompt text alone does not define an empty composer. Image- or context-only drafts can currently be merged with a recalled queued message.                                                                                         |
| SK-1 / ADV-2 | `apps/web/src/components/chat/ComposerQueuedMessages.tsx:40`         | skeptical, adversarial | LOW      | fix_now     | The expiry tick lives in a separate host, so blocked delivery can leave the row labeled `steering` indefinitely. Give presentation its own deadline wake-up.                                                                       |
| SK-2 / ADV-3 | `apps/web/src/components/ChatView.tsx:5421`                          | skeptical, adversarial | LOW      | fix_now     | If the newest row is dispatching, the callback ignores an older editable row. Search backward for the newest non-dispatching message.                                                                                              |
| ADV-4        | `packages/client-runtime/src/state/threadOutboxSteerGrace.test.ts:1` | adversarial            | MEDIUM   | fix_now     | Arithmetic-only tests miss the new eligibility/deadline boundaries. Add narrow tests around shared deadline selection and composer recall eligibility.                                                                             |
| ROOT-1       | `README.md:20`                                                       | executing reviewer     | LOW      | fix_now     | The fork feature list still says running-turn sends queue by default, directly contradicting this branch and the repository documentation requirement.                                                                             |

## Deferred candidates

None.

## Discarded summary

No submitted findings were discarded after verification. The executing review separately checked the
idle-thread-with-pending-outbox path: while the thread is idle every action resolves to `send`, so the
selector returns the oldest row and preserves FIFO. Once that row starts a turn, a later steer is
intentionally eligible to reach the now-running turn.

## Verification notes before edits

- The grace effect clears its timeout on every dependency change and on unmount.
- A retry tick while grace is pending cancels and recomputes the remaining delay.
- Timer expiry cannot strand a row under ordinary timestamps; the future-clock case above is the exception.
- The command-menu ArrowUp branch runs before recall.
- `ChatComposer` has one `onSend` caller, and its positional event/options forwarding is type-safe.
- Plan follow-ups intercept submission before outbox delivery intent is used.

## Fix resolution

- Future timestamps now fail open instead of creating an unbounded grace timeout.
- The drain and queued strip share one tested soonest-deadline selector; the strip owns a presentation-only
  wake-up so blocked delivery does not leave stale grace state.
- ArrowUp requires a completely empty composer, including images and every context type, and searches
  backward past a dispatching row.
- Already-steering rows remain non-actionable if delivery is blocked after the grace window.
- The root fork-feature description now matches the web and native-mobile behavior.

## Verification after edits

- Focused: 2 files, 51 tests passed.
- `vp check`: passed; 10 pre-existing lint warnings only.
- Recursive typecheck: passed with 0 errors.
- `pnpm lint`: exit 0; pre-existing warnings only.
- Package baseline: web 183 files / 1659 tests, mobile 97 / 578, client-runtime 43 / 545.
