# Deferred items: message listening polish cy-review

## Persistent playback outside virtualized rows

The listening result, expansion state, and audio player remain owned by each assistant-message row. When LegendList recycles a row, playback stops and returning to the message may require reopening the cached listening version. This matters for long recordings when the user scrolls substantially while listening, but fixing it requires lifting player ownership into a persistent thread-level player across web and mobile. The user explicitly preferred this slightly worse but predictable behavior over a deeper architecture that would increase upstream synchronization cost, so I recommend retaining the limitation unless actual usage proves it too disruptive.

## Model-specific eligibility in the client

The server capability currently advertises only whether text-to-speech is available, while the configured ElevenLabs model can impose a limit between 5,000 and 40,000 characters. The default model accepts the feature's full 40,000-character source limit, so the mismatch appears only with a lower-limit custom model and a long response. Carrying the exact limit through the shared server contract and both clients would make that edge case clearer but expands the upstream-sensitive protocol surface. Revisit this if a lower-limit model is actually adopted; until then the server remains authoritative and rejects the request without sending text to ElevenLabs.

## Full synthesis-layer test harness

The focused backend suite covers source eligibility, model limits, cache identity, same-message locking, rewrite-provider permission denial, HTTP error mapping, and audio range delivery. It does not construct the entire synthesis layer with fake SQLite, filesystem, text generation, and HTTP dependencies to exercise every cache and rollback branch. Such a harness would improve evidence but would also require a substantial private-only test seam; the narrower tests plus a real local ElevenLabs run are proportionate for the current fork customization. Add the harness if this transaction gains more behavior or begins changing independently of the listening feature.
