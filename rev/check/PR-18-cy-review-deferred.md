# PR 18 cy-review deferred items

## Identity-less archived projects

Archived projects without `repositoryIdentity` fall back to environment-scoped physical keys, so equivalent projects cannot be merged across environments. This matters most when a checkout has moved or disappeared before its archived chats are revisited. It is not fixed in this PR because automatic title or path-basename matching can incorrectly combine unrelated projects. A follow-up should decide between durable persisted repository identity and an explicit user-controlled fallback policy.

> cy-review complete — 2026-07-21T20:19:45Z — rounds: 2
