# Cy-review: ElevenLabs voice transcription (round 1)

- Target: `t3code/elevenlabs-stt-voice-messages`
- Base: `dev`
- Diff: `dev...58ce8ac8f`
- Date: 2026-07-20
- PR: none

## Fleet

The three available concurrent reviewer slots were used because this is a substantial cross-client change and three distinct specialists cover the material risk boundaries without duplicating scope.

| Reviewer             | Primary responsibility                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Skeptical code       | Correctness, regressions, async state, and failure paths                                  |
| Adversarial solution | Ownership, API boundaries, provenance, and solution complexity                            |
| Security and media   | Secrets, authenticated input limits, external API behavior, and microphone/file lifecycle |

## Summary

- Raw reviewer/executor findings: 13
- Unique kept findings: 9
- Fix now: 8
- Deferred: 1
- Discarded or deduplicated: 4

## Combined findings

| ID   | Location                                                                                                                   | Source       | Severity | Disposition | Rationale                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ------------ | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| R1-1 | `apps/server/src/voice/VoiceTranscription.ts:114`                                                                          | ADV-1, SEC-1 | HIGH     | fix now     | Provider HTTP errors retain the request and `xi-api-key`; the error is later structurally logged.                             |
| R1-2 | `packages/contracts/src/voice.ts:19`                                                                                       | SEC-2        | MEDIUM   | fix now     | Schema length validation happens after JSON body buffering, so the transport itself needs a bounded body size.                |
| R1-3 | `apps/web/src/components/chat/DesktopVoiceRecorder.tsx:176`                                                                | SK-2, SEC-3  | MEDIUM   | fix now     | Concurrent starts and constructor failure can leak an acquired microphone stream or mix recorder chunks.                      |
| R1-4 | `apps/mobile/src/features/threads/VoiceRecorderControl.tsx:48`                                                             | SK-1, SEC-4  | MEDIUM   | fix now     | Unmount/termination during start, recording, transcription, or failed retry can leave audio mode or temp files behind.        |
| R1-5 | `apps/mobile/src/features/threads/VoiceRecorderControl.tsx:58`; `apps/web/src/components/chat/DesktopVoiceRecorder.tsx:88` | ADV-2        | MEDIUM   | fix now     | A retained recording can be retried into a different environment/composer if selection changes while the component survives.  |
| R1-6 | `apps/server/src/voice/VoiceTranscription.ts:14`                                                                           | ADV-3        | MEDIUM   | fix now     | ElevenLabs permits `language_code: null`; the current response schema rejects it.                                             |
| R1-7 | `apps/server/src/voice/VoiceTranscription.ts:114`                                                                          | SEC-5        | MEDIUM   | fix now     | The client timeout does not cancel or bound the server-to-ElevenLabs request.                                                 |
| R1-8 | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:72`                                                        | Executor     | LOW      | fix now     | Appending the notice before empty-input normalization can turn a blank voice-origin turn into a notice-only provider request. |
| R1-9 | `apps/server/src/voice/VoiceTranscription.ts:56`                                                                           | SEC-6        | MEDIUM   | defer       | Verifying actual audio duration server-side needs media probing; the dev MVP currently trusts its authenticated clients.      |

## Deferred candidates

| ID   | Reason                                                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-9 | Add server-side media-duration inspection only if the three-minute cap must be an adversarial billing/security boundary rather than a client UX hard stop. |

## Discarded and deduplicated

- Duplicate secret-leak and media-lifecycle reports were merged into their underlying findings.
- Sticky provenance after a wholesale edit was discarded: `inputOrigin` intentionally records how the draft originated, and the requested visible marker/provider caution applies even when the user corrects the transcript before sending.
