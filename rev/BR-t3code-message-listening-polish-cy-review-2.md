# cy-review pass 2: message listening polish

- Branch: `t3code/message-listening-polish`
- Base: `dev`
- Date: 2026-07-22
- Diff base: `dev...92926867f`
- Round: 2
- PR: not opened yet

## Review fleet

Three fresh Sol-medium reviewers inspected the complete post-pass-1 diff.

- Skeptical code reviewer: async playback and Android accessibility regressions.
- Adversarial solution reviewer: API boundaries, backend evidence, and private-fork maintenance cost.
- Audio/security specialist: cross-client audio timing, recording arbitration, permissions, and accessibility; no actionable findings.

## Summary

- Raw findings: 5
- Deduplicated findings kept: 5
- Fix now: 3
- Deferred: 2
- Discarded: 0

## Combined findings

| ID   | File                                                     | Severity | Disposition | Rationale                                                                                                                                                                                                  |
| ---- | -------------------------------------------------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-1 | `apps/mobile/src/features/threads/ThreadFeed.tsx:1182`   | Medium   | Fix now     | Recording can begin while an ended track awaits its rewind; revalidate the blocked state before changing the process-wide mobile audio mode.                                                               |
| P2-2 | `apps/mobile/src/components/AndroidAnchoredMenu.tsx:282` | Medium   | Fix now     | Inferring radio semantics from each item's selected state mislabels existing unselected menu choices. Make the action role explicit for the playback-speed menu and leave unrelated menus unchanged.       |
| P2-3 | `packages/contracts/src/server.ts:435`                   | Medium   | Defer       | Advertising the configured model's exact character limit would prevent a rare impossible action, but it expands the server capability contract and both clients for an edge case below the default limit.  |
| P2-4 | `apps/server/src/voice/MessageSpeech.test.ts:10`         | Medium   | Defer       | A full dependency-injected synthesis-layer harness would add useful cache/rollback evidence, but it is a relatively large private-fork test seam beyond the focused backend tests and live end-to-end run. |
| P2-5 | `apps/mobile/src/features/threads/ThreadFeed.tsx:1172`   | Medium   | Fix now     | The consequential async startup invariant lacked a regression test. Extract only the startup sequence and cover supersession, recorder interruption, and current-speed application with deferred tests.    |

## Deferred candidates

| ID   | Candidate                                | Decision                                                                                                                                            |
| ---- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-3 | Model-specific client eligibility        | Revisit if a lower-limit ElevenLabs model is selected in practice; then extend the capability schema and show a reason-specific client error.       |
| P2-4 | Full synthesis-layer integration harness | Rely on the narrow backend tests and real local ElevenLabs exercise for this private feature; add the harness if the synthesis transaction evolves. |

## Discarded summary

No findings were discarded in this pass.
