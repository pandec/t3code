# PR 12 Claude review deferred items

## Recover and surface rejected steering messages

- Source: `rev/PR-12-mobile-steering.md` (R3)
- Affected area: mobile durable outbox, provider delivery acknowledgement, and client failure presentation
- Special provider turns such as review or manual compact can reject steering after the server has already persisted the user message and acknowledged the command, causing the local outbox entry to be removed.
- The PR now preserves the original running lifecycle on rejection, but automatic delivery after the special turn completes requires a provider-delivery acknowledgement or server-owned pending-delivery contract to avoid duplicating the persisted message. A distinct user-visible failure treatment is also a product decision.
- Recommend a focused cross-client follow-up if automatic fallback for special turns is important; ordinary active turns steer immediately and are covered here.

## Guard stale asynchronous failure diagnostics

- Source: `rev/PR-12-mobile-steering.md` (R4)
- Affected area: provider turn failure projection ordering
- A failed attempt re-reads and preserves the current session lifecycle, but can still stamp `lastError` after a newer attempt has succeeded because provider delivery and its failure recovery are asynchronous.
- The impact is a misleading diagnostic on a healthy session rather than lost work. Correctly preventing it needs an attempt generation or stronger write-ordering contract, which is broader than this steering change.
- Recommend addressing it with the broader provider-delivery lifecycle work rather than adding a partial timestamp heuristic here.

> cl-review complete — 2026-07-20T09:41:14Z — rounds: 1
