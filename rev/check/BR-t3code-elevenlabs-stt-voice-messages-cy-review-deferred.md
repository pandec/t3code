# Cy-review deferred items: ElevenLabs voice transcription

## Actual audio duration enforcement

The three-minute limit is enforced by both recording clients and by the authenticated request's declared duration, but the server does not inspect the encoded media duration. A modified paired client could therefore submit a longer, sufficiently compressed recording and under-report its duration, increasing ElevenLabs processing and cost. Server-side verification requires introducing a media parser or `ffprobe`-style dependency, which is disproportionate for the trusted-client development MVP. Revisit this if the endpoint is exposed to less-trusted clients or the cap becomes a billing/security boundary; otherwise drop it.
