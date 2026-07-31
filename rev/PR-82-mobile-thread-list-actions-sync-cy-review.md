# PR 82 cy-review: mobile thread list actions and sync status

- Branch: `t3code/mobile-thread-list-actions-sync`
- Base: `origin/dev` at `ac010473afa3140198b8a8d01419ff1faaeb6261`
- Reviewed head: `45f32a3991c5a951ca8ff2de5bf4bc300fe3cb20`
- PR: https://github.com/pandec/t3code/pull/82
- Date: 2026-07-31
- Round: 1
- Diff: scoped `origin/dev...HEAD`

## Fleet

Four reviewers were used because the diff changes stateful Effect Stream behavior and its native UI
consumers.

- Skeptical code reviewer: broad correctness, regressions, failure paths, and test coverage.
- Adversarial solution reviewer: stream/API boundaries, state ownership, and simpler alternatives.
- Effect Stream specialist: interruption, event pairing, batching, and cooldown semantics.
- Mobile/UI reviewer: native-header invalidation, hook timing, accessibility, layout, and reuse.

All reviewers ran with GPT-5.6 Sol at medium reasoning effort. The adversarial reviewer used the
dedicated adversarial role.

## Summary

- Raw findings: 7
- Deduplicated kept findings: 2
- Fix now: 2
- Deferred: 0
- Discarded candidate groups: 2

## Combined findings

| ID   | File:line                                                | Source roles | Severity | Disposition | Rationale                                                                                                                                                                                                |
| ---- | -------------------------------------------------------- | ------------ | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CY-1 | `apps/mobile/src/features/home/HomeHeader.tsx:413`       | SK, ADV, UI  | MEDIUM   | fix now     | `headerTitle` closes over `syncingThreads`, but the stabilized native header options omit it from `optionsVersion`; the spinner and busy accessibility state can remain invisible or stale.              |
| CY-2 | `packages/client-runtime/src/state/threadPrewarm.ts:423` | EFF, ADV     | MEDIUM   | fix now     | A registry/supervisor replacement can interrupt after `running: true`; the replacement stream emits no settled baseline until another eligible run, so the atom can retain `syncing: true` indefinitely. |

## Validated stream behavior

- Default `Stream.flatMap` concurrency is sequential, so overlapping triggers do not interleave
  running/settled pairs.
- Cooldown eligibility and consumption match `origin/dev`: only a successful lifecycle-eligible
  full run advances `lastFullRunAt`; manual and targeted runs do not suppress the next lifecycle
  sweep.
- Cooldown-suppressed batches and batches without a prepared connection emit no run events.
- Timeout, no cached shell, typed failure, and defects settle to the previous completed status
  without claiming a newer `lastRunAt`.

## Deferred candidates

None.

## Discarded summary

- The existing manual-sync request cursor intentionally waits for a successful per-environment
  completion timestamp and falls back after 45 seconds when a run cannot complete. Replacing that
  established success contract with a second completion-generation API is broader than this
  indicator change and is not a regression in the reviewed diff.
- Holding the Settings background indicator for a cosmetic minimum duration would make its
  disabled/busy state outlast the actual work. The minimum-visible treatment remains specific to
  the compact home-header affordance where a sub-frame spinner would otherwise be unreadable.

## Resolution

- Added `syncingThreads` to the native header's explicit options version.
- Made every environment prewarm stream execution establish a settled baseline before processing
  triggers, with a focused regression test.
- Verification passed: 19 focused thread-prewarm tests; client-runtime, mobile, and web package
  typechecks; mobile native lint; scoped Oxfmt/Oxlint; and `git diff --check`.
