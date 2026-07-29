# cy-review pass 1 — mobile thread accent colors

## Target

- Branch: `t3code/fix-mobile-thread-accent-color`
- Base: `origin/dev`
- Diff: `git diff origin/dev...HEAD`
- Reviewed head: `cb3ba18b15896b75d9784ef3e0335468d5ccb836`
- Diff base: `ef913b4634d997bb8f7704aa75491adacdfaf1bb`
- Date: `2026-07-29`
- Round: 1
- PR: none

## Review fleet

Four Sol-medium reviewers were used because the change is stateful, async,
cross-client, and contract-changing.

| Reviewer                                     | Primary responsibility                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| Skeptical Code Reviewer                      | Broad correctness, regressions, tests, version skew, and settings lifecycle |
| Adversarial Solution Reviewer                | Challenge precedence and API boundaries against the shared-color contract   |
| Migration and Concurrency Specialist         | Migration ordering, retries, partial connectivity, and overlapping writes   |
| Client Integration and Efficiency Specialist | Sidebar rewiring, mobile recyclers/tint cost, and Settings integration      |

## Summary

- Raw findings: 13
- Kept underlying findings: 6
- Fix now: 6
- Deferred: 0
- Discarded/deduplicated: 7

## Combined findings

| ID    | File:line                                                          | Source roles                               | Severity | Disposition | Rationale                                                                                                                           |
| ----- | ------------------------------------------------------------------ | ------------------------------------------ | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| ACC-1 | `packages/client-runtime/src/state/projectAccentColors.ts:76`      | Skeptical, Adversarial                     | HIGH     | fix_now     | Primary/preferred environment precedence makes identical replicas resolve differently on web clients and mobile.                    |
| ACC-2 | `apps/web/src/hooks/useProjectAccentColors.ts:122`                 | All reviewers                              | HIGH     | fix_now     | Migration removes legacy entries before RPC acknowledgement; old servers silently strip the unknown patch key.                      |
| ACC-3 | `apps/web/src/hooks/useProjectAccentColors.ts:44`                  | Migration, Client Integration              | MEDIUM   | fix_now     | Cached configs remain in the aggregate map while disconnected, so they are incorrectly treated as writable targets.                 |
| ACC-4 | `apps/web/src/hooks/useProjectAccentColors.ts:74`                  | Migration                                  | MEDIUM   | fix_now     | Whole-map payloads built from stale render snapshots can clobber rapid or overlapping edits despite RPC serialization.              |
| ACC-5 | `apps/web/src/components/settings/SettingsPanels.tsx:434`          | Skeptical, Adversarial, Client Integration | MEDIUM   | fix_now     | Restore Defaults observes and clears only the primary server although reads merge all connected server maps.                        |
| ACC-6 | `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx:779` | Client Integration                         | MEDIUM   | fix_now     | Accent maps are absent from the iPad recycler callback dependencies and extra data, leaving rows stale after settings-only updates. |

## Deferred candidates

None.

## Validated outcomes

- ACC-1 fixed with client-invariant environment/key ordering and conflict tests
  that remain stable across map insertion order.
- ACC-2 and ACC-3 fixed with an optional server capability, connected-only
  environment maps, acknowledged per-environment migration consumption, and
  retention of unsupported/failed legacy entries.
- ACC-4 fixed with a per-environment write queue that builds each whole-map
  payload from the prior acknowledged server response.
- ACC-5 fixed by routing Restore Defaults through connected environment fan-out
  and clearing the remaining legacy client map.
- ACC-6 fixed by adding both accent maps to the iPad list callback dependencies
  and recycler extra data.

Verification: 179 focused tests passed across seven files; `vp run typecheck`,
`vp check`, and `vp run lint:mobile` passed. The mobile lint rerun used the
installed Temurin 21 JDK because the inherited `JAVA_HOME` pointed at a removed
JDK 17 installation.

## Discarded summary

Seven reports were duplicates of the six findings above. No material defect was
found in tint alpha math, O(1) per-row lookup, canonical-key/worktree sharing,
whole-map replacement itself, disconnected-environment policy, package exports,
or the pure migration planner's no-overwrite rule.

## Raw-output audit notes

- The resolver test currently proves the client-dependent result by expecting a
  different fallback after changing `primaryEnvironmentId`.
- Effect Struct decoding ignores unknown fields, so an old server can accept a
  new-client accent patch as an empty patch; RPC success alone is insufficient
  without an advertised capability or returned-state verification.
- `environmentServerConfigsAtom` deliberately retains cached configs and is not
  a connected-environment set.
