# CLI Automation

## Updating the CLI and background service

```bash
t3 update [version] [--channel stable|nightly|preview] [--allow-downgrade] [--yes]
t3 service restart
t3 uninstall [--yes]
```

`t3 update` downloads a self-contained release and repoints the launcher and any installed
background service. It asks before restarting that service; scripts must pass `--yes` to restart
it immediately. If restart is deferred, `t3 service restart` activates the prepared version later.
`service update` is deprecated and retains its older behavior of installing the invoking CLI's
version. Use `t3 update` to fetch a newer release.

`t3 uninstall` removes the owned launcher, downloaded versions, and background service, while
keeping projects, threads, and settings. `t3 service uninstall` removes only the service.
These commands print human-readable output and do not support `--json`.

## Trace summary — not an automation command

`t3 trace summary [--since 30m] [--limit 25] [--base-dir <path>]` prints per-span counts, rates, and
latency from the local server trace file and its rotated backups. It reads the files directly, so it
works while the server is stalled or stopped. Output is a human-readable table with no `--json` mode.
`T3CODE_TRACE_FILE` overrides the file; otherwise it reads the `userdata` trace for `--base-dir` or
`T3CODE_HOME`.

## Triage — not an automation command

`t3 triage` investigates a broken installation by handing a written problem report to a coding agent
on this machine. It is interactive, has **no `--json` mode and no structured output**, and needs no
running server.

```bash
t3 triage [--agent claude|codex] [--model <model>] [--base-dir <path>]
```

It writes `context.md` and `prompt.md` under `<state-dir>/triage/<timestamp>/`, then launches the
chosen agent on them. `--base-dir` wins over `T3CODE_HOME`, the same precedence `t3 pair` uses, and
triage always reads the `userdata` state rather than a dev state directory.

Three behaviors differ from the automation commands and matter when scripting around it:

- The agent is discovered on `PATH` by name. It does **not** use the binary path, Claude home, or
  provider instance configured in T3, so it can pick a different account than the app runs, or report
  an agent missing that T3 itself can start.
- `--model` is passed straight through to the agent CLI. It is not a T3 model slug, and there is no
  `--instance` or effort flag.
- With both agents installed and no `--agent`, it needs an interactive terminal to ask which to use.
  With neither installed it writes the two files, prints their location, and exits without launching.

Filing an issue and applying any fix both require explicit confirmation inside the agent session.
