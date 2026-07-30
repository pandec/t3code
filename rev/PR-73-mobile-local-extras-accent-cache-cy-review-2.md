# PR 73 cy-review round 2

- Target: `worktree-mobile-extras` / `t3code/mobile-extras-settings`
- Base: `origin/dev`
- PR: https://github.com/pandec/t3code/pull/73
- Date: 2026-07-30
- Diff base: `0ce7d8b2d7ac1939fe4427ac77c88c39c12366d8`
- Reviewed head: `f37606b15`
- Round: 2
- Frozen diff: `/tmp/t3-pr73-cy-review-round2.diff`
- Frozen diff SHA-256: `b9a3f3bb57517de5cf81e1581594dc1bac5d766209c220ff74cad41fa76ae036`

## Fleet

Four Sol-medium reviewers were selected because this final pass needed to compose the
`ServerConfig`-cache rework with registry teardown, preference persistence, outbox dispatch, and
all mobile paint sites.

| Reviewer               | Primary responsibility                                                          |
| ---------------------- | ------------------------------------------------------------------------------- |
| Skeptical integration  | Broad end-to-end composition and regression audit                               |
| Adversarial design     | Challenge cache ownership, subscriptions, and preference timeout scope          |
| ServerConfig lifecycle | Model cached/live precedence, teardown, pruning, and persistence races          |
| Outbox/UI/tests        | Audit steer gating, preference writes, tint sites, sliders, icons, and coverage |

## Summary

- Raw findings: 5
- Kept after deduplication and source verification: 4
- Fix now: 4
- Deferred candidates: 1 previously accepted item
- Discarded: 1

## Combined findings

| ID   | File:line                                               | Severity | Disposition | Rationale                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-1 | `packages/client-runtime/src/state/server.ts:149`       | MEDIUM   | fix now     | Registry removal closes a supervisor-owned scope, but the atom-runtime config stream can finalize later. Its pending/debounced save can therefore run after `cache.clear` and recreate a removed environment's cached config. Cache mutations need an environment lock, and stale streams must verify the exact catalog entry before saving. |
| R2-2 | `apps/mobile/src/state/use-project-accent-colors.ts:32` | LOW      | fix now     | Accent derivation subscribes to connection presentations even though it only needs configs. Connection phase changes recreate presentations and invalidate Home/sidebar accent callbacks. The existing catalog-filtered `environmentServerConfigsAtom` already preserves map identity until config references change.                        |
| R2-3 | `apps/mobile/src/state/use-thread-outbox-drain.ts:264`  | MEDIUM   | fix now     | The preference-hydration hold precedes the existing expedited check, so an explicit “Send now” steer can remain blocked for five seconds. Expedited intent makes the saved grace preference irrelevant and should bypass the hydration hold.                                                                                                 |
| R2-4 | `apps/mobile/src/persistence/mobile-preferences.ts:310` | MEDIUM   | fix now     | The initial preference read times out, but `savePatch` performs another unbounded read under the same semaphore. A stuck read can monopolize the lock, leave optimistic values unconfirmed, and block all later preference writes. Bound update transactions and fail them as save errors so the lock and optimistic version are released.   |
| CR-4 | `apps/mobile/src/state/use-project-accent-colors.ts`    | MEDIUM   | defer       | The splash coordinator still has no reliable signal that every catalog environment's cached config read has settled, so a sufficiently slow cold-cache read can theoretically yield one colorless frame.                                                                                                                                     |

## Discarded

| Finding                                                                                   | Reason                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Move the five-second deadline out of shared preference hydration and into the outbox hook | A hook-only deadline would release steering while the underlying store load continued to own the preference semaphore forever. The shared timeout is what interrupts that storage attempt and permits later writes. Preserving a late result would require a retryable hydration/merge protocol, which is broader than this branch; bounding update transactions addresses the remaining deadlock without widening the state model. |

## Resolution

- R2-1 fixed: coordinated `saveServerConfig` and registry `clear` through one internal per-cache,
  per-environment lock. A config stream captures its exact catalog entry and skips a save after
  removal or same-ID replacement.
- R2-2 fixed: project accents now derive directly from `environmentServerConfigsAtom`; the focused
  helper and test now describe configs rather than presentations.
- R2-3 fixed: expedited steers bypass preference hydration, while ordinary steers remain held until
  hydration succeeds or fails open.
- R2-4 fixed: preference update transactions use the same five-second bound, mapping timeout to
  `MobilePreferencesSaveError` so optimistic state rolls back and the semaphore becomes reusable.
- CR-4 remains deferred unless an integrated cold-start trace demonstrates a visible flash.

## Verification

- `vp test run apps/mobile/src/persistence/mobile-preferences.test.ts apps/mobile/src/state/use-project-accent-colors.test.ts apps/mobile/src/state/preferences.test.ts apps/mobile/src/features/settings/lib/extras-settings.test.ts apps/mobile/src/lib/accentTint.test.ts apps/mobile/src/state/thread-outbox.test.ts packages/client-runtime/src/state/threadOutboxSteerGrace.test.ts packages/client-runtime/src/platform/environmentCacheMutationLock.test.ts packages/client-runtime/src/state/server.test.ts packages/client-runtime/src/state/shell.test.ts` — 78 tests passed.
- `vp check` — passed; 12 existing warnings, no errors.
- `vp run typecheck` — passed.
- `vp run lint:mobile` — passed; SwiftLint, ktlint, and detekt are not installed, so the gate reported its standard skip warnings.
