# cy-review: PR 56 — steer expedite and queue flush

- Branch: `feat/steer-expedite-and-flush`
- Base: `origin/dev`
- PR: https://github.com/pandec/t3code/pull/56
- Date: 2026-07-28
- Diff base: `git diff origin/dev...HEAD`
- Merge base: `240b98f225d8acc6afe383dbbe0f82ab9de29464`
- Round: 1

## Review fleet

Four Sol-medium reviewers were used because the change duplicates stateful asynchronous delivery logic
across web and mobile.

- Skeptical code reviewer — broad correctness, retries, send/loss/stranding, and test gaps.
- Queue concurrency reviewer — batch provenance, lifecycle, cleanup, reruns, and turn-state sequencing.
- Adversarial solution and parity reviewer — state ownership, activation timing, expedite growth, and
  cross-client consistency.
- Test and UI parity reviewer — row gestures, dead grace-window presentation state, and regression-test
  strength.

## Summary

- Raw reviewer findings: 10
- Additional executing-reviewer findings: 2
- Kept after deduplication: 6
- Fix now: 6
- Deferred: 0
- Discarded: 0 unique findings

## Combined findings

| ID         | File:line                                                                                                                 | Source roles                        | Severity | Disposition | Rationale                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BATCH-1    | `apps/web/src/state/use-thread-outbox-drain.ts:227`; `apps/mobile/src/state/use-thread-outbox-drain.ts:269`               | all reviewers, executing            | HIGH     | fix_now     | Any selected candidate opens a batch. A steer that overtakes an older queue-intent row while the thread is running therefore pulls that untouched row into the current turn. Remove and mobile creation candidates can also seed invalid batches. |
| BATCH-2    | `apps/web/src/state/use-thread-outbox-drain.ts:227`; `apps/mobile/src/state/use-thread-outbox-drain.ts:269`               | adversarial, executing              | MEDIUM   | fix_now     | The batch becomes active before the leader succeeds. A transient pre-start failure leaves steer bypass armed even though no replacement turn was started.                                                                                         |
| EXPEDITE-1 | `apps/web/src/state/use-thread-outbox-drain.ts:282`; `apps/mobile/src/state/use-thread-outbox-drain.ts:331`               | skeptical, adversarial              | MEDIUM   | fix_now     | Both drains read expedited IDs but omit them from the effect dependencies, so send-now relies on the asynchronous durable rewrite to wake delivery.                                                                                               |
| EXPEDITE-2 | `apps/web/src/state/threadOutbox.ts:132`; `apps/mobile/src/state/use-thread-outbox.ts:38`                                 | skeptical, adversarial, test/parity | LOW      | fix_now     | Expedited IDs are never pruned. Long-lived clients retain one key per gesture and clone an ever-growing record; UUID generation makes accidental reuse negligible but not the growth.                                                             |
| CLEANUP-1  | `apps/mobile/src/features/threads/QueuedMessageList.tsx:39`; `packages/client-runtime/src/state/threadOutboxModel.ts:134` | test/parity, executing              | LOW      | fix_now     | Mobile's grace deadline rerender and `nowMs` row prop no longer drive presentation or enablement, the old row-eligibility helper has no production consumer, and web retains an unused import warning.                                            |
| DOC-1      | `README.md:20`                                                                                                            | executing                           | LOW      | fix_now     | The fork feature list documents the recall window and row actions but not immediate expedite or turn-end batch release, despite the repository requirement for material fork-feature changes.                                                     |

## Deferred candidates

None.

## Discarded summary

No unique candidate was discarded after verification. Duplicate reports of BATCH-1, EXPEDITE-1, and
EXPEDITE-2 were merged. The test-coverage concern is addressed as part of the batch and pruning fixes rather
than tracked as a separate finding.

## Verification notes before edits

- The worktree was clean and matched `origin/feat/steer-expedite-and-flush`.
- PR #56 is open against `dev`; only commits `5de0b0d2` and `c135eb07` are in the reviewed range.
- Reproduced BATCH-1 by tracing `[A(queue), B(steer)]` on a running thread: selection dispatches B,
  snapshots A and B, then resolves A as an effective steer.
- The `c135eb07` effective-steer change correctly preserves disconnected, non-live, missing-thread, and
  `starting` waits once a batch is valid; the provenance and activation timing are the defects.
- Editing, retry-backoff, and grace holds run before delivery-action resolution on both clients.
- Batch keys are scoped by environment and thread; queue disappearance clears them, and messages appended
  after a snapshot are excluded.
- Focused `vp check` reported zero errors and one unused-import warning for
  `steerGraceRemainingMs` in the web drain.

## Fix resolution

- Batch membership is now derived only after a successful existing-thread send observed outside
  `running`; remove, failed delivery, running-turn steer, and mobile creation candidates produce no batch.
- The delivered leader is excluded, and only non-creation rows behind it in the original queue snapshot
  can follow the turn as steers. Rows enqueued during delivery remain outside the batch.
- Both drains now rerun directly when expedite state changes.
- Expedited IDs are pruned when no queued, dispatching, or editing owner remains. Dispatch and edit
  ownership keep a latch alive across optimistic removal and retry restoration.
- Removed mobile's obsolete grace deadline rerender and the unused shared row-eligibility helper/import.
- Updated the root fork-feature description for immediate expedite and turn-end queue release.

## Verification after edits

- Focused outbox suite: 5 files / 54 tests passed.
- `vp check`: passed; 10 pre-existing warnings, 0 errors, and no changed-file warnings.
- Recursive typecheck and `vp run typecheck`: passed with 0 errors.
- `pnpm lint`: exit 0; pre-existing warnings only.
- `vp run lint:mobile`: exit 0; optional SwiftLint, ktlint, and detekt are unavailable on this host.
- Package baseline: web 193 files / 1754 tests, mobile 98 / 585, client-runtime 43 / 555.
- No browser or simulator verification was run.
