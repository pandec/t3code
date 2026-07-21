# Deferred items: message listening cy-review

## Persistent playback outside virtualized rows

The web and mobile players are currently owned by the assistant-message row. Scrolling far enough for LegendList to recycle that row can stop playback and discard its local expanded state, which is especially relevant for long recordings. It was not changed in pass 1 because lifting player ownership requires a coordinated product choice between a persistent mini-player, an inline portal, or a hybrid on both clients. I recommend handling it as a focused follow-up after the initial live playback test establishes the desired interaction.
