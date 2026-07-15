# Cy Review: PR #2 - Pending Deliverables

## Target

- Branch: `worktree-reaper-pending-deliverables`
- Base: `origin/main`
- Diff: `origin/main...HEAD`
- PR: https://github.com/pandec/t3code/pull/2
- Title: `fix(server): spare provider sessions with pending deliverables from reaper`
- Review date: 2026-07-15
- Round: 1
- Pass started: 2026-07-15T11:56:00Z
- Findings compiled: 2026-07-15T12:01:58Z

## Review Fleet

The 13-file change crosses async SDK hooks, runtime event fanout, session persistence, and periodic cleanup, so four distinct reviewers were used.

| Reviewer                             | Primary responsibility                                           | Why selected                                                                         |
| ------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Skeptical Code Reviewer              | Broad correctness, regressions, failure paths, and tests         | Required broad coverage for a stateful server change                                 |
| Concurrency and Lifecycle Reviewer   | Reaper/completion races and Claude state lifecycle               | The feature coordinates multiple asynchronous fibers and session generations         |
| Persistence and Consistency Reviewer | Ownership guards, payload merge semantics, and directory upserts | The new completion path mutates the durable routing binding                          |
| Adversarial Solution Reviewer        | Challenge ownership, boundaries, and immortality safeguards      | Required for a substantial behavioral change and used to test the design assumptions |

All reviewers were instructed to use the Sol-medium profile and to honor the accepted trade-offs in the PR description.

## Summary

- Raw findings: 13
- Deduplicated kept findings: 5
- Fix now: 4 (completed)
- Deferred: 1
- Discarded after verification: 0

## Combined Findings

| ID   | File:line                                                         | Source roles                                     | Severity | Disposition | Rationale                                                                                                                                                                                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------ | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY-1 | `apps/server/src/provider/Layers/ProviderService.ts:254`          | Skeptical, Concurrency, Persistence, Adversarial | HIGH     | fixed       | The mismatch check and generic upsert are separate operations. A delayed completion can race a replacement binding, restore obsolete ownership, or lose concurrent payload fields. Use an atomic compare-and-patch that only touches `lastSeenAt` and the pending flag while ownership still matches.                                        |
| CY-2 | `apps/server/src/provider/Layers/ProviderSessionReaper.ts:67`     | Skeptical, Concurrency, Persistence, Adversarial | HIGH     | fixed       | The sweep decides from a binding snapshot taken before the projection lookup. A completion can refresh the binding during that yield, but the stale candidate is still stopped. Re-read and re-evaluate the current binding after the projection check and add a deterministic interleaving test.                                            |
| CY-3 | `apps/server/src/provider/Layers/ProviderSessionDirectory.ts:143` | Skeptical, Persistence                           | MEDIUM   | fixed       | Provider-specific `hasPendingWork` is merged across provider/instance ownership changes. A replacement Codex binding can inherit a Claude-only pending flag and receive an unrelated extension. Reset runtime payload at ownership boundaries while preserving same-owner recovery metadata.                                                 |
| CY-4 | `apps/server/src/provider/Layers/ClaudeAdapter.ts:1966`           | Adversarial                                      | MEDIUM   | fixed       | The adapter represents an unobserved Stop-hook state as `false` and emits it on interrupted, failed, synthetic, and resumed completion paths. Use `boolean \| undefined`, reset the observation at a new turn boundary, and omit the field until the hook provides current evidence.                                                         |
| CY-5 | `apps/server/src/provider/Layers/ProviderSessionReaper.ts:91`     | Concurrency                                      | MEDIUM   | defer       | The active-turn guard runs before the pending extension cap, while Claude synthetic background turns can remain open until a later user prompt. A stale synthetic turn can therefore bypass the 24-hour cap indefinitely, but distinguishing it from a legitimately long-running turn needs an explicit lifecycle signal and cleanup policy. |

## Final Resolution

- CY-1: added an atomic owner-and-version-checked persistence refresh that patches only `lastSeenAt` and the pending-work field.
- CY-2: re-read and re-evaluate the current binding after the projection lookup; added a deterministic mid-sweep refresh test.
- CY-3: provider/instance ownership changes now reset provider-specific runtime payload instead of merging it into the replacement binding.
- CY-4: Claude pending-work observations are tri-state and reset at real and synthetic turn boundaries; completion omits the field when no Stop hook observed current state.
- CY-5: retained as a deferred lifecycle-policy issue.

## Deferred Candidates

| ID   | Scope  | Product decision | Reason to defer                                                                                                                                                                                         |
| ---- | ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY-5 | medium | yes              | The persisted projection does not identify synthetic turns. Reaping every old active turn would risk terminating legitimate long-running work, so this needs a separate representation/policy decision. |

## Discarded Summary

No unique candidate was discarded. Repeated reports of the same ownership and reaper races were deduplicated into CY-1 and CY-2.

## Raw Output Appendix

- Skeptical reviewer: 3 findings; all represented by CY-1 through CY-3.
- Concurrency reviewer: 3 findings; represented by CY-1, CY-2, and CY-5.
- Persistence reviewer: 4 findings; its ownership/lost-update reports were combined into CY-1, with the remaining reports represented by CY-2 and CY-3.
- Adversarial reviewer: 3 findings; represented by CY-1, CY-2, and CY-4.
