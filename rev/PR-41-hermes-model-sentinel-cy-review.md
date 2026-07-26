# PR #41 cy-review — Hermes model sentinel

## Target

- Branch: `fix/hermes-model-sentinel`
- Base: `origin/dev`
- Pull request: https://github.com/pandec/t3code/pull/41
- Diff: `git diff origin/dev...HEAD`
- Date: 2026-07-26
- Round: 1

## Review fleet

Three Sol-medium reviewers covered the stateful provider change without duplicating
responsibilities:

- Skeptical Code Reviewer — end-to-end Hermes selection flow, resume, steering,
  runtime-event sinks, and regression-test strength.
- Adversarial Solution Reviewer — implementation-level challenges to state ownership
  and resume semantics while treating the user-approved design decisions as fixed.
- Recovery/Concurrency/Test Specialist — reactor recovery inputs, gateway parsing,
  concurrent probe teardown and timeout behavior, settings hydration, docs, and test
  invariants.

## Summary

- Raw findings: 6
- Deduplicated kept findings: 3
- Fix now: 3
- Deferred: 0
- Discarded: 0

## Combined findings

| ID   | File:line                                               | Sources           | Severity | Disposition | Rationale                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------- | ----------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY-1 | `apps/server/src/provider/Layers/HermesAdapter.ts:786`  | SK-1, ADV-1       | HIGH     | fix now     | The resume cursor does not retain the configured-default model identity. A resumed concrete override is mistaken for the default, so reselecting the sentinel can silently no-op while the session claims `"default"`. Persist the optional default model in the opaque cursor, retain a backward-compatible fallback, and explicitly reject default restoration when Hermes never reported a restorable default. |
| CY-2 | `apps/server/src/provider/Layers/HermesAdapter.ts:1161` | SK-2, RC-1, ADV-2 | HIGH     | fix now     | Concurrent steering prompts capture different display selections and overwrite `ProviderSession.model` in completion order. Completion order is not selection order, so completion must preserve the latest selection already recorded under the thread lock.                                                                                                                                                     |
| CY-3 | `docs/providers/hermes.md:5`                            | RC-2              | LOW      | fix now     | The guide still describes the gateway as present by default even though `requireGateway` now defaults off. Document it as the optional machine-identity check.                                                                                                                                                                                                                                                    |

## Deferred candidates

None.

## Discarded summary

No reported finding was discarded. Independent verification also confirmed that
reactor-driven recovery always supplies the thread's `modelSelection`, the gateway
marker parser matches the current launchd/systemd/manual/Windows output branches,
the totalized concurrent probes cannot fail each other, scoped ACP discovery is
closed on timeout, and failed discovery retains configured fallback models.

## Audit notes

- The unchanged-selection reactor test fails only when an adapter violates the
  documented selection-echo contract; the lying-adapter test correctly
  characterizes the intentionally unchanged rejection behavior.
- The original sentinel-echo test fails against the production bug, but additional
  resume and out-of-order steering coverage is required for CY-1 and CY-2.

## Resolution

- CY-1 fixed: Hermes resume cursors now retain the configured-default model id.
  Resume can restore that model when the client reselects `"default"`; if Hermes
  never exposed a restorable default, the switch fails explicitly instead of
  claiming success while leaving the concrete model active.
- CY-2 fixed: prompt completion preserves the newest serialized session selection.
  Reverse-completion steering coverage now uses distinct model selections and
  asserts the final session model.
- CY-3 fixed: the Hermes guide now describes **Require local gateway** as the
  optional, default-off machine-identity marker.

## Verification

- `vp test run` focused Hermes/Grok/Cursor, ProviderCommandReactor,
  ProviderRegistry, Hermes hydration, and contracts settings matrix:
  18 files passed, 2 environment-gated files skipped; 268 tests passed, 6 skipped.
- `vp check`: passed (unrelated existing lint warnings only).
- `vp run typecheck`: passed (suggestions only).
- `git diff --check`: passed.
