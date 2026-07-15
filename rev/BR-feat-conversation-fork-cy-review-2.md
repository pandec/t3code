# Conversation fork cy-review — round 2

- Target: `feat/conversation-fork`
- Base: `dev`
- Date: 2026-07-15
- Diff: `dev...feat/conversation-fork`
- PR: not opened yet

## Fleet

- Skeptical reviewer (Sol medium): async ordering and failure-state regressions.
- Provider/concurrency specialist (Sol medium): native provider lifecycle and persistence alignment.
- Adversarial solution reviewer (Sol medium): state ownership, upstream-sync cost, and duplicated semantics.

The second pass focused on the new pass-1 safeguards rather than repeating broad contract coverage.

## Summary

- Raw findings: 5
- Kept after deduplication: 4
- Fix now: 4
- Deferred: 0
- Discarded: 0

## Combined findings

| Location                                                         | Roles               | Severity | Disposition | Rationale                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` | skeptical, provider | HIGH     | fixed       | The reactor forked `sendTurn` and could process a queued fork before the adapter changed from idle to running. A per-source pending marker now spans provider turn establishment, and a deterministic test holds `sendTurn` to verify no native fork call occurs. |
| `packages/shared/src/conversationFork.ts` and consumers          | adversarial         | MEDIUM   | fixed       | The failed-fork discriminator was duplicated as presentation text across server, web, and mobile. A shared explicit subpath now owns the marker and predicate.                                                                                                    |
| `apps/server/src/provider/Drivers/ClaudeSessionFork.ts`          | adversarial         | MEDIUM   | fixed       | The isolated Claude process was embedded in the large adapter and only the injected path was tested. It now lives in a focused driver helper with a real SDK transcript-fork test under a temporary custom `HOME`.                                                |
| Fork eligibility across invariant, provider, web, and mobile     | provider            | MEDIUM   | fixed       | Error-state source sessions were offered by clients and accepted initially, then rejected by the provider service after creating a dead destination. Error sources are now rejected consistently before destination creation.                                     |

## Deferred candidates

None.

## Discarded summary

No findings were discarded after duplicate consolidation.

## Verification notes

The focused round-2 suite passes with 95 tests, including the real Claude SDK subprocess path and the held
turn-start race. Full repository gates are run after this pass and again before PR handoff.
