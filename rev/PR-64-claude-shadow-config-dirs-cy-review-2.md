# PR 64 cy-review — Claude shadow config dirs — round 2

- Branch: `claude-shadow-home`
- Base: `origin/dev` at `32360f41dd9e3f2c4399db0ff7603ce807ac5cbe`
- Reviewed head: `65079a0b9a680f67a44d4318ab793932fcc1f5bd`
- Diff: `origin/dev...HEAD`
- PR: https://github.com/pandec/t3code/pull/64
- Round: 2 of 2
- Started: `2026-07-29T07:49:00Z`

## Fleet

Three parallel Sol-medium reviewers were used, the maximum available alongside the accountable executor:

- Filesystem/state specialist — attacked the round-1 path, symlink, mutation-order, and convergence hardening.
- Provider integration/contracts specialist — rechecked driver failure isolation, callers, settings patches, and cache-key consumers.
- Adversarial solution/test reviewer — challenged new round-1 behavior and test confidence within the accepted design constraints.

The executor independently re-audited the materializer, provider runtime cwd semantics, registry failure path, settings contracts, and cache-key usage.

## Summary

- Raw findings: 4
- Deduplicated findings kept for validation: 3
- Proposed fix now: 1
- Proposed deferred: 2
- Discarded at compilation: 0

## Combined findings

| ID    | File:line                         | Sources        | Severity | Proposed disposition | Rationale                                                                                                                                                                                                                 |
| ----- | --------------------------------- | -------------- | -------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-C1 | `ClaudeDriver.ts:134`             | R2AT-1         | MEDIUM   | fix now              | A relative inherited config dir is project-cwd-relative at runtime; resolving the static overlay from server cwd materializes the wrong shared directory.                                                                 |
| R2-C2 | `ClaudeHomeLayout.ts:239,335`     | R2FS-1, R2AT-2 | HIGH     | defer                | Reusing one shadow with another shared home can retarget required links while preserving stale optional links, and can silently redirect an already-live first instance. Safe behavior needs a shadow-ownership decision. |
| R2-C3 | `ClaudeHomeLayout.ts:188,239,335` | R2FS-2         | MEDIUM   | defer                | Check-then-remove operations can unlink a replacement file written by another process; portable prevention needs serialization or compare-and-swap semantics, not another advisory re-read.                               |

## Deferred candidates

| ID    | Scope                                | Why not fix in this pass                                                                                                                                                                                                                        |
| ----- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-C2 | Shadow ownership across shared homes | The existing code and tests intentionally permit retargeting. Rejecting mismatched targets, auto-reassigning ownership, or coordinating live owners are different product contracts.                                                            |
| R2-C3 | Cross-process filesystem races       | The Effect filesystem API does not provide an atomic “remove only if this is still the symlink I read” primitive. A robust fix needs a broader ownership/locking design and must account for Claude processes that do not honor a T3-only lock. |

## Discarded summary

The integration/contracts reviewer found no material issue. The accepted parallel-module, continuation-group, shadow-environment precedence, and whitelist decisions were not re-litigated.

## Validated disposition

- Fixed R2-C1 by rejecting shadow overlays whose inherited `CLAUDE_CONFIG_DIR` or fallback `HOME` is relative, with an actionable typed error mapped through `ProviderDriverError`.
- Deferred R2-C2 because the existing retargeting behavior is intentional and safe resolution requires choosing whether one shadow may be reassigned or simultaneously owned by multiple shared homes.
- Deferred R2-C3 because re-reading cannot eliminate the race and no portable compare-and-remove primitive exists at the current filesystem boundary.
