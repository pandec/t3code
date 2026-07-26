# Branch cy-review deferred items

## CY-8: Preserve native-only skills during degraded discovery

When `skills/reload` fails after the filesystem scan finds at least one skill, the adapter returns the
scan as a successful workspace answer. That result cannot contain plugin or bundled skills outside the
scanned roots, so the client may temporarily hide entries that remain in the provider snapshot. It was
not fixed in this pass because blindly unioning the snapshot can also reintroduce stale project-scoped
skills from the server's cwd; a follow-up should add an explicit partial-result signal or another
principled source-aware merge, rather than guessing on the client.

## CY-9: Discover manual-only plugin skills

A plugin skill that disables model invocation can be absent from `skills/reload` while also living
outside the user and project roots scanned by `discoverClaudeSkills`. Initialization commands establish
that it is user-invocable, but they mix skills with ordinary slash commands and do not expose origin or
kind metadata. This should be handled only if the SDK exposes authoritative command-kind metadata or
with plugin-aware discovery; adding unmatched or colon-shaped commands heuristically would pollute the
`$` picker.

> cy-review complete — 2026-07-26T08:41:07+02:00 — rounds: 1
