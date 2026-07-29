# PR 68 cy-review — Extras settings

- Target: PR #68, `t3code/extras-settings-section` / local `worktree-extras-settings`
- Base: `origin/dev` at `27a50aa6c7a8bc2b460fa5f3db34357db2c17e69`
- Reviewed head: `c47fb163893f12e362a9ae81b32d4789ffd6efe4`
- PR: https://github.com/pandec/t3code/pull/68
- Date: 2026-07-29
- Round: 1
- Diff: `origin/dev...HEAD`

## Review fleet

| Reviewer            | Primary responsibility                                             | Why selected                                                                                 |
| ------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Skeptical contracts | Broad correctness, eight-key patch parity, restore symmetry, tests | The change crosses client/server settings schemas and persistence boundaries.                |
| Adversarial design  | Challenge ownership, duplication, and restore/config boundaries    | The implementation adds several hand-maintained registries and derived settings paths.       |
| Async/derived state | Steer timers, threshold re-evaluation, completion duration         | These paths are stateful and can fail through hydration or stale-snapshot races.             |
| Speech/settings     | TTS setting/env/default resolution and cache identity              | Speech configuration crosses server settings, environment config, and persisted cache state. |

All reviewers ran read-only with GPT-5.6 Sol at medium reasoning effort. The accepted trade-offs supplied by the developer were treated as constraints and were not re-litigated.

## Summary

- Raw findings: 9
- Unique kept findings: 6
- Fix now: 6
- Deferred: 0
- Discarded/merged: 3 duplicate reports

The eight new keys are present in their full settings/defaults and corresponding patch schemas. The restore hook covers all eight new keys. No stale-snapshot or double-clamping defect was found in `ContextWindowMeter` or `providerUsageAlerts`; both re-evaluate from provider-reported severity floors. Mid-wait grace changes after hydration reschedule correctly.

## Combined findings

| ID   | File:line                                                      | Source roles                            | Severity | Disposition | Rationale                                                                                                                                                                  |
| ---- | -------------------------------------------------------------- | --------------------------------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR-1 | `apps/web/src/state/use-thread-outbox-drain.ts:225`            | Async/derived state                     | MEDIUM   | fix now     | Restored outbox rows can load before persisted client settings. A longer saved grace can therefore be evaluated against the default 5 seconds and sent irreversibly early. |
| CR-2 | `apps/web/src/notifications/turnCompletion.logic.ts:77`        | Async/derived state                     | MEDIUM   | fix now     | Equal or reversed timestamps are coerced to zero even though they represent an unknown duration, allowing a positive threshold to suppress a completion on a guess.        |
| CR-3 | `apps/web/src/components/settings/SettingsPanels.tsx:442`      | Skeptical contracts, adversarial design | MEDIUM   | fix now     | Global restore omits the moved `sidebarV2CompactCards` Extras setting from both dirty labels and the reset patch.                                                          |
| CR-4 | `apps/web/src/components/settings/ExtrasSettingsPanel.tsx:295` | Skeptical contracts, adversarial design | MEDIUM   | fix now     | Warning reset bypasses the invariant-preserving threshold helper, so displayed/persisted values can disagree with effective clamped values.                                |
| CR-5 | `apps/server/src/voice/MessageSpeech.ts:161`                   | Speech/settings                         | MEDIUM   | fix now     | Present-but-empty environment values bypass the built-in TTS fallback, despite the documented setting → environment → default resolution order.                            |
| CR-6 | `README.md:21`                                                 | Skeptical contracts, adversarial design | LOW      | fix now     | The material fork feature is undocumented and several existing bullets still describe behavior as fixed rather than configurable.                                          |

## Deferred candidates

None.

## Resolution and verification

All six kept findings were fixed in round 1. Focused verification passed 203 tests across eight files, followed by the formatted speech test (6 tests), `vp check`, and `vp run typecheck`. The repository-wide check reported only 11 pre-existing warnings outside this pass and no errors.

## Discarded summary

Three raw reports duplicated CR-3, CR-4, and CR-6 and were merged into the combined findings above. Reviewers found no additional valid issue in the accepted route-tree edit, placeholder duplication, global reset placement, mobile defaults, provider-reported severity floors, threshold re-evaluation, post-hydration grace rescheduling, restore coverage for the eight new keys, voice partial-patch merging, or speech cache identity.
