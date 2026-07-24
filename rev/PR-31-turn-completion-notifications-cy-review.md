# PR #31 cy-review — round 1

## Target

- PR: https://github.com/pandec/t3code/pull/31
- Branch: `t3code/turn-completion-notifications`
- Base: `dev`
- Diff: `origin/dev...HEAD`
- Reviewed head: `5a0310bf07ffd3669e55c0d7d1612aff88fa4cd8`
- Date: 2026-07-24
- Round: 1

## Fleet

Four reviewers were selected because the change is stateful, asynchronous, cross-module, and
contract-changing.

| Reviewer                      | Primary responsibility                                                          |
| ----------------------------- | ------------------------------------------------------------------------------- |
| Skeptical state reviewer      | Snapshot-diff correctness, bootstrap behavior, StrictMode, toggle reruns        |
| Electron lifecycle reviewer   | Native notification lifetime, click routing, Effect callback lifetime           |
| Browser/contracts reviewer    | Permission degradation, settings schemas, desktop persistence, focused coverage |
| Adversarial solution reviewer | Ownership, lifecycle boundaries, and simpler or more robust alternatives        |

All reviewers inspected the full diff. The executing agent independently verified every retained
candidate against the surrounding implementation.

## Summary

- Raw reviewer findings: 12
- Additional executor finding: 1
- Unique kept findings: 8
- Fix now: 8
- Deferred: 0
- Discarded: 1

## Combined findings

| ID  | File:line                                                    | Sources          | Severity | Disposition | Rationale                                                                                                                                                                           |
| --- | ------------------------------------------------------------ | ---------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `apps/web/src/notifications/turnCompletion.tsx:135`          | SC-1, AR-1       | HIGH     | fix now     | The existing bootstrap atom accepts cached snapshots, so cached running state replaced by an authoritative completed snapshot can be misreported as a live completion.              |
| C2  | `apps/desktop/src/ipc/methods/notifications.ts:28`           | EL-1             | HIGH     | fix now     | A handler-local Electron `Notification` becomes GC-eligible after the IPC call, which can remove the notification or its instance click handler.                                    |
| C3  | `apps/desktop/src/ipc/methods/notifications.ts:34`           | EL-2, AR-2       | MEDIUM   | fix now     | On macOS the app can remain alive with no window; the click path neither recreates a main window nor waits for its renderer listener before sending.                                |
| C4  | `apps/desktop/src/ipc/methods/notifications.ts:34`           | EL-3, AR-2       | MEDIUM   | fix now     | The ignored `runPromise` can reject on window races, producing an unhandled rejection and suppressing navigation.                                                                   |
| C5  | `apps/web/src/notifications/turnCompletion.logic.ts:11`      | SC-2, BC-1, AR-3 | MEDIUM   | fix now     | A literal NUL byte makes ordinary TypeScript source appear binary to Git and text tooling.                                                                                          |
| C6  | `apps/web/src/notifications/turnCompletion.tsx:18`           | BC-2             | LOW      | fix now     | Unsupported/denied browser permission and desktop bridge failure paths have no focused coverage; the undefined-API guard should be explicit.                                        |
| C7  | `apps/desktop/src/settings/DesktopClientSettings.test.ts:21` | BC-3             | LOW      | fix now     | Persisting both new settings as their false defaults cannot prove enabled values survive the desktop round trip.                                                                    |
| C8  | `apps/web/src/notifications/turnCompletion.logic.ts:35`      | executor         | MEDIUM   | fix now     | Comparing only adjacent snapshots permits the same `turnId` to fire again after an intermediate non-completed state, contrary to the accepted turnId-only lifetime dedupe contract. |

## Deferred candidates

None. Each retained issue has a focused fix that fits the private-fork policy.

## Discarded summary

- One product-boundary challenge proposed notifying on errored turns. The implementation and tests
  deliberately define completion as the successful `completed` state, so this was not treated as a
  defect in the requested feature.

## Reviewer-output audit notes

- The cached-snapshot issue was independently reported by the skeptical and adversarial reviewers
  and verified against the shell state's `cached` → `synchronizing` → `live` lifecycle.
- The Electron GC issue was verified against Electron 41.5 behavior and documentation.
- `ElectronWindow.sendAll` currently broadcasts to all live windows; the fix will preserve the
  established channel path while ensuring the main renderer exists and is ready.

## Resolution

All eight retained findings were fixed in round 1.

- Notification baselines now reset whenever any environment leaves authoritative shell state, then
  reseed after synchronization, preventing cache/reconnect replay from firing.
- Lifetime turnId tracking suppresses same-turn re-completion while still allowing later turn IDs.
- Electron notifications are retained in a bounded set, native click work is cause-contained, and a
  missing/loading main window is recreated and allowed to load before delivery.
- The preload bridge buffers clicks until the React coordinator subscribes.
- Browser API absence, permission results, bridge rejection, native click ordering, settings
  persistence, and contract defaults now have focused coverage.
- The raw NUL was removed by reusing the canonical client-runtime thread key helper.

Verification:

- Focused tests: 6 files, 58 tests passed.
- `vp check`: passed (existing unrelated warnings only).
- `vp run typecheck`: passed.
- `pnpm typecheck`: passed.
