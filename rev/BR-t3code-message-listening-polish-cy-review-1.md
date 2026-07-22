# cy-review pass 1: message listening polish

- Branch: `t3code/message-listening-polish`
- Base: `dev`
- Date: 2026-07-22
- Diff base: `dev...87293d205`
- Round: 1
- PR: not opened yet

## Review fleet

Three Sol-medium reviewers ran in parallel, the maximum fleet supported by the available concurrency.

- Skeptical code reviewer: correctness, regressions, tests, and integration of the full feature onto current `dev`.
- Adversarial solution reviewer: challenged row-owned playback, state ownership, and upstream-sync tradeoffs.
- Audio/accessibility specialist: HTML and Expo audio timing, recording arbitration, menu semantics, and screen-reader behavior.

## Summary

- Raw findings: 6
- Deduplicated findings kept: 4
- Fix now: 3
- Deferred: 1
- Discarded: 0

## Combined findings

| ID   | File                                                         | Sources          | Severity | Disposition | Rationale                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------ | ---------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1 | `apps/mobile/src/features/threads/ThreadFeed.tsx:1174`       | SC-1, AR-1, AA-1 | High     | Fix now     | An older asynchronous Play request can resume after a newer row has claimed playback, breaking exclusivity and applying a stale speed. Add an activation lease and validate it after awaits. |
| P1-2 | `apps/mobile/src/components/AndroidAnchoredMenu.tsx:202`     | AA-2             | Medium   | Fix now     | Android's outer menu trigger drops the specific playback-speed label, and selected menu items expose only a visual checkmark. Forward the label and expose selected radio semantics.         |
| P1-3 | `apps/server/src/textGeneration/CursorTextGeneration.ts:260` | SC-2             | High     | Fix now     | Cursor and Grok speech rewrites do not have the explicit tool-denial boundary used by other providers. Deny ACP permission requests and run rewrites from an isolated temporary directory.   |
| P1-4 | `apps/mobile/src/features/threads/ThreadFeed.tsx:1039`       | AR-2             | Medium   | Defer       | Row virtualization still stops playback and loses local card state. The user explicitly chose this limitation to avoid a persistent player architecture and reduce upstream merge cost.      |

## Deferred candidates

| ID   | Candidate                                    | Decision                                                                                                                   |
| ---- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| P1-4 | Persistent playback outside virtualized rows | Keep deferred as an explicit product tradeoff; reconsider only if real usage shows scrolling interruption is unacceptable. |

## Discarded summary

No findings were discarded in this pass.
