# PR 17 Claude project skills cy-review

- Target: PR #17, `fix/claude-project-skills` into `dev`
- Date: 2026-07-21
- Diff base: `origin/dev`
- Round: 1

## Fleet

- Skeptical code reviewer: correctness, regressions, compatibility, and test strength.
- Adversarial solution reviewer: API boundaries, solution minimality, and provider-neutral design.
- Lifecycle and tests reviewer: cancellation, subprocess cleanup, cwd routing, and async coverage.

Three reviewers were appropriate because this change spans the Claude SDK lifecycle, shared contracts, and web consumers.

## Summary

- Raw findings: 1
- Kept: 1
- Fixed now: 1
- Deferred: 0
- Discarded: 0

## Findings

| ID   | File                                                    | Severity | Disposition | Rationale                                                                                                                          |
| ---- | ------------------------------------------------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| LT-1 | `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` | LOW      | Fixed now   | Added an interruption regression test and made query cleanup synchronous and idempotent when the Effect cancellation signal fires. |

## Deferred candidates

None.
