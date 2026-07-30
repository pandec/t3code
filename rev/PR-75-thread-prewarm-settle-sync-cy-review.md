# PR 75 cy-review: thread prewarm settle sync

- Branch: `t3code/thread-prewarm-settle-sync`
- Base: `origin/dev` at `d5acb7b39d22fa4d6bebebfe7cf58a86158a5476`
- Reviewed head: `4aea1bc63d30ef99f12ba999d9748fc7b10002be`
- PR: https://github.com/pandec/t3code/pull/75
- Date: 2026-07-30
- Round: 1
- Diff: `origin/dev...HEAD`

## Fleet

Three reviewers were used because the four-slot execution limit allows three parallel subagents plus
the accountable primary reviewer.

- Skeptical concurrency reviewer: trigger batching, cooldowns, PubSub semantics, and focused tests.
- Mobile UI/state reviewer: settle hook cost and lifecycle, manual-sync state, accessibility, and
  mobile compatibility.
- Adversarial integration reviewer: service boundaries, layer composition, multi-environment
  semantics, and solution complexity.

All reviewers ran with GPT-5.6 Sol at medium reasoning effort. The adversarial reviewer used the
dedicated adversarial role.

## Summary

- Raw findings: 9
- Deduplicated kept findings: 5
- Fix now: 5
- Deferred: 0
- Discarded: 0

## Combined findings

| ID   | File:line                                                          | Sources     | Severity | Disposition | Rationale                                                                                                          |
| ---- | ------------------------------------------------------------------ | ----------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| CY-1 | `apps/mobile/src/features/keyboard/hardwareKeyboardCommands.ts:60` | SK, UI, ADV | HIGH     | fix now     | The PR calls Hermes-unsupported `toReversed()` despite the adjacent compatibility warning.                         |
| CY-2 | `packages/client-runtime/src/state/threadPrewarm.ts:364`           | SK          | MEDIUM   | fix now     | A manual full run writes `lastFullRunAt`, incorrectly consuming the lifecycle cooldown.                            |
| CY-3 | `apps/mobile/src/features/settings/SettingsRouteScreen.tsx:583`    | UI, ADV     | MEDIUM   | fix now     | The maximum aggregate timestamp lets the first environment or unrelated run clear a multi-environment manual sync. |
| CY-4 | `apps/mobile/src/features/settings/SettingsRouteScreen.tsx:592`    | UI, ADV     | LOW      | fix now     | `Date.now()` is read only during render, so relative sync text does not advance while Settings remains open.       |
| CY-5 | `apps/mobile/src/features/settings/SettingsRouteScreen.tsx:595`    | UI          | LOW      | fix now     | The fixed accessibility label hides the visible status and does not expose busy/disabled state.                    |

## Validated non-findings

- `Ref.getAndSet` is atomic and the stream/debounce pull boundary retains later publications for the
  next batch; no accumulation-to-drain loss or double processing was found.
- `Stream.fromPubSub` performs a fresh `PubSub.subscribe` for every stream execution, so mounted
  per-environment engines receive independent broadcast subscriptions and do not starve each other.
- PubSub does not replay publications from before subscription. The root coordinator mounts engine
  streams before its passive settle effect and remains mounted, so the remaining startup window is
  bounded and acceptable for this best-effort feature.
- The runtime layer retains the background activity observer/reporter, runtime context, platform,
  connection, and snapshot loader services after adding the shared trigger service.
- Settle snapshot remount reseeding, command identity, hook dependencies, aggregate-list diff cost,
  and README coverage are appropriate for the stated scope.

## Deferred candidates

None.

## Resolution

- Restored Hermes-compatible keyboard handler reversal.
- Separated lifecycle cooldown consumption from manual full-run scope and added batching/cooldown
  regressions.
- Replaced cross-clock/maximum-timestamp manual completion inference with per-environment completion
  cursors captured at request time.
- Added a minute clock and accessible busy/status metadata to the Settings row.
- Verification passed: focused 31-test client-runtime run, `vp check`, `vp run typecheck`, and
  `vp run lint:mobile`.
