# Deferred items: message listening polish cy-review

## Persistent playback outside virtualized rows

The listening result, expansion state, and audio player remain owned by each assistant-message row. When LegendList recycles a row, playback stops and returning to the message may require reopening the cached listening version. This matters for long recordings when the user scrolls substantially while listening, but fixing it requires lifting player ownership into a persistent thread-level player across web and mobile. The user explicitly preferred this slightly worse but predictable behavior over a deeper architecture that would increase upstream synchronization cost, so I recommend retaining the limitation unless actual usage proves it too disruptive.
