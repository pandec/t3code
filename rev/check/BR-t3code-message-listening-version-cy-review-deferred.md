# Deferred items: message listening cy-review

## Persistent playback outside virtualized rows

The web and mobile players are currently owned by the assistant-message row. Scrolling far enough for LegendList to recycle that row can stop playback and discard its local expanded state, which is especially relevant for long recordings. It was not changed in pass 1 because lifting player ownership requires a coordinated product choice between a persistent mini-player, an inline portal, or a hybrid on both clients. I recommend handling it as a focused follow-up after the initial live playback test establishes the desired interaction.

The same player-ownership follow-up should guarantee that starting one listening version pauses the currently active one. Today, two visible row-local mobile players can play simultaneously. Central ownership fixes both overlap and off-screen persistence with one coherent interaction model.

## Mobile recording and playback arbitration

The listening player sets Expo's process-wide audio mode to disallow recording immediately before playback, while the composer voice recorder independently enables recording mode. Starting playback during an active recording can therefore disrupt the recorder without synchronizing its UI state. Resolving this requires a product decision: disable playback while recording, or explicitly stop and retain/discard the recording before playback. I recommend disabling playback during recording unless the user explicitly confirms an interruption.

> cy-review complete — 2026-07-21T17:23:01+02:00 — rounds: 2
