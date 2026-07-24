# PR #30 cy-review deferred items

## Embedded preview/webview focus

Command+Z events from the Electron preview webview do not reach the host-window archive-undo listener. This matters if “outside any editable input” is intended to include non-editable guest webpage content, but forwarding the chord could also override the webpage’s own undo semantics. It is not included in this PR because it requires an explicit product choice and a broader desktop IPC/input-forwarding change. Revisit only if archive undo should deliberately cross the guest-content boundary.

> cy-review complete — 2026-07-24T10:30:14Z — rounds: 1
