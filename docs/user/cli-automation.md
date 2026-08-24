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
the phase that expired. Mutations use a separate fixed 30-second acknowledgement bound, except when `thread new` starts in
new-worktree mode (explicit `--new-worktree`, or a configured worktree default); that waits up to 3
minutes because the server prepares the worktree before acknowledging. `--timeout-ms` does not
change either mutation bound.

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

### Terminal environment

Every T3 terminal — opened by an action or by hand — knows which thread and which T3 installation it
belongs to:

| Variable           | Value                                                                        |
| ------------------ | ---------------------------------------------------------------------------- |
| `T3CODE_THREAD_ID` | The thread that owns the terminal.                                           |
| `T3CODE_HOME`      | The data directory of the server running it.                                 |
| `T3CODE_STATE_DIR` | Where that server keeps its state, which is not a fixed path under the home. |

T3 sets these itself and ignores any value supplied for them, so a command can trust them to describe
its own thread and its own installation rather than whichever one happened to run last.

Threads started with a project also receive `T3CODE_PROJECT_ROOT`, and threads running in a worktree
receive `T3CODE_WORKTREE_PATH`. Unlike the three above, these describe the workspace rather than the
session, and are absent when a terminal is opened without a project.

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
t3 thread messages <thread-id> --json
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

### Reading messages

`t3 thread messages <thread-id>` prints the conversation as a transcript, user and assistant
messages only, without tool calls or file activity. `--json` returns a document with `threadId`,
`title`, `state`, `archived`, `machine`, `messages`, `hasMoreOlder`, and `nextBefore`; each message
carries its id, role, text, `createdAt` timestamp, turn id, and attachment metadata. Unlike the
other thread commands, this one also reads archived threads; the output marks those with
`"archived": true` and a `null` title and state. On servers that predate the dedicated messages
route (including upstream ones), the command falls back to the full thread snapshot and windows it
client-side, so paging flags keep working.

The default is the full history, paged from the server internally. `--limit N` returns only the
newest N messages; when older ones remain, the JSON sets `hasMoreOlder` and provides a `nextBefore`
message id to pass as `--before` on the next call. A `--before` id that matches no message in the
thread fails with an explicit cursor error rather than printing an empty transcript. `--role
user|assistant|system` narrows to one role; system messages only appear when requested that way.
The `--limit` window is counted before any role filtering — including the default exclusion of
system messages — so a filtered result can contain fewer than N messages, or none, while older
history still exists.

Attachments are files on the machine that runs the server. Each one resolves to an absolute `path`
on that machine plus an `exists` flag (`path` is `null` in the rare case the record cannot be
resolved to a file location), and the output names the machine itself: `machine.hostname`, with the
environment id and label when the server reports them. When you run this command over SSH on
another machine, the paths belong to that host, not yours. Fetch the files over SSH rather than
concluding they are missing.

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
  As a self-healing backstop for `--drain=agents`, when the turn has settled and only the drain
  keeps the wait pending, a `thread.updatedAt` the wait itself has observed standing still for
  3 minutes marks the liveness as stale: the wait returns the settled outcome with
  `drainStale: true`. The freeze is measured across this wait's own polls, so it never fires on the
  first poll and a `--timeout` under 3 minutes still times out first. Treat `drainStale` as
  "probably stale, not proven": an agent silent inside one long tool call has no activity cadence
  guarantee, so verify background-produced artifacts if later automation depends on them.
  `--drain=all` is exempt — a `"working"` aggregate can hide a legitimately quiet watch loop, so it
  keeps plain timeout semantics.
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
`waitedMs`, `observedSequence`, `adoptionTimedOut`, `drainUnsupported`, `drainStale`,
`backgroundLiveness`, and the
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

Without a workspace flag, `thread new` honors the same default environment mode as the app's
new-thread flow: the per-project setting, then the repository's checked-in `t3.json`
(`defaultThreadEnvMode`), then the server's global setting. When nothing selects worktrees, the
thread runs directly in the project workspace root, so concurrent CLI threads on the same project
share one working tree. When the default resolves to worktree mode, `thread new` behaves like
`--new-worktree` below and also honors the server's "start new worktrees from origin" setting. If
the server confirms it lacks worktree bootstrap support, a defaults-derived worktree falls back to
the checkout with a warning on stderr — check the JSON `workspace.mode` when automation relies on
the configured isolation. A failed capability read still fails the command. Explicit flags always
win over the configured defaults:

- `--checkout` forces the plain project checkout even when the configured default is a worktree.

Two further flags select a worktree explicitly, matching the workspace picker in the app:

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
both `null` for the plain checkout mode). In new-worktree mode — whether from the explicit flag or
the configured default — the server creates the thread as part of the turn start, so
`createCommandId` is `null`. Thread list and status summaries also
include `branch` and `worktreePath` (both `null` for plain checkout threads), so automation can
discover where a thread runs. `project list --json` reports each project's `defaultThreadEnvMode`
override (`null` when the checked-in `t3.json` and the global setting decide).

## Session import

```bash
t3 session candidates --project /absolute/path/to/repository --json
t3 session candidates --project /absolute/path/to/repository --cwd /absolute/path/to/worktree --json
t3 session import --file /path/to/transcript.jsonl --project /absolute/path/to/repository --json
t3 session import --file /path/to/transcript.jsonl --project /absolute/path/to/repository --worktree-branch feature/example --title "Continue the task" --json
```

Session commands require a running T3 server. `candidates` lists local Claude and Codex sessions for
the selected project or validated worktree. Sessions already attached to a non-deleted T3 Code thread
are listed rather than hidden, whether that thread came from an earlier import or was created inside
T3 Code at the selected workspace root. Human output appends `linked:<thread-id>` and `(archived)` when
applicable. In JSON, every candidate includes `instanceId`, `provider`, `providerDisplayName`,
`nativeSessionId`, `name`, `preview`, `messageCount`, and `updatedAt`. `linkedThread` is `null` for an
unlinked session; otherwise it contains `threadId`, `title`, `archivedAt`, the owning thread's
`updatedAt`, and `canFork`. Older servers may omit `linkedThread`; clients must treat absence as `null`.
A missing or deleted owning thread is treated as a stale binding and therefore reported as unlinked.

Importing a linked candidate with fork permission reads the original session's current full history,
then forks it into a fresh provider continuation before creating the new T3 thread. The original thread
keeps sole ownership of the original native session; providers without this capability report
`linkedThread.canFork: false` and reject the fork. Forking a linked candidate is driven from the desktop import
dialog — `t3 session import` imports a transcript file rather than a listed candidate, so it has no
fork flag. `import` detects the provider and native session identity from the
transcript, places the provider file without overwriting an existing one, and creates a T3 thread that
resumes the native session. Model, effort, provider instance, title, and worktree branch can be
overridden with the corresponding flags.

## Environment Status

```bash
t3 status --json
```

Status reports whether the selected local server is running, its origin and process id, project and
thread counts, running-thread count, and pending approval or user-input counts.

Use `--base-dir <path>` consistently when managing a non-default T3 installation.

## Triage — not an automation command

`t3 triage` investigates a broken installation by handing a written problem report to a coding agent
on this machine. It is listed here so scripts do not mistake it for part of the contract above: it is
interactive, has **no `--json` mode and no structured output**, and needs no running server.

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
