# PR 12 review — mobile steering

- Branch: `agent/mobile-steering`
- Base: `dev`
- PR: https://github.com/pandec/t3code/pull/12
- Date: 2026-07-20
- Diff base: `origin/dev...HEAD` (excluding `rev/`)
- Round: 2 (round 1 recorded in `rev/PR-12-mobile-steering-cy-review.md`)

## Review fleet

| Reviewer                              | Selection reason                                                                                                               | Primary responsibility                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Skeptical Code Reviewer               | The change relaxes a delivery gate that previously protected against provider rejection; regression risk is the main exposure. | Disprove correctness: regressions, provider failure paths, races, integration contracts, test gaps. |
| Design And Reuse Reviewer             | A prop chain was deleted and a boolean input widened to a status union across three layers; drift and dead code are plausible. | Maintainability, ownership, duplicated status logic, dead props, reuse of existing helpers.         |
| Outbox & Session-Lifecycle Specialist | The concrete risk is data consistency between the durable mobile outbox and the server session state machine.                  | FIFO/duplicate delivery, status-union coverage, `activeTurnId` lifecycle, stuck-session risk.       |

Three reviewers were sufficient. An efficiency reviewer was omitted: the diff touches no hot path, adds no rendering or network work, and contains no styling.

## Summary

- Raw findings: 6
- Retained findings: 5
- FIX: 2
- Deferred: 3
- Discarded: 1

## Retained findings

| ID  | File:line                                                                                                      | Source     | Severity | Action | Scope  | Product decision | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------- | ---------- | -------- | ------ | ------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts:898`                                      | Specialist | LOW      | FIX    | small  | no               | The PR's happy path — a `thread.turn.start` dispatched while `session.status === "running"` that the provider **accepts** — has no reactor-level test. Only the failure-preservation path is covered. Add a test asserting the resulting `activeTurnId`/`status` for an accepted steer, so the feature's core behaviour is pinned.                                                                                                                                                                                                                                               |
| R2  | `apps/mobile/src/state/thread-outbox.test.ts:426`                                                              | Specialist | LOW      | FIX    | tiny   | no               | `threadStatus` widened from a boolean to the full `OrchestrationSessionStatus \| null` union, but the `threadExists: true` branch is only tested for `null`, `"starting"`, `"running"`. Add cases for `"ready"`, `"interrupted"`, `"stopped"`, `"error"`, `"idle"` to lock in "every non-`starting` status sends" before someone adds a status.                                                                                                                                                                                                                                  |
| R3  | `apps/mobile/src/state/thread-outbox-model.ts:173` + `apps/mobile/src/features/threads/ThreadComposer.tsx:307` | Skeptical  | MEDIUM   | defer  | medium | **yes**          | When a provider rejects a steer (special turns such as review or manual compact), the user message is already persisted and the outbox entry already removed; the only signal is a generic `provider.turn.start.failed` activity with no client-side rendering (verified: the kind is emitted only in `ProviderCommandReactor.ts:769,822` and matched nowhere in a client). Mobile now also shows "Send" rather than "Queue", so the user has no advance cue. This is the round-1 deferred delivery-semantics item plus a newly noted absence of a user-visible failure surface. |
| R4  | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:289`                                           | Skeptical  | LOW      | defer  | tiny   | no               | `setThreadSessionErrorOnTurnStartFailure` re-reads the session (so `activeTurnId`/`status` are safe) but unconditionally stamps the failed attempt's `lastError`. Since `withThreadLock` only serialises the provider RPC, a stale failure handler can land after a newer successful turn and paint a misleading error on a healthy running session. Diagnostic-only, needs near-simultaneous overlapping starts.                                                                                                                                                                |
| R5  | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:299`                                           | Design     | LOW      | defer  | tiny   | no               | `preserveActiveTurn` reads as governing only `activeTurnId`, but it is also OR'd into the `status` fallback next to an unrelated `"stopped"` check — two different reasons collapsed into one expression. Splitting into `nextStatus`/`nextActiveTurnId` locals, or one comment, removes the reverse-engineering. Correctness is fine.                                                                                                                                                                                                                                           |

## Deferred candidates

| Item                                                          | Why deferred                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3 — rejected-steer message recovery and user-visible failure | Needs a provider-delivery acknowledgement or server-owned pending-delivery contract so the outbox can retry without duplicating the persisted message; already accepted as deferred in round 1 (`rev/check/PR-12-cy-review-deferred.md`). The UI-surface half (rendering `provider.turn.start.failed` distinctly, or labelling the composer per steering capability) is a separable product decision. |
| R4 — stale `lastError` on a since-recovered session           | Requires a broader write-ordering or generation guard around `thread.session.set`; cosmetic impact does not justify that here.                                                                                                                                                                                                                                                                        |
| R5 — `preserveActiveTurn` naming/clarity                      | Pure readability; safe to fold into the next touch of this handler.                                                                                                                                                                                                                                                                                                                                   |

## Discarded

- **Centralising `session?.status === "starting"` into a shared predicate** (design reviewer, LOW) — the three call sites carry different semantics (button disable, delivery gate, status pill), and the repo has no such predicate helper anywhere despite pervasive inline status checks. Abstraction for its own sake.
- **"Codex has no steering support, so all steered messages are silently lost" (skeptical reviewer, claimed HIGH)** — narrowed to R3 rather than retained as stated. The claim was inferred from the absence of adapter-local steering bookkeeping in `CodexSessionRuntime.ts`, but Codex delegates turn handling to the app-server over `turn/start` instead of tracking an in-process loop like the SDK-embedded adapters. The rejection string the reviewer cited exists only in the new test and describes a _review_ turn specifically — consistent with the app-server rejecting special turns and accepting ordinary ones, which is what round 1 concluded. The verified residual (rejected steers strand the message with no user-visible signal) is retained as R3.

## Verified clean

- `activeThreadBusy` / `threadBusy` have zero remaining references repo-wide; the prop chain removal is complete and `apps/mobile` typechecks.
- Client/server gating is consistent: `decider.ts` and `commandInvariants.ts` block `turn.start` only on `"starting"`, matching the outbox's `threadStatus !== "starting"`.
- No new duplicate-delivery race: `dispatchingQueuedMessageIdAtom` keeps exactly one outbox entry in flight, and the next is picked up only after `completeDelivery` resolves.
- Ordering under rapid steering holds: the reactor worker drains `thread.turn-start-requested` FIFO and `ProviderService.sendTurn` is wrapped in a per-thread semaphore.
- The `vi.fn<ProviderServiceShape["sendTurn"]>` typing change matches the existing typed-mock pattern in the same file — not scope creep.
