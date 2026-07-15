# Conversation fork cy-review — round 1

- Target: `feat/conversation-fork`
- Base: `dev`
- Date: 2026-07-15
- Diff: `dev...feat/conversation-fork`
- PR: not opened yet

## Fleet

- Correctness reviewer (Sol medium): provider API and persistence correctness.
- Skeptical reviewer (Sol medium): failure paths, races, and regression risks.
- Adversarial solution reviewer (Sol medium): challenged state ownership and private-build tradeoffs.

This cross-module asynchronous feature warranted three distinct reviewers. The fleet focused on provider
identity, durable orchestration state, and whether the chosen race protection could harm normal turns.

## Summary

- Raw findings: 4
- Kept: 4
- Fix now: 4
- Deferred: 0
- Discarded: 0

## Combined findings

| Location                                                                 | Roles                  | Severity | Disposition | Rationale                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ---------------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`                       | correctness, skeptical | HIGH     | fixed       | The SDK top-level fork helper used process-global home discovery, so a custom Claude `HOME` could fork the wrong account or fail. The fork now runs in an isolated Node process with the selected instance environment.                                                       |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`         | skeptical              | HIGH     | fixed       | A failed asynchronous fork had no provider binding, but its error destination could accept a turn and silently become a fresh conversation. Failures now carry a fork-specific marker, and turns/re-forks are rejected.                                                       |
| `apps/server/src/orchestration/projector.ts` and `ProjectionPipeline.ts` | adversarial            | HIGH     | fixed       | Projecting every accepted turn as durable `starting` could strand ordinary threads after a crash before the transient reactor handled the request. The global projection change was removed; the provider service now rechecks live source status immediately before forking. |
| `apps/mobile/src/features/threads/ThreadRouteScreen.tsx`                 | adversarial            | MEDIUM   | fixed       | Mobile only alerted on synchronous command rejection, so a later provider failure was easy to miss. The destination now alerts once when its fork-specific asynchronous error arrives.                                                                                        |

## Deferred candidates

None.

## Discarded summary

No findings were discarded.

## Verification notes

Focused tests cover custom Claude home propagation, provider-side active-turn rejection, failed-fork
command rejection, and the existing fork projection/provider/reactor paths. Full repository gates are run
after review fixes and again before PR handoff.
