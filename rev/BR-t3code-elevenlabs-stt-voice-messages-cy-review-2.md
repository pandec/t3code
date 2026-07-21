# Cy-review: ElevenLabs voice transcription (round 2)

- Target: `t3code/elevenlabs-stt-voice-messages`
- Base: `dev`
- Diff: `dev...b27a520e7`
- Date: 2026-07-21
- PR: none

## Fleet

Three independent Sol-medium reviewers re-reviewed the complete branch after round-1 fixes: skeptical correctness, adversarial solution design, and security/media lifecycle. This is the maximum concurrent fleet available in this session and targets the areas materially changed by round 1.

## Summary

- Raw findings: 6
- Unique kept findings: 4
- Fix now: 4
- New deferred items: 0
- Deduplicated: 2

## Combined findings

| ID   | Location                                                                                                                     | Source                | Severity | Disposition | Rationale                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-1 | `apps/web/src/components/chat/DesktopVoiceRecorder.tsx:99`                                                                   | SK2-1, ADV2-1, SEC2-1 | HIGH     | fix now     | React StrictMode replays the mount effect; cleanup sets `mountedRef` false and setup never restores it, leaving desktop recording stuck in `starting`.                       |
| R2-2 | `apps/web/src/components/chat/ChatComposer.tsx:2658`                                                                         | SEC2-2                | MEDIUM   | fix now     | Draft environment changes retain the same `DraftId`, so the recorder can survive an owner change; becoming unavailable can also hide an active recorder without stopping it. |
| R2-3 | `apps/mobile/src/features/threads/VoiceRecorderControl.tsx:61`                                                               | SEC2-3                | MEDIUM   | fix now     | Rapid Retry/Discard actions are not tokenized, allowing duplicate paid requests or a late transcript after explicit discard.                                                 |
| R2-4 | `apps/mobile/src/features/threads/VoiceRecorderControl.tsx:112`; `apps/web/src/components/chat/DesktopVoiceRecorder.tsx:150` | SK2-2                 | MEDIUM   | fix now     | ElevenLabs requires at least 100 ms of audio; an immediate release creates an immutable failure whose Retry action can never succeed.                                        |

## Deferred candidates

No new items were deferred. Round 1's server-side actual-media-duration verification remains deferred.

## Deduplicated and discarded

- The StrictMode regression was independently reported by all three reviewers and merged into R2-1.
- Reviewers verified that `xi-api-key` redaction, provider-error sanitization, route-local pre-buffer body limiting, non-voice routes, and the outbound server timeout are sound after round 1.
