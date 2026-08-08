# CLI Automation

The `t3` CLI exposes project and thread operations for scripts and external agents. Pass `--json`
to receive one structured JSON document on stdout; routine runtime logs are suppressed so the output
can be piped directly to tools such as `jq`.

Check the exit code before parsing. On success the command exits `0` and stdout holds the result
document. On failure it exits non-zero and stdout holds one error document instead:

```json
{
  "error": {
    "code": "CliOrchestrationReadTimeoutError",
    "message": "The running server did not answer the snapshot read within 10000ms. ...",
    "detail": { "operation": "callLiveServer", "phase": "snapshot", "timeoutMillis": 10000 }
  }
}
```

`code` is the stable error tag and `detail` carries the error's primitive fields (never the cause
chain). When an outcome is ambiguous — a mutation acknowledgement was lost, the server answered an
undeclared 5xx during dispatch, a multi-step command could not confirm its compensation, or the server
stopped during a thread wait — the error additionally carries `"outcome": "unknown"`; reconcile
current state before retrying. For mutation errors without that marker, the mutation was not applied
or any earlier step was successfully compensated.

## Live-read timeouts

Project, thread, and status commands talk to the running server with phase-specific timeouts: the
shell snapshot read that discovers the server (and backs thread/status commands) defaults to 3
seconds, and further data reads (full snapshot, capability descriptor) default to 10 seconds.
Override with `--timeout-ms <n>` or `T3CODE_CLI_TIMEOUT_MS`; an explicit override applies to every
live read, discovery included, so raising it also helps thread and status commands on a busy
server. Invalid or non-positive overrides are ignored with a warning on stderr. Timeout errors name
the phase that expired. Mutations use a separate fixed 30-second acknowledgement bound, except
`thread new --new-worktree`, which waits up to 3 minutes because the server prepares the worktree
before acknowledging; `--timeout-ms` does not change either mutation bound.

Project commands require the selected T3 server to be running. They never read or mutate the local
SQLite database directly; an unavailable or timed-out server returns a structured server-unavailable
or read-timeout error.

## Projects

```bash
t3 project list --json
t3 project add /absolute/path/to/repository --title "My Project" --json
t3 project rename /absolute/path/to/repository "New Title" --json
t3 project remove /absolute/path/to/repository --json
```

Project commands target the T3 data directory selected by `--base-dir` or `T3CODE_HOME` and use its
running server. If that server is unavailable, the command fails without opening the database.

### Project actions

Project actions can also be managed by project id or exact workspace-root path:

```bash
t3 project action list /absolute/path/to/repository --json

t3 project action add /absolute/path/to/repository \
  --name "Install iOS" \
  --command "pnpm ios:local:release" \
  --icon build \
  --json

t3 project action update /absolute/path/to/repository install-ios \
  --command "pnpm ios:local" \
  --json

t3 project action remove /absolute/path/to/repository install-ios --json
```

`add` derives a stable action id from the name unless `--id` is supplied. Use the exact id returned
by `add` or `list` for later updates and removals. The optional action fields exposed by the desktop
UI are available as `--run-on-worktree-create`, `--preview-url`, and `--auto-open-preview`;
boolean update flags also accept the `--no-...` form, and `--clear-preview-url` removes both preview
settings. Keybindings are user-level settings rather than project action data and are not changed by
these commands.

Action listing, adding, updating, and removing require the running server so concurrent UI and CLI
edits can be serialized safely. If another client
changed the actions after the CLI read them, the mutation fails with a conflict; list the actions
again and retry. The CLI also verifies that the running server supports conditional action updates
before writing; update and restart T3 Code if it reports an incompatible server.

Mutation acknowledgement is bounded. If the connection is lost after dispatch, the CLI reports that
the outcome is unknown because the server may still have committed the command. List the actions and
reconcile their current state before retrying; do not blindly repeat the mutation.

