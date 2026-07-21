# PR 17 cy-review deferred items

No items deferred this run.

> cy-review complete — 2026-07-21T11:23:33Z — rounds: 2

## Deferred by separate Opus review — 2026-07-21

- **Skill discovery runs the workspace's `SessionStart` hooks.**
  `ClaudeAdapter.listSkills` must pass `settingSources: ["user", "project",
"local"]` to see project skills, and loading project settings also executes
  the project's configured `SessionStart` hooks. Verified against
  `@anthropic-ai/claude-agent-sdk@0.3.170`: with `["user", "project", "local"]`
  a project `.claude/skills/demo-skill` is discovered and the project's
  `SessionStart` hook command runs; with `["user"]` neither happens. Because
  the composer refreshes skills per workspace on a 60s stale window, hooks with
  real side effects now fire from merely opening a thread. There is no SDK
  option to load project skills without project hooks, so narrowing this needs
  a product decision (for example, discovering only on `$` trigger, caching
  longer, or accepting user-scope-only skills).
