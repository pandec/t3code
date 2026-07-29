# PR 68 cy-review — Extras settings — round 2

- Target: PR #68, `t3code/extras-settings-section` / local `worktree-extras-settings`
- Base: `origin/dev` at `27a50aa6c7a8bc2b460fa5f3db34357db2c17e69`
- Reviewed head: `24a21b697d96dd1b96f7d5d10c71fc6df8f2ac89`
- PR: https://github.com/pandec/t3code/pull/68
- Date: 2026-07-29
- Round: 2 (final cy-review pass)
- Diff: `origin/dev...24a21b697`, with isolated review of pass-1 fix commit `24a21b697`

## Review fleet

| Reviewer              | Primary responsibility                                                           | Why selected                                                                                 |
| --------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Skeptical composition | Broad correctness and regression across the full PR plus pass-1 fixes            | The second pass needed to catch second-order behavior introduced by the remedies.            |
| Adversarial fixes     | Challenge pass-1 fix boundaries and coupled behavior                             | Hydration gating and constrained settings resets can solve one issue while widening another. |
| Async/settings state  | Outbox hydration, timers, duration delivery, thresholds, and restore             | These are the stateful paths most likely to fail through ordering or stale state.            |
| Speech/cache          | Three-level TTS resolution, persistence, character limits, and cache replacement | The server fix crosses environment config and persisted artifact identity.                   |

All reviewers ran read-only with GPT-5.6 Sol at medium reasoning effort. The developer's accepted trade-offs were treated as constraints. This was explicitly the final cy-review pass, so no further-pass recommendation was solicited.

## Summary

- Raw findings: 4
- Unique kept findings: 2
- Fix now: 2
- Deferred: 0
- Discarded: 2

The pass-1 settings restore, provider threshold re-evaluation, TTS fallback/cache identity, and post-hydration grace-timer behavior compose cleanly. Round 2 found two narrower boundary corrections in the pass-1 fixes themselves.

## Combined findings

| ID   | File:line                                               | Source roles          | Severity | Disposition | Rationale                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------- | --------------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-1 | `apps/web/src/state/use-thread-outbox-drain.ts:232`     | Adversarial fixes     | MEDIUM   | fix now     | The pass-1 hydration guard pauses every outbox action even though only steer delivery depends on the grace setting. Hold only pre-hydration steers so queued delivery and stale-row cleanup retain their prior availability.        |
| R2-2 | `apps/web/src/notifications/turnCompletion.logic.ts:78` | Skeptical composition | LOW      | fix now     | Equal timestamps are ambiguous: projector-synthesized turns have request/start/completion all equal, but a request earlier than an equal start/completion pair is a known zero-duration turn and should respect a positive minimum. |

## Deferred candidates

None.

## Resolution and verification

Both kept findings were fixed in round 2. Pre-hydration client settings now hold only steer rows, while ordinary queued delivery and stale-row cleanup continue. Duration derivation now distinguishes projector-synthesized all-equal timestamps from a known zero-duration turn whose request preceded its stamped start.

Focused verification passed 61 tests across three files. `vp check` and `vp run typecheck` passed; the repository-wide check reported only the same 11 pre-existing warnings outside this pass.

## Discarded summary

Two reviewers challenged the warning-threshold reset when the current critical threshold is below the warning default. The proposed coupled reset would raise the sibling critical threshold and requires a product choice; it conflicts with the explicitly accepted behavior that warning is clamped down to critical. The challenge was therefore discarded rather than deferred or used to re-open the settled trade-off.
