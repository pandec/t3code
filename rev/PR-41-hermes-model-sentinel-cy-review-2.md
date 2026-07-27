# PR #41 cy-review — Hermes model sentinel — round 2

## Target

- Branch: `fix/hermes-model-sentinel`
- Base: `origin/dev`
- Pull request: https://github.com/pandec/t3code/pull/41
- Full diff: `git diff origin/dev...HEAD`
- Pass-1 focus commit: `832f2443c`
- Date: 2026-07-26
- Round: 2 (final cy-review pass)

## Review fleet

Three Sol-medium reviewers independently focused on the state introduced by pass 1:

- Cursor Compatibility Reviewer — old/new/malformed cursor shapes, missing model
  state, ProviderService persistence, recovery, and test-matrix strength.
- Adversarial Solution Reviewer — challenged cursor ownership and the boundary
  between ACP mutation and T3 state commitment.
- Concurrency/State-Machine Reviewer — enumerated model-switch, steering,
  interruption, failure, cancellation, completion-order, and restart interleavings.

## Summary

- Raw findings: 4
- Deduplicated kept findings: 2
- Fix now: 2
- Deferred: 0
- Discarded: 0

## Combined findings

| ID    | File:line                                               | Sources       | Severity | Disposition | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | ------------------------------------------------------- | ------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY2-1 | `apps/server/src/provider/Layers/HermesAdapter.ts:805`  | SK2-1, ADV2-1 | HIGH     | fix now     | Schema-version-1 cursors do not distinguish “legacy cursor whose setup model may be inferred for compatibility” from “new cursor where Hermes exposed no configured default.” Missing model state can therefore resume while claiming `"default"` without any restorable identity. Make new cursors explicitly encode known/unknown default identity, retain a bounded v1 compatibility rule, and fail conservatively when resumed default identity remains unresolved. |
| CY2-2 | `apps/server/src/provider/Layers/HermesAdapter.ts:1037` | ADV2-2, CC2-1 | HIGH     | fix now     | `session/set_model` can mutate Hermes before attachment validation or interruption, while T3 commits `ctx.currentModelId` and `ctx.session.model` only much later. Validate prompt inputs first, make the successful remote mutation plus local state commit cancellation-safe, and add an interruption checkpoint before launching the prompt.                                                                                                                         |

## Deferred candidates

None.

## Resolutions

### CY2-1 — fixed

- Resume cursors are now version 2 and always encode default identity as either
  a concrete `defaultModelId` or explicit `null`.
- Version-1 cursors remain readable. Their reported setup model is used only for
  the bounded legacy case where the persisted client selection is still
  `"default"`; version-2 unknown state is never inferred.
- A resumed sentinel selection whose default identity remains unknown now fails
  explicitly at `session/load`. Concrete selections can still resume, but a
  later attempt to restore an unknown default fails before model or prompt state
  changes.

### CY2-2 — fixed

- Text and attachments are resolved and validated before any Hermes model
  mutation.
- The thread semaphore serializes selection changes. A successful
  `session/set_model` response is committed to local session state before
  cancellation is observed.
- If interruption wins while the RPC response is uncertain, the ACP session is
  torn down instead of reusing potentially divergent state. The test recovers
  from the saved cursor, reapplies the concrete client selection, then restores
  `"default"`.
- The unknown-default failure is also exercised during an active steer; the
  original prompt completes normally and preserves the concrete selection.

## Verification

- `vp check`
- `vp run typecheck`
- Focused Vite+ matrix covering all Hermes, Grok, and Cursor adapter/provider/ACP
  and text-generation suites; all ProviderCommandReactor suites;
  ProviderRegistry; Hermes registry hydration; and contracts settings:
  20 files passed, 2 skipped; 276 tests passed, 6 skipped.

## Opus closing-review checklist

1. Verify the historical v1 compatibility assumption: prior production cursors
   with client selection `"default"` could not have performed a supported
   mid-thread concrete override, so using a reported setup model for that one
   legacy migration is safe; v2 unknown defaults must never use that inference.
2. Verify the Effect interruption boundary around `session/set_model`: after the
   provider answers, local model state must commit before a pending interruption
   is observed; if interruption wins while the response is uncertain, the ACP
   session is deliberately torn down and recovered from its cursor rather than
   reused. Confirm that this teardown is the right bounded alternative to making
   an unbounded ACP RPC uninterruptible.
3. Verify that a stale cursor `defaultModelId` rejected by Hermes produces an
   actionable provider error without corrupting the current live selection.
4. Confirm that literal ACP `currentModelId: "default"` is not a concrete model id
   that Hermes expects T3 to send back through `session/set_model`.

## Audit notes

- ProviderService preserves the opaque cursor through start, send, stop,
  stop-all/reaper refresh, JSON persistence, recovery, and active-session adoption.
- Hermes exposes no fork or native-import adapter methods, so those generic
  ProviderService paths do not transform this cursor.
- Once preparation succeeds, the pass-1 completion-order fix correctly preserves
  the lock-serialized latest selection through success, failure, cancellation,
  interruption, and reverse completion order.
- Prompt validation now precedes model mutation. Interruption during
  `session/set_model` stops the uncertain ACP session; the regression test then
  resumes from the v2 cursor, reapplies the concrete client selection, restores
  `"default"`, and verifies the final projection.
- The unknown-default failure is exercised as a steer while another prompt is
  still in flight; it launches no second prompt, and the original completion
  preserves the latest concrete selection.
