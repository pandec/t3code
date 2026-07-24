# PR #33 cy-review deferred items

## 1. Coordinate web outbox ownership across tabs

Each browser tab loads the shared localStorage outbox into an independent in-memory manager and drain, so one tab can retain and later dispatch a stale message after another tab deletes or edits it. Per-message storage keys prevent sibling writes from clobbering each other, but they do not provide an atomic cross-tab dispatch claim. This was not fixed because the correct solution needs a browser-wide ownership primitive plus storage-event reconciliation and recovery behavior, not a local race patch. I recommend handling it before treating multiple simultaneous web tabs as a supported delivery configuration.

## 2. Preserve and surface terminal delivery failures

The shared delivery pipeline removes a queued message after a deterministic start-turn failure, while settings-sync failures remain queued and retry indefinitely. That can either silently discard user-authored content or leave a thread queue permanently blocked, depending on which command stage fails. This was not changed because a safe fix needs a persisted failed state and a product decision for row-level error, retry, edit, and delete behavior. I recommend a focused follow-up rather than changing the established retry/discard contract inside this review pass.

> cy-review complete — 2026-07-24T11:09:29Z — rounds: 1
