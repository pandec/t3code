# PR #33 cy-review — user-controlled message queueing, round 2

## Target

- Branch: `t3code/queued-messages`
- Base: `origin/dev`
- PR: https://github.com/pandec/t3code/pull/33
- Review date: 2026-07-24
- Diff: `git diff origin/dev...HEAD`
- Round: 2
- Pass started: 2026-07-24T11:15:44Z

The exact 36-file, 2,257-addition / 742-deletion diff was saved before the fleet started. The worktree was clean. During the pass, `origin/dev` advanced to `6f459306b`; GitHub and `git merge-tree --write-tree origin/dev HEAD` both reported a real `ChatView.tsx` content conflict.

The two previously accepted deferrals — cross-tab web outbox ownership and persisted terminal-failure UX — were explicitly excluded from this round and remain unchanged.

## Review fleet

| Reviewer                            | Primary responsibility                                                           | Why selected                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Skeptical code reviewer             | Broad post-fix correctness and manual-action behavior                            | The first pass changed several race-sensitive paths that needed fresh scrutiny. |
| Queue concurrency specialist        | Same-runtime dispatch/action races, retry IDs, storage mutation ordering         | The outbox has one delivery slot plus independently initiated row actions.      |
| Cross-client integration specialist | Web attachments and overlay, mobile drafts and previews, shared package behavior | The feature spans web, mobile, and `client-runtime`.                            |
| Adversarial solution reviewer       | Challenge snapshot, edit, and UI-state assumptions                               | A second pass should attack the chosen semantics, not merely re-check syntax.   |

All four reviewers ran read-only with `gpt-5.6-sol` at medium reasoning effort.

## Summary

- Raw findings: 13
- Deduplicated candidates: 12
- Kept after verification: 10
- Fix now: 10
- Newly deferred: 0
- Discarded: 2

## Combined findings

| ID            | File:line                                                                                            | Source roles           | Severity | Disposition | Rationale                                                                                                                                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------- | ---------------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RACE-2        | `packages/client-runtime/src/state/threadOutboxManager.ts:138`                                       | Skeptical, concurrency | HIGH     | fix now     | Serialized removal does not report whether it actually owned an extant row. Double Edit can therefore remove once and append twice, and Delete can leave a row drainable while storage removal is pending. An atomic remove-if-present result plus manual-action holds closes both races. |
| IDEMPOTENCY-1 | `packages/client-runtime/src/state/threadOutboxDelivery.ts:105`                                      | Concurrency            | HIGH     | fix now     | One metadata command ID is reused for conditionally different model/branch payloads across retries. Separate stable IDs and payloads for model and branch prevent a prior receipt from suppressing a later required update.                                                               |
| STORAGE-2     | `packages/client-runtime/src/state/composerAttachment.ts:11`                                         | Cross-client           | MEDIUM   | fix now     | Persisted attachments serialize the same data URL in both `previewUri` and `dataUrl`, roughly doubling localStorage pressure. Persist only the payload and reconstruct the preview URI during decode.                                                                                     |
| PREVIEW-1     | `packages/client-runtime/src/state/threadOutboxModel.ts:138`                                         | Cross-client           | MEDIUM   | fix now     | A mobile picker cache URI can be stale after restart even though the persisted data URL remains valid. Decode should rehydrate `previewUri` from the self-contained payload.                                                                                                              |
| WEB-OVERLAY-1 | `apps/web/src/components/chat/ComposerQueuedMessages.tsx:43`                                         | Cross-client           | MEDIUM   | fix now     | The web list has no height or overflow boundary inside the measured bottom overlay, so a long queue can push FIFO rows and controls beyond the viewport.                                                                                                                                  |
| ATTACH-2      | `apps/web/src/components/ChatView.tsx:5030`, `apps/mobile/src/state/use-thread-outbox-actions.ts:47` | Cross-client           | MEDIUM   | fix now     | Editing a queued row can combine it with an existing draft beyond the eight-image protocol limit after the row has been removed. Preflight the combined count and leave the row queued when it cannot fit.                                                                                |
| UI-STATE-1    | `apps/web/src/components/chat/ComposerQueuedMessages.tsx:45`                                         | Adversarial            | LOW      | fix now     | A persisted Steer intent is rendered as actively sending even while disconnected or otherwise waiting. Only the dispatch-slot owner should show the spinner; a Steer intent should show a disabled action.                                                                                |
| STARTING-1    | `apps/web/src/components/chat/ChatComposer.tsx:2832`                                                 | Adversarial            | LOW      | fix now     | Starting-session submissions follow the queue path but the expanded composer labels the action Send. Treat Starting as busy for the expanded primary action, matching mobile and actual behavior.                                                                                         |
| MOBILE-TAP-1  | `apps/mobile/src/features/threads/QueuedMessageList.tsx:144`                                         | Root verification      | MEDIUM   | fix now     | The new nested queue ScrollView uses the default keyboard tap policy, so a first row-action tap can be consumed to dismiss the keyboard. Preserve taps for the action controls.                                                                                                           |
| INTEGRATION-1 | `apps/web/src/components/ChatView.tsx:185`, `apps/web/src/components/ChatView.tsx:4620`              | Root verification      | HIGH     | fix now     | Current `origin/dev` adds draft-submission tracking and a shared draft-content helper at the same import/send boundaries. The branch is currently unmergeable; resolution must keep draft acknowledgment/direct-dispatch work strictly after the busy-queue return.                       |

## Discarded summary

- The branch snapshot becoming “stale” before delivery is the intended message-level snapshot contract, just like queued model/runtime/interaction settings. Replacing it with live checkout state would make the queued message silently inherit context changes made after enqueue and would undo the first-round branch-continuation fix.
- When Edit appends to an already populated composer, adopting the queued message's settings is a coherent continuation of editing that queued message; preserving the unrelated draft's settings would be equally lossy. There is no demonstrated correctness failure under the current message-level snapshot contract, so this is not changed in review.

## Raw-output audit notes

- `R2SK-1` and `R2QC-2` were deduplicated into `RACE-2`.
- `R2QC-1` became `IDEMPOTENCY-1`.
- `R2CI-1` through `R2CI-4` became `STORAGE-2`, `PREVIEW-1`, `WEB-OVERLAY-1`, and `ATTACH-2`.
- `R2AD-3` and `R2AD-4` became `UI-STATE-1` and `STARTING-1`.
- `R2AD-1` and `R2AD-2` were discarded after contract-level verification.
- `MOBILE-TAP-1` and `INTEGRATION-1` were found during root verification.
