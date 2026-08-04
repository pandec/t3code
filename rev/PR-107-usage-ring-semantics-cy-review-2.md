# PR #107 cy-review — usage ring semantics, round 2

## Target

- Branch: `t3code/usage-ring-semantics`
- Base: `origin/dev` at `40dc0f77e06aba163be04e5ecaa8bc11f5d0c5de`
- Reviewed head: `d1c473c671596e34b386f4fc6f434cd0d94b3a14`
- Diff: `git diff origin/dev...HEAD`
- PR: https://github.com/pandec/t3code/pull/107
- Date: 2026-08-04
- Round: 2

## Review fleet

Four Sol-medium reviewers were used because the first review added stateful concurrency controls to an already cross-client, security-sensitive change.

- Concurrency correctness: verify semaphore fairness, timeout boundaries, cancellation, and per-origin auth budgets.
- Skeptical completeness: re-check the nine acceptance items and web/mobile wiring for half-finished paths.
- Adversarial design: challenge the whole-probe serialization and look for a smaller, safer admission model.
- Failure-path tests: inspect teardown, interruption, timeout, and whether the tests actually exercise the new boundaries.

## Summary

- Raw findings: 9
- Unique findings after deduplication: 7
- Kept: 5
- Fix now: 5
- Deferred: 0 new items
- Discarded: 2

## Combined findings

| ID       | File:line                                                  | Source                                  | Severity | Disposition | Rationale                                                                                                                                                                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------- | --------------------------------------- | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CONC-1   | `apps/server/src/provider/cliProxyApiUsage.ts:609`         | Concurrency, adversarial, failure tests | HIGH     | fix now     | A same-origin probe waits while holding one of the coordinator's three global permits, so stalled gateway work can convoy unrelated origins. Whole-probe serialization also admits concurrent account requests as one strike unit rather than reserving the actual request budget. Replace it with atomic per-origin request admission and release. |
| SEC-1    | `apps/server/src/provider/cliProxyApiUsage.ts:95`          | Concurrency                             | MEDIUM   | fix now     | Catalog rejection suppression remembers only the latest key for an origin. Alternating two rejected keys continually evicts the other and can spend gateway strikes indefinitely. Track suppression by origin and key.                                                                                                                              |
| CONC-2   | `apps/server/src/provider/cliProxyApiUsage.ts:425`         | Concurrency                             | MEDIUM   | fix now     | The five-second catalog timeout includes time waiting for the origin lock, so same-origin waiters can time out without running, and successful concurrent reads are repeated. Use per-key single-flight state, keep the network timeout inside the owner section, and share the completed result with current waiters.                              |
| MOBILE-1 | `apps/mobile/src/features/threads/ThreadComposer.tsx:1267` | Skeptical                               | MEDIUM   | fix now     | The mobile pill label uses the primary session/weekly window, but its dot still uses aggregate status. A critical Fable-only window can therefore color the primary indicator red. Derive both pieces from the same primary window.                                                                                                                 |
| TEST-1   | `apps/server/src/provider/Layers/CodexAdapter.test.ts:299` | Failure tests                           | LOW      | fix now     | The standalone-runtime interruption test assumes one scheduler yield reaches the read and installs the finalizer. Add an explicit Deferred handshake before interrupting so the test deterministically verifies read interruption and teardown.                                                                                                     |

## Deferred candidates

No new items deferred this round. The round-one context-capability metadata item remains valid in the combined deferred log.

## Discarded summary

- A fresh Codex thread with genuinely unknown model capacity was reported as missing a zero-token context ring. Returning no ring in that case is the explicit acceptance requirement; fabricating a capacity would be incorrect.
- A proposed full Codex app-server handshake test was discarded as disproportionate to this change. The production runtime directly sequences cached `initialize`, `initialized`, and `account/rateLimits/read`; the adapter tests cover standalone lifecycle, while the app-server package already covers typed initialize and rate-limit RPC behavior. Building another process-transport harness here would test substantial unrelated machinery without exposing a concrete defect.

## Resolution and verification

- Replaced the whole-probe same-origin semaphore with atomic per-request strike reservations. Admission is fail-fast when the remaining budget is already reserved, successful/failed/timed-out/interrupted requests always release through scoped acquire/use/release, and an observed rejection is recorded uninterruptibly before release.
- Replaced the single latest rejected client key with per-origin/per-key catalog state. Concurrent same-key readers share an owner's result, the five-second network timeout begins after ownership, corrected keys do not wait behind rejected keys, and alternating rejected keys stay suppressed.
- Made the mobile compact dot use the same primary session/weekly window as its label, so a Fable-only critical state no longer takes over the primary indicator.
- Added a deterministic read-start handshake to the Codex standalone interruption test.
- Added focused tests for alternating rejected client keys, successful catalog single-flight, healthy same-origin overlap, fail-fast strike admission, timeout reservation release, and deterministic runtime interruption.
- `env -u CLAUDE_CONFIG_DIR vp test run ...`: 8 affected/focused files, 161 tests passed.
- `env -u CLAUDE_CONFIG_DIR vp run --filter t3 test`: 240 files passed, 2 skipped; 2,340 tests passed, 7 skipped.
- `pnpm fmt`: passed.
- `pnpm typecheck`: passed (pre-existing suggestions only).
- `pnpm lint`: passed (pre-existing warnings only, outside the reviewed diff).
