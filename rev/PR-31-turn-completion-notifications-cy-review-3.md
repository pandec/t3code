# PR #31 cy-review — round 3

## Target

- PR: https://github.com/pandec/t3code/pull/31
- Branch: `t3code/turn-completion-notifications`
- Base: `dev`
- Diff: `origin/dev...HEAD`
- Reviewed head: `b421a9731acddb460b97707b9f755988aa32ce1e`
- Date: 2026-07-24
- Round: 3

## Fleet

This terminal pass used four narrowly targeted reviewers because the round-2 fixes changed three
independent asynchronous lifecycle boundaries.

| Reviewer                      | Primary responsibility                                                      |
| ----------------------------- | --------------------------------------------------------------------------- |
| Multi-environment reviewer    | Authority filtering, bootstrap changes, lifetime dedupe, concurrent updates |
| Electron lifecycle reviewer   | Native show/fail/close/click events, retention, Effect callback lifetime    |
| Hosted-static reviewer        | Root mounting, connect routes, settings hydration, saved environments       |
| Adversarial solution reviewer | Boundary ownership and failure modes introduced by the round-2 fixes        |

All reviewers inspected the current full PR diff and the isolated round-2 fix commit. The executing
agent independently verified each candidate against the surrounding implementation.

## Summary

- Raw reviewer findings: 7
- Unique kept findings: 5
- Fix now: 5
- Deferred: 0
- Discarded: 0

## Combined findings

| ID  | File:line                                                | Sources           | Severity | Disposition | Rationale                                                                                                                                                             |
| --- | -------------------------------------------------------- | ----------------- | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `apps/web/src/notifications/turnCompletion.tsx:153`      | R3M-1,R3H-1,R3A-1 | MEDIUM   | fix now     | The per-environment filter is still preceded by a global bootstrap gate, so adding one environment clears every healthy environment's baseline and loses completions. |
| C2  | `apps/web/src/notifications/turnCompletion.logic.ts:105` | R3M-2             | LOW      | fix now     | Candidates are filtered only against the prior seen set, so two same-snapshot candidates with the same accepted turn-ID key both notify.                              |
| C3  | `apps/web/src/routes/__root.tsx:101`                     | R3H-2             | MEDIUM   | fix now     | Entering an authenticated/hosted-static connect route unmounts the coordinator and discards its baseline, losing completions while the route is active.               |
| C4  | `apps/web/src/notifications/turnCompletion.tsx:123`      | R3H-3             | MEDIUM   | fix now     | Before client settings hydrate, enabled persisted settings appear false and observed completions are permanently consumed without delivery.                           |
| C5  | `apps/desktop/src/ipc/methods/notifications.ts:121`      | R3A-2             | MEDIUM   | fix now     | The IPC waits indefinitely if a supported native backend returns from `show()` without emitting either `show` or the Windows-only `failed` event.                     |

## Deferred candidates

None. Every retained issue has a focused fix within the requested round-2 boundary.

## Discarded summary

None. Duplicate reports of the global bootstrap regression were consolidated into C1.

## Resolution

All five retained findings were fixed in round 3.

- The coordinator now relies solely on per-environment authority filtering; adding or initially
  retrying one environment no longer clears healthy environments' baselines.
- Turn IDs are deduplicated against a working seen set within the same snapshot as well as across
  later snapshots.
- Toast providers and the coordinator remain at a stable root position through authenticated and
  hosted-static connect-route transitions.
- Candidates observed before client settings hydration are queued and resolved against the
  persisted settings once hydration finishes.
- Electron native-show acknowledgment has a five-second Effect timeout. A timed-out native entry is
  released and explicitly closed so it cannot leave non-actionable OS UI.
- Focused regressions cover new-environment bootstrap isolation, same-snapshot dedupe, hydration
  queuing, and the native-show timeout.

Verification:

- Focused tests: 6 files, 69 tests passed.
- `vp check`: passed (existing unrelated warnings only).
- `vp run typecheck`: passed.
- `pnpm typecheck`: passed (with the repository's Node engine warning).
