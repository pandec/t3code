# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. Supported iOS devices transcribe locally. An environment whose server has
`ELEVENLABS_API_KEY` also transcribes uploaded recordings
([VoiceTranscription](../../apps/server/src/voice/VoiceTranscription.ts)); mobile
falls back to it when local transcription is unavailable or fails to prepare, and
the desktop composer uses it directly.

On mobile, the [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced. The
[desktop recorder](../../apps/web/src/components/chat/DesktopVoiceRecorder.tsx) is
keyed to its draft, so switching drafts discards an in-flight result, and appends
the transcript to the current text.

A draft that receives a transcript carries `inputOrigin: "voice-transcription"`
until its text is emptied; sends and failure restores keep it with the message,
and a queued edit sends the draft's origin (null when retyped), so a dictated
message that was emptied and retyped becomes typed. The provider caution is added only at the provider boundary
([InputOriginNotice](../../apps/server/src/orchestration-v2/InputOriginNotice.ts)),
so stored and displayed text stays exactly what the user dictated.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.
