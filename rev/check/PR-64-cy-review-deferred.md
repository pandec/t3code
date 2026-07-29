# PR 64 cy-review deferred items

## 1. Define ownership for optional entries created after first materialization

Optional whitelisted entries are linked only when they already exist in the shared config dir. If an entry such as `skills`, `agents`, or `settings.json` is initially absent and Claude creates it through the shadow config, it remains shadow-local; a later shared entry with the same name then produces an actionable conflict. Fixing that would require deciding whether T3 should fabricate selected optional entries, migrate shadow-local content, or keep the current adopt-only behavior, so it is not safe to change as a review fix. Recommend a focused follow-up only if the intended product contract is that these entries remain shared regardless of which account creates them first.

## 2. Define ownership when one shadow is paired with different shared homes

The materializer intentionally retargets mismatched required symlinks, so two configured instances can pair shared homes A and B with the same shadow S and both become live. The second instance redirects S while the first retains continuation identity A, and optional links absent from B can still point into A, producing a mixed and misleading layout. Round 2 did not change this because rejecting mismatches, supporting explicit shadow reassignment, and coordinating multiple live owners are different product contracts. Recommend resolving this before intentionally reusing a shadow path across shared homes; otherwise document that each `shadowHomePath` must be unique.

## 3. Eliminate cross-process check-then-remove races

Private cleanup, stale optional cleanup, and wrong-target retargeting read a symlink and later remove that path. Another process can replace the directory entry with a real credentials or configuration file between those operations, causing the replacement file to be removed. A second advisory read only narrows the window, while a robust fix needs serialization or compare-and-swap semantics that also account for Claude processes outside T3. Recommend follow-up if the same shadow directory will be actively shared across multiple server processes; for single-owner operation, retain this as a documented residual risk.

> cy-review complete — 2026-07-29T08:00:45Z — rounds: 2
