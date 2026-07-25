# PR 37 cy-review deferred items

## 1. Unknown-reset alert identity

When a provider first emits a warning without `resetsAt`, the alert uses an `unknown` period key with a 24-hour TTL. If the same period later gains a concrete reset timestamp, its key changes and the alert can fire again; exact once-per-reset identity cannot be recovered from the earlier payload. Fixing this requires choosing whether to favor possible duplicate alerts or possible suppression across an unseen reset, so it was not changed during this correctness pass. Recommend keeping the bounded fallback for v0 and revisiting only if real provider events frequently add reset metadata after the first threshold event.

> cy-review complete — 2026-07-25T08:30:32+02:00 — rounds: 1
