# PR #35 Hermes provider cy-review — round 3

- Target: `feat/hermes-provider` -> `dev`
- PR: https://github.com/pandec/t3code/pull/35
- Reviewed diff: `origin/dev...HEAD`
- Base commit: `842e57e9434a76a296de09e5f188846b97005ed9`
- Reviewed commit: `ada370ab60420abd4b2782b645d1030551a9c408`
- Pass completed: `2026-07-25T07:11:30Z`
- Round: 3 (terminal cap)

## Review fleet

| Reviewer                     | Primary responsibility                                                                     | Why selected                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Runtime concurrency          | Prompt registration, cancellation barriers, fiber cleanup, and serialized regressions      | Round 2 introduced a two-phase concurrent prompt handle and cancellation barrier. |
| Hermes settlement            | Multi-prompt terminal ordering, failure projection, interruption, and tool-card settlement | Hermes now returns from `sendTurn` before a scoped settlement fiber completes.    |
| Auth and failure integration | Advertised auth selection, persisted overrides, probe status, and terminal failures        | Round 2 replaced a fixed auth method with initialize-driven selection.            |
| Adversarial solution         | Challenge masking boundaries, handle ownership, and outcome aggregation                    | Required dissenting pass for the new stateful concurrency design.                 |

All reviewers ran read-only with `gpt-5.6-sol` at medium reasoning effort. Three reviewers ran in parallel under the repository's four-agent ceiling; the adversarial reviewer started when the first slot became available.

## Summary

- Raw findings: 8
- Kept findings after verification and deduplication: 6
- Fix now: 6
- Deferred: 0
- Discarded: 0
- Deduplicated raw findings: 2

## Combined findings

| ID    | File:line                                                       | Sources             | Severity | Disposition | Rationale                                                                                                                                                                         |
| ----- | --------------------------------------------------------------- | ------------------- | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY3-1 | `apps/server/src/provider/Layers/HermesAdapter.ts:1066`         | R3S-1, R3A-3, R3V-1 | HIGH     | fix now     | An early failure in a concurrent original/steer turn is forgotten when a later sibling succeeds, making terminal state and tool status timing-dependent.                          |
| CY3-2 | `apps/server/src/provider/acp/HermesAcpSupport.ts:43`           | R3A-1               | HIGH     | fix now     | Terminal-only Hermes auth is unsupported by T3 but is auto-selected and normalized as success, so an unconfigured install can be reported authenticated.                          |
| CY3-3 | `apps/server/src/provider/acp/HermesAcpSupport.ts:39`           | R3A-2               | MEDIUM   | fix now     | A stale explicit auth override is not checked against advertised agent-managed methods and Hermes normalizes the mismatch as success.                                             |
| CY3-4 | `apps/server/src/provider/acp/AcpSessionRuntime.ts:903`         | R3V-2               | MEDIUM   | fix now     | Caller interruption between concurrent `promptStart` and `handle.start` can strand a registered fiber behind an unreleased start barrier.                                         |
| CY3-5 | `apps/server/src/provider/Layers/HermesAdapter.ts:1168`         | R3V-3               | MEDIUM   | fix now     | Whole-effect masking keeps lock acquisition, model selection, and attachment reads uninterruptible even though only prompt commit and handoff need atomicity.                     |
| CY3-6 | `apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts:512` | R3S-2               | MEDIUM   | fix now     | The cancellation-barrier test never proves `promptStart` waits because the second handle is not started and the server-side delay does not block the one-way client notification. |

## Deferred candidates

No items deferred this run.

## Discarded summary

No validated findings were discarded.

## Planned fix disposition

- Retain the first failure or cancellation outcome on the active Hermes turn and make it dominate final settlement, while keeping synthesized tool completion before the one terminal event.
- Select only advertised agent-managed Hermes auth methods, reject stale overrides, and surface terminal-only setup as unauthenticated instead of authenticated.
- Make the one-shot concurrent `prompt()` registration/start handoff atomic while restoring interruptibility for the RPC wait.
- Narrow Hermes `sendTurn` masking to the prompt registration/state/start/background-fiber handoff.
- Replace the vacuous cancellation test with a deterministic client-side protocol-log barrier.

## Implementation outcome

- Hermes now retains failure/cancellation across every prompt in a merged turn, applies deterministic failure precedence, settles open tools as failed when needed, and emits one final terminal event.
- Concurrent one-shot `prompt()` calls mask registration through start, then restore interruptibility while awaiting the RPC; the cancellation test now blocks the client notification send and proves registrations remain pending through caller interruption.
- Hermes `sendTurn` keeps lock acquisition, model selection, and attachment reads interruptible while preserving an atomic prompt registration-to-settlement-fiber handoff.
- Hermes authentication selects only advertised agent-managed methods. Terminal-only setup and stale overrides fail session startup, while provider probing reports a setup-required unauthenticated warning.

## Verification

- `vp check`: passed with 11 pre-existing web warnings and no review-introduced warnings.
- `vp run typecheck`: passed.
- `vp run lint:mobile`: passed; SwiftLint, ktlint, and detekt were unavailable and skipped by the repository script.
- Focused matrix: 19 files passed, 2 probe-gated files skipped; 191 tests passed, 6 skipped.
