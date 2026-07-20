---
name: diagnose-t3-logs
description: Inspect, interpret, and escalate diagnostics for a T3 Code server or installed desktop Dev build. Use when asked to check T3 Code logs on a specific machine, diagnose startup, backend, provider, terminal, Git, IPC, keyring, catalog, WebSocket, performance, or session failures, locate current log files, enable more detailed logging, or assess log retention and disk usage.
---

# Diagnose T3 Code Logs

Start from the live machine and current checkout. Treat the paths below as defaults, then verify the installed process/build identity, `T3CODE_HOME`, file modification times, and current code/config before drawing conclusions.

Keep an investigation read-only unless the user asks for changes. Do not reproduce sensitive conversation, command, repository, provider-event, or terminal payloads in the response; report structural evidence and narrowly relevant sanitized errors.

## Locate the logs

For the packaged Dev desktop build, check:

- `~/.t3/dev-packaged/logs/desktop.trace.ndjson` for Electron lifecycle, IPC, startup, window, safe-storage, keyring, and connection-catalog behavior.
- `~/.t3/dev-packaged/logs/server-child.log` for embedded-backend stdout/stderr, startup boundaries, crashes, and unstructured output.
- `~/.t3/userdata/logs/server.trace.ndjson` for structured backend spans, timings, database, Git/VCS, WebSocket RPC, provider processing, and failures.
- `~/.t3/userdata/logs/provider/<session-id>.log` for a specific provider protocol/session investigation.
- `~/.t3/userdata/logs/terminals/` for terminal-specific history.

Use `Settings -> Diagnostics` for the built-in process, resource, and trace view. Its folder action opens the backend logs directory.

Account for variants:

- An explicit `T3CODE_HOME` replaces the default `~/.t3` base.
- Source development can use `~/.t3/dev` rather than `userdata`.
- A WSL backend can have its own Linux-side `~/.t3/userdata/logs`.
- Non-primary desktop backend instances can use `server-child-<instance-id>.log`.

## Investigate efficiently

1. Confirm the relevant process and embedded build are running.
2. Compare modification times and identify which files are actively changing.
3. Check directory sizes and rotation before reading large provider files.
4. Start with `server.trace.ndjson` for general behavior, `desktop.trace.ndjson` for desktop-only failures, and `server-child.log` for crashes or missing instrumentation.
5. Correlate the incident time across files using span names, run IDs, instance IDs, trace IDs, and timestamps.
6. Inspect provider or terminal logs only when the symptom requires their raw stream.
7. Distinguish expected interruption/reconnect failures from actionable failures.

Remember that every backend stderr chunk is represented as `ERROR` in `server-child.log`; warnings and shell initialization messages can therefore look more severe than they are. Provider logs can be large, per-session, and sensitive. Structured desktop and server trace files normally rotate around 10 MiB with ten backups, but verify current constants and actual files.

## Escalate detail only when needed

The default traces are normally sufficient. If a controlled reproduction lacks necessary detail, fully quit the app and launch the actual executable from a shell with targeted environment variables so the desktop and embedded backend inherit them:

- `T3CODE_LOG_LEVEL=Debug` for more backend console output.
- `T3CODE_TRACE_MIN_LEVEL=Debug` for more detailed backend structured traces.
- `T3CODE_LOG_WS_EVENTS=true` only for WebSocket push/transport diagnosis.
- `T3CODE_TRACE_FILE=/explicit/path/server.trace.ndjson` to isolate a trace capture.
- `T3CODE_OTLP_TRACES_URL`, `T3CODE_OTLP_METRICS_URL`, and related OTLP variables for remote observability.

Do not leave Debug or WebSocket event logging enabled routinely. Reproduce the issue, collect the relevant time window, then return to defaults. Finder, Dock, Start-menu, and similar launches usually do not inherit shell variables.

## Verify against source

Use these pointers instead of relying on this skill for mutable details:

- Desktop path selection: `apps/desktop/src/app/DesktopEnvironment.ts`
- Desktop tracing and backend-child capture/rotation: `apps/desktop/src/app/DesktopObservability.ts`
- Desktop environment configuration: `apps/desktop/src/app/DesktopConfig.ts`
- Backend path derivation: `apps/server/src/config.ts`
- Backend logging and trace variables/defaults: `apps/server/src/cli/config.ts`
- Backend observability wiring: `apps/server/src/observability/Layers/Observability.ts`
- Trace diagnostics reader: `apps/server/src/diagnostics/TraceDiagnostics.ts`
- Provider log ownership and rotation: `apps/server/src/provider/Layers/ProviderEventLoggers.ts` and `apps/server/src/provider/Layers/EventNdjsonLogger.ts`
- Diagnostics UI: `apps/web/src/components/settings/DiagnosticsSettings.tsx`
- Operational documentation: `docs/operations/observability.md`
