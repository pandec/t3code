# PR 73 cy-review

- Target: `worktree-mobile-extras` / `t3code/mobile-extras-settings`
- Base: `origin/dev`
- PR: https://github.com/pandec/t3code/pull/73
- Date: 2026-07-30
- Diff base: `0ce7d8b2d7ac1939fe4427ac77c88c39c12366d8`
- Reviewed head: `3fa936495`
- Round: 1
- Frozen diff: `/tmp/t3-pr73-cy-review-round1.diff`

## Fleet

Four Sol-medium reviewers were selected because the diff adds stateful persistence, async dispatch
gating, and cross-screen mobile UI behavior.

| Reviewer              | Primary responsibility                                                          |
| --------------------- | ------------------------------------------------------------------------------- |
| Skeptical correctness | Broad correctness, regressions, failure paths, and test coverage                |
| Adversarial solution  | Challenge cache ownership and solution complexity against existing abstractions |
| Cache and concurrency | Model hydration, pruning, debounced writes, preference holds, and clamping      |
| Mobile UI regression  | Audit every tint paint site, slider reuse, accessibility, and Android fallbacks |

## Summary

- Raw findings: 7
- Kept after deduplication and source verification: 4
- Fix now: 3
- Deferred candidates: 1
- Discarded: 0

## Combined findings

| ID   | File:line                                                                | Source roles                              | Severity | Disposition | Rationale                                                                                                                                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------ | ----------------------------------------- | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR-1 | `apps/mobile/src/state/project-accent-color-cache.ts:120`                | Skeptical, adversarial, cache/concurrency | MEDIUM   | fix now     | A live update during storage hydration can leave a partial pending write that later erases disconnected environments. Hydration also bypasses a catalog that already became ready. The separate cache duplicates the established persisted `ServerConfig` cache, whose lifecycle already retains disconnected environments and clears removed ones. |
| CR-2 | `apps/mobile/src/state/use-thread-outbox-drain.ts:173`                   | Cache/concurrency                         | MEDIUM   | fix now     | An indefinitely pending preference load keeps every steer held and prevents the grace timer from being armed, blocking that thread's FIFO for the app lifetime.                                                                                                                                                                                     |
| CR-3 | `apps/mobile/src/features/settings/components/SettingsSliderRow.tsx:140` | Mobile UI regression                      | LOW      | fix now     | Disabled sliders reject gestures but still expose and execute accessibility increment/decrement actions, allowing writes before hydration or while tint intensity is disabled.                                                                                                                                                                      |
| CR-4 | `apps/mobile/src/state/use-project-accent-colors.ts:86`                  | Skeptical correctness                     | MEDIUM   | defer       | Cache hydration is not an explicit splash-screen readiness dependency, so a slow cache read can theoretically allow one colorless visible frame before cached accents arrive. Reusing the existing server-config cache removes the duplicate lifecycle but does not expose a simple per-environment cache-ready signal.                             |

## Deferred candidates

| ID   | Reason to defer                                                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CR-4 | Correctly gating the splash requires a reliable catalog-plus-server-config readiness contract, including the valid no-cache case. That is broader startup-state work and should not be approximated with a second storage cache or an unbounded splash wait. |

## Discarded summary

No standalone finding was discarded. Four raw cache findings were merged into CR-1 because they
shared one ownership and hydration-ordering cause.

## Resolution

- CR-1 fixed: removed the duplicate SecureStore accent cache and reused the existing
  schema-validated per-environment `ServerConfig` SQLite cache. Disconnected catalog environments
  now render their cached config, while registry removal remains the authoritative prune.
- CR-2 fixed: preference hydration now times out after five seconds and resolves to defaults, so
  only steer intent waits during hydration and a stuck storage call cannot deadlock the outbox.
- CR-3 fixed: disabled slider rows expose a disabled accessibility state, publish no adjustment
  actions, and guard the action handler.
- CR-4 deferred: startup readiness still lacks a trustworthy signal for “all known server-config
  cache reads have settled, including valid cache misses.”

## Verification

- `vp test run apps/mobile/src/state/use-project-accent-colors.test.ts apps/mobile/src/state/preferences.test.ts apps/mobile/src/features/settings/lib/extras-settings.test.ts apps/mobile/src/lib/accentTint.test.ts apps/mobile/src/state/thread-outbox.test.ts packages/client-runtime/src/state/threadOutboxSteerGrace.test.ts` — 67 tests passed.
- `vp check` — passed; 12 existing warnings, no errors.
- `vp run typecheck` — passed.
- `vp run lint:mobile` — passed; SwiftLint, ktlint, and detekt are not installed, so the gate reported its standard skip warnings.
