# Cy Review: PR #2 - Pending Deliverables (Round 2)

## Target

- Branch: `worktree-reaper-pending-deliverables`
- Base: `origin/main`
- Diff: `origin/main...HEAD`
- PR: https://github.com/pandec/t3code/pull/2
- Title: `fix(server): spare provider sessions with pending deliverables from reaper`
- Review date: 2026-07-15
- Round: 2 of 2
- Pass started: 2026-07-15T12:19:39Z
- Findings compiled: 2026-07-15T12:28:00Z

## Review Fleet

The final pass covered a stateful async lifecycle and persistence change. The environment allowed three reviewer threads alongside the executing agent, so the persistence reviewer also carried the explicit adversarial-solution remit.

| Reviewer                             | Primary responsibility                                         | Why selected                                                                    |
| ------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Skeptical Code Reviewer              | Broad correctness, regressions, failure paths, and tests       | Required broad coverage, with emphasis on both post-pass-1 commits              |
| Concurrency and Lifecycle Reviewer   | Stop/start/recovery ordering, delayed events, and reaper races | The core invariant spans provider subprocesses, event fibers, and reaper fibers |
| Persistence and Consistency Reviewer | CAS semantics, retries, legacy rows, and ownership resets      | The pass-1 fixes introduced a new atomic persistence operation                  |
| Adversarial Solution Reviewer        | Challenge generation identity and final-stop safety            | Combined with persistence review because of the three-thread capacity limit     |

All reviewers were instructed to use the Sol-medium profile, preserve the accepted trade-offs, and leave CY-5 deferred.

## Summary

- Raw findings: 13
- Deduplicated kept findings: 7
- Fixed now: 7
- Deferred from prior round: 1
- Discarded after verification: 0

## Combined Findings

| ID    | File:line                                                         | Source roles                                     | Severity | Disposition | Rationale                                                                                                                                                                                                                                |
| ----- | ----------------------------------------------------------------- | ------------------------------------------------ | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY-6  | `apps/server/src/provider/Layers/ProviderService.ts:243`          | Skeptical, Concurrency, Persistence, Adversarial | HIGH     | fixed       | A queued completion from a dead/replaced same-instance subprocess can be consumed after stop/start/resume clears the flag. Provider/instance ownership cannot distinguish subprocess generations, and stopped bindings are not rejected. |
| CY-7  | `apps/server/src/provider/Layers/ProviderService.ts:339`          | Skeptical, Persistence                           | HIGH     | fixed       | The retry wraps the binding read as well as the CAS, so a retry may re-observe a replacement binding instead of replaying the immutable compare-and-set.                                                                                 |
| CY-8  | `apps/server/src/provider/Layers/ProviderSessionReaper.ts:106`    | Skeptical, Concurrency, Adversarial              | HIGH     | fixed       | The final re-read is still separated from `stopSession`; a refresh, send, or replacement can win after the check. Concurrent stop/start can also overwrite or stop the replacement owner.                                                |
| CY-9  | `apps/server/src/persistence/ProviderSessionRuntime.ts:216`       | Persistence                                      | MEDIUM   | fixed       | Legacy rows expose a default instance ID but store `NULL`, so the equality predicate can never match the binding returned by the directory.                                                                                              |
| CY-10 | `apps/server/src/provider/Layers/ProviderSessionDirectory.ts:148` | Persistence                                      | MEDIUM   | fixed       | Ownership changes reset runtime payload but retain an omitted resume cursor from the prior owner, leaking incompatible recovery state.                                                                                                   |
| CY-11 | `apps/server/src/provider/Layers/ProviderService.ts:243`          | Skeptical                                        | MEDIUM   | fixed       | Unexpected `session.exited` events do not clear pending work or mark the matching runtime generation stopped, even though the subprocess and its timers are gone.                                                                        |
| CY-12 | `apps/server/src/persistence/ProviderSessionRuntime.ts:216`       | Skeptical                                        | MEDIUM   | fixed       | Wall-clock `lastSeenAt` is not a unique CAS version; same-millisecond writes and clock rollback can defeat change detection and distort inactivity.                                                                                      |

## Final Resolution

- CY-6: added a unique Claude subprocess-generation ID to sessions and lifecycle events; completion/exit persistence now requires the same generation and ignores stopped bindings.
- CY-7: retries now wrap only the immutable revision-based compare-and-set, never the binding read.
- CY-8: provider lifecycle/recovery operations are serialized per thread, and the reaper uses an atomic revision claim plus a conditional stop that rolls back the claim if adapter teardown fails.
- CY-9: legacy null-instance bindings carry explicit compatibility metadata so their default-owner CAS predicate accepts the stored null representation.
- CY-10: ownership changes now clear an omitted resume cursor together with provider-specific runtime payload.
- CY-11: a matching `session.exited` event atomically marks the binding stopped and clears pending work and active-turn metadata.
- CY-12: persistence now uses a dedicated monotonic row revision rather than `lastSeenAt` as its CAS token; migration 33 backfills existing rows at revision zero.

## Deferred Candidates

| ID   | Scope  | Product decision | Reason to defer                                                                                                          |
| ---- | ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| CY-5 | medium | yes              | Carried from round 1 unchanged. Correctly expiring synthetic active turns needs an explicit lifecycle signal and policy. |

## Discarded Summary

No unique candidate was discarded. Repeated stale-generation, retry-scope, and reaper-TOCTOU reports were deduplicated.

## Raw Output Appendix

- Skeptical reviewer: 5 findings, represented by CY-6 through CY-8, CY-11, and CY-12.
- Concurrency reviewer: 3 findings, represented by CY-6 and CY-8.
- Persistence/adversarial reviewer: 5 findings, represented by CY-6 through CY-10.
