# CLI Automation

The `t3` CLI exposes project and thread operations for scripts and external agents. Pass `--json`
to receive one structured JSON document on stdout; routine runtime logs are suppressed so the output
can be piped directly to tools such as `jq`.

Check the exit code before parsing. On success the command exits `0` and stdout holds only the JSON
document. On failure it exits non-zero and stdout carries a human-readable diagnostic instead of
JSON, so `t3 ... --json | jq` should be guarded (for example `if out=$(t3 ... --json); then ...`).

## Projects

```bash
t3 project list --json
t3 project add /absolute/path/to/repository --title "My Project" --json
t3 project rename /absolute/path/to/repository "New Title" --json
t3 project remove /absolute/path/to/repository --json
```

Project commands target the T3 data directory selected by `--base-dir` or `T3CODE_HOME`. Mutations
are sent to its running server when available; otherwise project metadata is updated offline.

## Threads

```bash
t3 thread list --json
t3 thread list --project /absolute/path/to/repository --state running --json
t3 thread new --project /absolute/path/to/repository --message "Inspect the failing tests" --json
t3 thread send <thread-id> --message "Also check the logs" --json
t3 thread rename <thread-id> "Investigate test failures" --json
t3 thread status <thread-id> --json
t3 thread interrupt <thread-id> --json
```

Thread commands require a running T3 server. `thread new` creates a thread and starts its first
agent turn. `thread send` starts a new turn when the thread is idle and steers the active turn when
the provider supports steering.

The project argument accepts either a project id or an exact workspace-root path. Thread mutation
commands intentionally require a thread id so automation cannot act on an ambiguous title.

### Permissions and Isolation

`thread new` accepts `--runtime-mode` (`approval-required`, `auto-accept-edits`, `full-access`) and
`--interaction-mode` (`default`, `plan`). Both default to the product defaults, which means
**`--runtime-mode full-access`**: the agent edits files and runs commands without asking for
approval. Pass `--runtime-mode approval-required` for unattended automation you do not fully trust.
`thread send` inherits the mode the thread was created with and cannot change it.

Threads created through the CLI run directly in the project workspace root. Unlike the desktop and
web clients, the CLI does not provision a per-thread git worktree, so concurrent CLI threads on the
same project share one working tree.

## Environment Status

```bash
t3 status --json
```

Status reports whether the selected local server is running, its origin and process id, project and
thread counts, running-thread count, and pending approval or user-input counts.

Use `--base-dir <path>` consistently when managing a non-default T3 installation.
