Implemented and committed the cy-review fixes locally as `20e3be1e1`. Nothing was pushed and no PR was opened.

Fixed now:

- Prevented model-only/disabled skills from reappearing via the SDK merge.
- Hardened frontmatter recovery for comments, quoting, duplicate/nested keys, and block scalars.
- Corrected case-insensitive project-over-user precedence.
- Ran filesystem scanning concurrently with SDK initialization.
- Isolated tests from real `~/.claude` state.
- Applied empty-response fallback and `Manual` labeling consistently across web and mobile.

Verification passed:

- 103 focused tests
- `vp check` (existing warnings only)
- `vp run typecheck`
- `vp run lint:mobile`
- `git diff --check`
- Older/newer contract compatibility smoke

Still deferred:

1. During `skills/reload` failure, a successful filesystem scan can temporarily omit plugin/bundled skills. Safely combining it with the snapshot requires a partial-result contract because the snapshot may contain stale project skills. I recommend a focused follow-up only if degraded discovery is observed in practice.

2. Manual-only plugin skills outside scanned roots remain undiscoverable. Initialization commands do not distinguish skills from ordinary slash commands, so adding unmatched commands would pollute the picker. Wait for authoritative SDK metadata or implement plugin-aware discovery.

The full record is in [the review artifact](/Users/bartoszdec/.t3/worktrees/t3code/t3code-75372423/rev/BR-t3code-investigate-claude-skills-cy-review.md). Another formal review would now be diminishing returns; a web/mobile picker smoke test would provide more value, particularly for the mobile `Manual` label.
