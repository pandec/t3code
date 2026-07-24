# PR #33 cy-review — user-controlled message queueing

## Target

- Branch: `t3code/queued-messages`
- Base: `dev`
- PR: https://github.com/pandec/t3code/pull/33
- Review date: 2026-07-24
- Diff base: `git diff origin/dev...HEAD`
- Round: 1
- Pass started: 2026-07-24T10:53:23Z

The reviewed diff was saved before the fleet started. The worktree was clean, and GitHub reported the PR mergeable with a clean merge state against current `dev`.

## Review fleet

| Reviewer                            | Primary responsibility                                                           | Why selected                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Skeptical code reviewer             | Broad correctness, regressions, ChatView direct-vs-queued send boundaries, tests | The change alters a large stateful send path and failure restoration behavior.         |
| Queue concurrency specialist        | Dispatch/manual-action races, queue ordering, storage consistency, migrations    | Persisted asynchronous delivery and mutable row actions are the highest-risk contract. |
| Cross-client integration specialist | Web attachments, mobile overlay, shims, exports, creation-message filtering      | The implementation spans web, mobile, and `client-runtime`.                            |
| Adversarial solution reviewer       | Ownership and API-boundary critique                                              | The outbox model, manager, and delivery pipeline moved into a shared package.          |

All four reviewers ran read-only with `gpt-5.6-sol` at medium reasoning effort. A repository-required read-only Claude/Fable medium second opinion was also used to validate the smallest branch-metadata contract extension.

## Summary

- Raw findings: 11
- Deduplicated candidates: 10
- Kept after verification: 7
- Fix now: 5
- Deferred: 2
- Discarded: 3

## Combined findings

| ID        | File:line                                                      | Source roles             | Severity | Disposition | Rationale                                                                                                                                                                                                          |
| --------- | -------------------------------------------------------------- | ------------------------ | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BRANCH-1  | `apps/web/src/components/ChatView.tsx:4669`                    | Skeptical                | HIGH     | fix now     | Queued busy sends omit the branch-continuation metadata applied by direct sends, so a drained turn can run with stale thread branch metadata.                                                                      |
| RACE-1    | `apps/web/src/components/ChatView.tsx:4985`                    | Concurrency, adversarial | MEDIUM   | fix now     | Web row actions use a render-captured dispatch ID rather than the registry's live ownership claim, allowing edit/delete to race an already-started delivery.                                                       |
| ATTACH-1  | `apps/web/src/components/ChatView.tsx:4698`                    | Cross-client             | MEDIUM   | fix now     | Successful queued image sends clear the composer without an optimistic-message handoff and therefore leak the original blob preview URLs.                                                                          |
| FILTER-1  | `apps/web/src/components/ChatView.tsx:4982`                    | Cross-client             | MEDIUM   | fix now     | Web renders creation messages even though the accepted contract reserves them for mobile and the web drain intentionally holds them.                                                                               |
| MOBILE-1  | `apps/mobile/src/features/threads/QueuedMessageList.tsx:136`   | Cross-client             | MEDIUM   | fix now     | An unbounded non-scrollable queue can grow beyond the viewport inside the bottom composer overlay; a capped scroll region preserves measured inset accounting and row access.                                      |
| STORAGE-1 | `apps/web/src/state/threadOutboxStorage.ts:17`                 | Concurrency              | HIGH     | defer       | Separate tabs keep independent in-memory drains over shared localStorage. Correct prevention needs cross-tab dispatch ownership plus storage reconciliation, not just per-key writes.                              |
| FAILURE-1 | `packages/client-runtime/src/state/threadOutboxDelivery.ts:78` | Adversarial              | HIGH     | defer       | Permanent start-turn failure removes the user message while settings-sync failure retries indefinitely. Retaining and surfacing terminal failures needs a persisted failed state and product-level retry/error UX. |

## Deferred candidates

| ID        | Scope                                  | Reason                                                                                                                                                          |
| --------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STORAGE-1 | Medium, cross-tab coordination         | Requires an explicit ownership primitive (for example Web Locks) and storage-event reconciliation, with compatibility and recovery behavior tested across tabs. |
| FAILURE-1 | Medium, persisted failure state and UI | Requires a product decision for how failed rows are shown and retried; silently changing retry/discard semantics would create a different failure contract.     |

## Discarded summary

- The claimed current-`dev` integration conflict was not reproducible: GitHub reports `MERGEABLE` / `CLEAN`, and `git merge-tree` produced no conflict markers. The branch is behind `dev`, but that alone is not a correctness finding for the requested three-dot review.
- A full `ChatView` send harness would be disproportionate to this private-fork patch after direct diff verification showed the idle path's side effects and failure restoration remain in their prior order; focused model/delivery tests are the narrower useful evidence.
- The native collapsed composer prioritizing Stop while a turn runs is existing interaction behavior, remains reachable by expanding the composer, and needs a product choice rather than an unrequested review fix. It is distinct from the explicitly accepted collapsed mobile-viewport web behavior.

## Raw-output audit notes

- `SK-1` became `BRANCH-1`; `SK-2` and `SK-3` were discarded after verification.
- `QC-1` became `STORAGE-1`; `QC-2` and `AD-2` were deduplicated into `RACE-1`.
- `CI-1`, `CI-3`, and `CI-4` became `ATTACH-1`, `FILTER-1`, and `MOBILE-1`; `CI-2` was discarded.
- `AD-1` became `FAILURE-1`.
