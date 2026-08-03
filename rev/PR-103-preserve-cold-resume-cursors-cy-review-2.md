# PR #103 cy-review — round 2

## Target

- Branch: `t3code/preserve-cold-resume-cursors`
- Base: `origin/dev`
- Pull request: https://github.com/pandec/t3code/pull/103
- Reviewed head: `5854af79707ba0b4d92279878e87c09bf2c882de`
- Diff: `git diff origin/dev...HEAD`
- Pass started: `2026-08-03T07:37:08Z`
- Round: 2 (final requested cy-review round)

The four accepted product/design trade-offs from round 1 remained fixed constraints.

## Review fleet

| Reviewer                 | Primary responsibility                                              | Why selected                                                                                  |
| ------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Skeptical correctness    | Disprove end-to-end post-fix behavior and tests                     | The final pass needed broad regression coverage over both commits.                            |
| Adversarial solution     | Challenge the new resolver and lifecycle boundaries                 | Round 1 introduced an additive registry contract and moved authority between layers.          |
| Atomic registry/routing  | Trace hot reload, warm/cold ordering, and failover                  | Continuation identity must remain stable across asynchronous registry and session operations. |
| Persistence/import/tests | Re-audit durable keys, directory authority, import dedup, and mocks | The feature's safety still depends on persisted upgrade data and focused regressions.         |

All reviewers ran read-only with `gpt-5.6-sol` at medium reasoning effort.

## Summary

- Raw findings: 7
- Deduplicated kept findings: 4
- Proposed fix now: 4
- Proposed deferred: 0
- Discarded after reviewer output: 0

## Combined findings

| ID    | File:line                                                            | Source roles                           | Severity | Proposed disposition | Rationale                                                                                                                                                  |
| ----- | -------------------------------------------------------------------- | -------------------------------------- | -------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-C1 | `apps/server/src/provider/Layers/ProviderService.ts:867`             | skeptical, adversarial, atomic/routing | HIGH     | fix now              | An explicit warm-path cursor skips the incompatible/unprovable persisted-owner gate and can cross a target hot reload into the wrong continuation store.   |
| R2-C2 | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:631` | skeptical                              | HIGH     | fix now              | A stopped owner whose configured identity drifted is compared by its current key, rejecting a compatible replacement that matches the durable binding key. |
| R2-C3 | `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts:36`      | adversarial, atomic/routing            | MEDIUM   | fix now              | `resolveInstance` reads instance and config from separate registry generations, so its failover edge is not actually from the promised atomic snapshot.    |
| R2-C4 | `apps/server/src/provider/Layers/ProviderService.ts:685`             | adversarial                            | MEDIUM   | fix now              | Active-session routing returns before validating the persisted binding's provider and continuation key against the resolved adapter snapshot.              |

## Deferred candidates

None proposed in reviewer output.

## Discarded summary

No reviewer findings were discarded before live-code validation. Final dispositions are recorded below after implementation and verification.

## Final dispositions

| ID    | Final disposition | Resolution                                                                                                                                                                                       |
| ----- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R2-C1 | fixed             | Explicit cursors now fail when durable persisted ownership is incompatible or unprovable; reactor starts opt into the same fail-closed policy inside the locked service operation.               |
| R2-C2 | fixed             | The reactor no longer treats a stopped owner's current live key as authoritative; ProviderService compares the desired snapshot with the persisted binding key.                                  |
| R2-C3 | fixed             | The live instance registry now returns the materialized instance and settings envelope from one `Ref` snapshot, so continuation identity and failover routing cannot be torn across generations. |
| R2-C4 | fixed             | Session-scoped routing validates the persisted provider and continuation key against the resolved adapter before checking or adopting an active session.                                         |

No findings were deferred across either cy-review round.

## Verification

- `pnpm --filter t3 typecheck`
- `env -u CLAUDE_CONFIG_DIR pnpm --dir apps/server exec vp test run src/provider src/orchestration src/sessionImport/SessionImportService.test.ts` — 81 files passed, 2 skipped; 1,041 tests passed, 6 skipped
- `pnpm fmt:check`

## Compact raw-output appendix

- R2-C1 was independently reported as SC2-2, AS2-2, and AR2-1.
- R2-C2 was SC2-1.
- R2-C3 was independently reported as AS2-1 and AR2-2.
- R2-C4 was AS2-3.
- The persistence/import/test specialist reported no material finding.
