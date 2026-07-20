# PR 12 cy-review deferred items

## Retry after a non-steerable active turn

- Source: `rev/PR-12-mobile-steering-cy-review.md` (SK1)
- Affected area: mobile durable outbox and asynchronous provider turn delivery
- The server can accept and persist a `thread.turn.start` command before a provider rejects same-turn steering for special non-steerable turns such as review or manual compact.
- Preserving the existing running session on that failure is handled in this PR. Automatically delivering the message after the special turn finishes remains valid, but requires a provider-delivery acknowledgement or server-owned pending-delivery contract so the mobile outbox can retry without duplicating the already-persisted user message.
- Defer to a focused cross-client delivery-semantics change if automatic fallback for these rare special turns is desired. Ordinary active agent turns steer immediately with the current change.

> cy-review complete — 2026-07-20T09:25:13Z — rounds: 1
