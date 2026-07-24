# PR #30 cy-review deferred items

## Embedded preview/webview focus

Command+Z events from the Electron preview webview do not reach the host-window archive-undo listener. This matters if “outside any editable input” is intended to include non-editable guest webpage content, but forwarding the chord could also override the webpage’s own undo semantics. It is not included in this PR because it requires an explicit product choice and a broader desktop IPC/input-forwarding change. Revisit only if archive undo should deliberately cross the guest-content boundary.

## Multi-select archive semantics

The sidebar presents archiving multiple selected threads as one action, while the requested undo contract and current implementation retain only the most recently archived thread. Restoring the whole batch would require batch and partial-failure semantics; exposing repeated single-thread undo would change the latest-only contract. Revisit if Command+Z should undo bulk archives as a unit.

> cy-review complete — 2026-07-24T10:50:11Z — rounds: 5
