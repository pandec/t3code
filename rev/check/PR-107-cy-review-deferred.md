# PR #107 cy-review deferred items

## 1. Model context capacity should be non-interactive capability metadata

`resolveKnownContextWindowMaxTokens` duplicates the fixed 1M capacity of Claude Opus 4.7 and 4.8 by slug, so adding or renaming another fixed-capacity model can leave the fresh-thread context ring dark. Existing `contextWindow` option descriptors are not a safe source: they represent user-selectable dispatch options, and adding one for these models would create a fake control and change Claude model-id dispatch to append `[1m]`. This was not fixed in PR #107 because the correct solution is a separate non-dispatch capability field spanning contracts, shared helpers, provider catalogs, and the web resolver. I recommend a focused follow-up; retaining an expanding web-only slug list should not become the long-term pattern.

> cy-review complete — 2026-08-04T11:32:12Z — rounds: 1
