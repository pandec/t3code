# Cy-review: ElevenLabs voice transcription (round 3)

- Target: `t3code/elevenlabs-stt-voice-messages`
- Base: `dev`
- Diff: `dev...8529d1b4f`
- Date: 2026-07-21
- PR: none

## Fleet

The same three-role Sol-medium fleet performed a final narrow regression pass over the full feature: skeptical correctness, adversarial solution design, and security/media lifecycle.

## Summary

- Raw findings: 5
- Unique kept findings: 4
- Fix now: 4
- New deferred items: 0
- Deduplicated: 1

## Combined findings

| ID   | Location                                                        | Source         | Severity | Disposition | Rationale                                                                                                                                                 |
| ---- | --------------------------------------------------------------- | -------------- | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3-1 | `apps/mobile/src/features/threads/VoiceRecorderControl.tsx:281` | ADV3-1, SEC3-1 | MEDIUM   | fix now     | Capability loss only hides the mounted iOS control, so pending or active capture can continue without controls.                                           |
| R3-2 | `apps/web/src/components/chat/DesktopVoiceRecorder.tsx:109`     | ADV3-2         | MEDIUM   | fix now     | Desktop capability teardown leaves the component mounted, so a late transcription or stop continuation can repopulate state after the recorder is hidden. |
| R3-3 | `apps/mobile/src/features/threads/VoiceRecorderControl.tsx:114` | SEC3-2         | MEDIUM   | fix now     | Unmount during native `stop()` can resume afterward and begin a new upload unless ownership is rechecked after the await.                                 |
| R3-4 | `apps/mobile/src/features/threads/VoiceRecorderControl.tsx:164` | SEC3-3         | MEDIUM   | fix now     | Canceling a pending permission/start resets only the ref, leaving rendered phase stuck on the starting spinner.                                           |

## Deferred candidates

No new items were deferred. Round 1's actual-media-duration verification remains the only deferred item.

## Deduplicated and verified

- The iOS capability-loss report was independently found by the adversarial and security reviewers and merged into R3-1.
- The skeptical reviewer found no remaining issue and independently verified the StrictMode, environment ownership, retry token, and 100 ms minimum fixes.
- The server API-key redaction, request-size boundary, provider timeout, and response decoding remain sound.

## Resolution

All four findings were fixed. Capability loss now unmounts the recorder controls so their existing ownership cleanup runs, late desktop and iOS continuations cannot submit after unmount, and a canceled iOS permission wait restores the idle UI.

Verification passed: the focused 20-test transcription/provenance suite, `vp check`, `vp run typecheck`, and `vp run lint:mobile` with the repository's configured JDK.