Only one action can run automatically when a worktree is created. Adding or updating an action with
`--run-on-worktree-create` disables that setting on the previous setup action and reports its id in
human and JSON output.

## Threads

```bash
t3 thread list --json
t3 thread list --project /absolute/path/to/repository --state running --json
t3 thread new --project /absolute/path/to/repository --message "Inspect the failing tests" --json
t3 thread new --project /absolute/path/to/repository --message "Fix the flaky test" --new-worktree --json
t3 thread new --project /absolute/path/to/repository --message "Continue the refactor" --worktree /absolute/path/to/worktree --json
t3 thread send <thread-id> --message "Also check the logs" --json
t3 thread rename <thread-id> "Investigate test failures" --json
t3 thread status <thread-id> --json
t3 thread interrupt <thread-id> --json
t3 thread wait <thread-id> --json
t3 thread archive <thread-id> --json
```

Thread commands require a running T3 server. `thread new` creates a thread and starts its first
agent turn. `thread send` starts a new turn when the thread is idle and steers the active turn when
the provider supports steering. Thread list and status JSON summaries include `snoozedUntil` and
`snoozedAt`; both are `null` when the thread is not snoozed, and an indefinite snooze ("until I wake
it") carries a `snoozedAt` with a `null` `snoozedUntil`. Snooze is an inbox overlay and does not
change the thread's turn `state`.

The project argument accepts either a project id or an exact workspace-root path. Thread mutation
commands intentionally require a thread id so automation cannot act on an ambiguous title. Thread
list and status summaries also include `backgroundLiveness`: `"working"` for native subagents or
workflows, `"monitoring"` when only watch loops remain, and `null` when no native background work is
known.

### Waiting for turns

`t3 thread wait <thread-id>` blocks until the thread's current turn settles. The default timeout is 30
minutes; change it with `--timeout 30s`, `--timeout 5m`, or another duration. This wait deadline is
separate from `--timeout-ms`, which controls each live-server read. The command is suitable for shell
composition:

```bash
t3 thread wait "$thread_id" && run-the-next-step
```

When a script starts or steers a turn, anchor the wait to the dispatch sequence returned by that
mutation. This prevents an older, idle-looking shell snapshot from satisfying the wait before the new
turn is visible:

```bash
seq=$(t3 thread send "$thread_id" --message "Run the checks" --json | jq .sequence)
t3 thread wait "$thread_id" --after-sequence "$seq"
```

Use `--turn <turn-id>` to wait for one specific turn. If another turn becomes latest first, the wait
returns `superseded` with exit code 0; an unknown or mistyped turn id has the same result because the
shell cannot distinguish it from an older turn. By default a pending approval or user-input request
returns immediately as outcome `blocked`; `--on-blocked wait` keeps waiting instead. A newly dispatched
turn can briefly exist before a provider session adopts it, so `wait` treats a queued start it observes
as pending for up to two minutes. If that observed start never adopts before the grace expires, it
returns `unadopted` with exit code 2 and `adoptionTimedOut: true`. An already-old message on a plain idle
thread is not treated as an adoption timeout.

After the turn settles, `--drain` (equivalent to `--drain=agents`) also waits for native subagents and
workflows. `--drain=all` additionally waits for monitoring/watch loops. This signal is intentionally
bounded and honest:

- Background liveness is in-memory server state and resets when the server restarts.
- A lost native `task.completed` event can leave liveness at `"working"`; keep a finite `--timeout`.
- Detached external processes are invisible to the server and cannot be drained.
- Older servers omit the field; the wait completes and JSON reports `drainUnsupported: true`.

A successful wait means the observed turn settled, not that every external artifact, filesystem flush,
or provider checkpoint is durable. Use the relevant artifact or checkpoint receipt when later automation
requires that stronger guarantee.

Terminal outcomes use these exit codes:

| Outcome                                                              | Exit code |
| -------------------------------------------------------------------- | --------: |
| `completed`, `idle`, or `superseded`                                 |         0 |
| `timeout` or `unadopted`                                             |         2 |
| `error`                                                              |         3 |
| `interrupted`                                                        |         4 |
| `blocked`                                                            |         5 |
| Thread archived or deleted during the wait (`vanished`)              |         6 |
| Transport, authentication, initial not-found, or other command error |         1 |
| SIGINT                                                               |       130 |

`--exit-zero` collapses observed terminal outcomes 2–6 to exit code 0; it does not hide transport,
authentication, or parsing failures. JSON extends the normal thread summary with `outcome`, `waited`,
`waitedMs`, `observedSequence`, `adoptionTimedOut`, `drainUnsupported`, `backgroundLiveness`, and the
latest turn timestamps when available. A timeout retains the last observed thread state and background
liveness so callers can distinguish active work from stale or wedged state.

### Permissions and Isolation

`thread new` accepts `--runtime-mode` (`approval-required`, `auto-accept-edits`, `auto`,
`full-access`) and `--interaction-mode` (`default`, `plan`). Both default to the product defaults,
which means **`--runtime-mode full-access`**: the agent edits files and runs commands without asking
for approval. Pass `--runtime-mode approval-required` for unattended automation you do not fully
trust. `--runtime-mode auto` is provider-specific: Codex sends on-request approvals to its AI
reviewer, Claude uses Claude Code's native Auto permission mode, and providers without Auto support
continue prompting the user. It is not equivalent to full access and is not suitable for fully
unattended runs. `thread send` uses the thread's current runtime and interaction modes and cannot
change them.

### Workspaces

By default `thread new` runs the thread directly in the project workspace root, so concurrent CLI
threads on the same project share one working tree. Two flags select a different workspace, matching
the workspace picker in the app:

- `--new-worktree` asks the server to create a fresh git worktree for the thread (running the
  project's setup action, the same as "New worktree" in the UI). `--base <ref>` picks the base ref
  (default: the project's current branch), `--branch <name>` names the new branch (default: a
  temporary name that is auto-renamed from the thread title), and `--start-from-origin` bases the
  worktree on `origin/<base>` instead of the local ref. The CLI verifies that the running server
  supports worktree bootstrap before dispatching; update and restart T3 Code if it reports an
  incompatible server. On success the human and JSON output report the created branch and worktree
  path.
- `--worktree <path>` starts the thread in an existing worktree at that path (see
  `git worktree list`). The path must exist on the server machine, is canonicalized, and must be a
  worktree of the project's repository; the worktree's checked-out branch is recorded on the thread
  automatically, and an explicit `--branch <ref>` fails the command when it does not match.

`thread new --json` always includes a `workspace` object (`mode` plus `branch`/`worktreePath`,
both `null` for the plain checkout mode). In `--new-worktree` mode the server creates the thread
as part of the turn start, so `createCommandId` is `null`. Thread list and status summaries also
include `branch` and `worktreePath` (both `null` for plain checkout threads), so automation can
discover where a thread runs.

## Session import

```bash
t3 session candidates --project /absolute/path/to/repository --json
t3 session candidates --project /absolute/path/to/repository --cwd /absolute/path/to/worktree --json
t3 session import --file /path/to/transcript.jsonl --project /absolute/path/to/repository --json
t3 session import --file /path/to/transcript.jsonl --project /absolute/path/to/repository --worktree-branch feature/example --title "Continue the task" --json
```

Session commands require a running T3 server. `candidates` lists importable local Claude and Codex
sessions for the selected project or validated worktree. `import` detects the provider and native
session identity from the transcript, places the provider file without overwriting an existing one,
and creates a T3 thread that resumes the native session. Model, effort, provider instance, title, and
worktree branch can be overridden with the corresponding flags.

## Environment Status

```bash
t3 status --json
```

Status reports whether the selected local server is running, its origin and process id, project and
thread counts, running-thread count, and pending approval or user-input counts.

Use `--base-dir <path>` consistently when managing a non-default T3 installation.
