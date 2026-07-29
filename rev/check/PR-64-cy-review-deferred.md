# PR 64 cy-review deferred items

## 1. Define ownership for optional entries created after first materialization

Optional whitelisted entries are linked only when they already exist in the shared config dir. If an entry such as `skills`, `agents`, or `settings.json` is initially absent and Claude creates it through the shadow config, it remains shadow-local; a later shared entry with the same name then produces an actionable conflict. Fixing that would require deciding whether T3 should fabricate selected optional entries, migrate shadow-local content, or keep the current adopt-only behavior, so it is not safe to change as a review fix. Recommend a focused follow-up only if the intended product contract is that these entries remain shared regardless of which account creates them first.

> cy-review complete — 2026-07-29T07:47:46Z — rounds: 1
