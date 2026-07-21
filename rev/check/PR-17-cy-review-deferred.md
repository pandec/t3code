# PR 17 cy-review deferred items

## Deferred by separate Opus review

1. **Skill discovery runs the workspace's `SessionStart` hooks.**

   `ClaudeAdapter.listSkills` must load user, project, and local settings to
   discover project skills. With Claude Agent SDK 0.3.170, loading project
   settings also executes the project's configured `SessionStart` hooks. Opus
   verified this with a scratch project: the project skill and hook were both
   active with project settings enabled, and neither was active with only user
   settings.

   This matters because the composer refreshes skills per workspace on a
   60-second stale window, so opening a thread can run hooks with side effects.
   The SDK exposes no option to load project skills without project hooks, so
   resolving this would require a product tradeoff such as on-demand discovery,
   longer caching, or accepting only user-level skills. Keep this as a follow-up
   unless the SDK adds a side-effect-free discovery mode.

> cy-review complete — 2026-07-21T11:36:00Z — rounds: 2
