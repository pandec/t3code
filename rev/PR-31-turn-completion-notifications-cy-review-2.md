# PR #31 cy-review — round 2

## Target

- PR: https://github.com/pandec/t3code/pull/31
- Branch: `t3code/turn-completion-notifications`
- Base: `dev`
- Diff: `origin/dev...HEAD`
- Reviewed head: `6e02fc1db985fa0814f16d3260bcb7fcc74d0cff`
- Date: 2026-07-24
- Round: 2

## Fleet

Four reviewers re-read the full current diff, with round 2 deliberately split across the remaining
state, platform, and boundary risks.

| Reviewer                      | Primary responsibility                                                           |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Skeptical state reviewer      | Multi-environment synchronization, hosted-static mounting, lifetime state        |
| Electron lifecycle reviewer   | Native close/show events, retention, click routing, Effect callback lifetime     |
| Browser/contracts reviewer    | Permission flow, foreground behavior, schemas, desktop round trip, focused tests |
| Adversarial solution reviewer | Cross-environment coupling and the main-window click delivery boundary           |

The executing agent independently verified every retained candidate against the surrounding
implementation and Electron 41.5 types/documentation.

## Summary

- Raw reviewer findings: 9
- Additional executor findings: 2
- Unique kept findings: 8
- Fix now: 8
- Deferred: 0
- Discarded: 2

## Combined findings

| ID  | File:line                                           | Sources     | Severity | Disposition | Rationale                                                                                                                                                       |
| --- | --------------------------------------------------- | ----------- | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `apps/web/src/routes/__root.tsx:140`                | R2S-1       | HIGH     | fix now     | Hosted-static enters the full app shell but the coordinator is mounted only for the primary authenticated route, making both notification settings inert there. |
| C2  | `apps/web/src/notifications/turnCompletion.tsx:139` | R2S-2,R2A-1 | MEDIUM   | fix now     | One environment synchronizing clears the aggregate baseline, suppressing genuine completions from every otherwise healthy environment.                          |
| C3  | `apps/desktop/src/ipc/methods/notifications.ts:18`  | R2E-1       | MEDIUM   | fix now     | Windows can emit `close` on timeout while retaining an actionable Action Center entry; dropping the strong reference then loses its click listener.             |
| C4  | `apps/desktop/src/ipc/methods/notifications.ts:106` | R2E-2       | MEDIUM   | fix now     | The IPC result reports success as soon as `show()` returns, even though Electron reports native creation/show failures asynchronously.                          |
| C5  | `apps/desktop/src/ipc/methods/notifications.ts:93`  | R2A-2       | MEDIUM   | fix now     | Broadcasting through `sendAll` lets an unrelated window race prevent delivery to the exact validated main renderer obtained for the click.                      |
| C6  | `apps/web/src/notifications/turnCompletion.tsx:168` | R2B-2       | LOW      | fix now     | The core foreground decision has no focused coverage, so an inversion could produce intrusive OS notifications while the app is active.                         |
| C7  | `apps/web/src/notifications/turnCompletion.tsx:139` | executor    | MEDIUM   | fix now     | Clearing the snapshot during synchronization also clears lifetime turn-ID history, allowing the same turn to notify again after a later re-completion.          |
| C8  | `apps/web/src/state/shell.ts:40`                    | executor    | MEDIUM   | fix now     | A stale `live` shell is accepted even when the connection has already entered synchronization, leaving a race where replayed state can be treated as live.      |

## Deferred candidates

None. Each retained issue has a focused fix that fits the private-fork policy.

## Discarded summary

- The async browser permission callback could theoretically race an external settings restore, but
  the switch remains off while permission is pending and no later in-panel off intent can be
  expressed. Adding cross-store request invalidation for this narrow hypothetical was not justified.
- Lifetime turn-ID history is necessarily unbounded if the accepted contract is that a turn ID never
  re-fires for the coordinator lifetime. A bounded eviction policy would re-litigate that explicit
  trade-off, so it was not treated as a defect.

## Resolution

All eight retained findings were fixed in round 2.

- The coordinator now mounts in authenticated and hosted-static full-shell modes.
- One global lifetime turn-ID history is preserved while comparison shells are filtered by
  independently authoritative environments. Reconnecting environments therefore reseed silently
  without suppressing healthy environments.
- A `live` shell is accepted only when its connection projection is also ready.
- Timed-out native notifications remain retained for Action Center clicks, cap evictions are
  explicitly dismissed, IPC success follows Electron's `show`/`failed` result, and clicks are sent
  directly to the validated main renderer.
- Focused regressions cover multi-environment reconnects, dedupe across baseline removal, the
  foreground decision, native show failures, and native retention behavior.

Verification:

- Focused tests: 6 files, 65 tests passed.
- `vp check`: passed (existing unrelated warnings only).
- `vp run typecheck`: passed.
- `pnpm typecheck`: passed (with the repository's Node engine warning).
