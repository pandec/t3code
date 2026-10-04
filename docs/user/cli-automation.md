# CLI Automation

The `t3` CLI exposes project, thread, and session operations for scripts and external agents. Pass
`--json` to receive one structured JSON document on stdout; routine runtime logs are suppressed so
the output can be piped directly to tools such as `jq`.

Check the exit code before parsing. On success the command exits `0` and stdout holds the result
document. On failure it exits non-zero and stdout holds one error document instead:

```json
{
  "error": {
    "code": "CliOrchestrationReadTimeoutError",
    "message": "The running server did not answer the discovery read within 3000ms. ...",
    "detail": { "operation": "callLiveServer", "phase": "discovery", "timeoutMillis": 3000 }
  }
}
```

`code` is the stable error tag and `detail` carries the error's primitive fields (never the cause
chain). Usage errors, such as a missing flag, follow the same contract when `--json` is present. When
an outcome is ambiguous — a mutation acknowledgement was lost or could not be decoded, the server
answered an undeclared 5xx during dispatch, a multi-step command could not confirm its compensation,
or the server stopped during a thread wait — the error additionally carries `"outcome": "unknown"`;
reconcile current state before retrying. For mutation errors without that marker, the mutation was
not applied or any earlier step was successfully compensated.

Use `--base-dir <path>` consistently when managing a non-default T3 installation. Without it,
commands use `T3CODE_HOME`, and inside a T3 terminal or provider process `T3CODE_STATE_DIR` selects
the state of the server that runs it.

## Live-read timeouts

Commands find the running server through a shell read that defaults to 3 seconds; further reads
(settings, capability descriptor, thread history) default to 10 seconds. Override both with
`--timeout-ms <n>` or `T3CODE_CLI_TIMEOUT_MS`; an explicit override applies to every live read,
discovery included, so raising it helps on a busy server. Invalid or non-positive overrides are
ignored with a warning on stderr. Timeout errors name the phase that expired.

Mutations use a separate fixed 30-second acknowledgement bound. `thread new` in new-worktree mode
(explicit `--new-worktree`, or a configured worktree default) then waits up to 3 minutes for the
server to prepare the worktree. `session import` allows 30 seconds for the import itself.
`--timeout-ms` changes none of these bounds.

A server that is running but does not answer fails the command; the CLI never falls back to the
database behind a live server. A server whose process is gone, or that refuses connections, counts
as not running.

## Projects

```bash
t3 project list --json
t3 project add /absolute/path/to/repository --title "My Project" --json
t3 project rename /absolute/path/to/repository "New Title" --json
t3 project remove /absolute/path/to/repository --json
```

Project commands target the T3 data directory selected by `--base-dir` or `T3CODE_HOME`. `add`,
`rename`, and `remove` go through that directory's running server when there is one, and work
directly on the data directory when no server is running. `project list` requires the running
server. Its JSON is `{ "mode": "live", "projects" }`; each project has `id`, `title`,
`workspaceRoot`, its effective `defaultModelSelection`, `defaultThreadEnvMode` (the project
override, or `null` when the environment setting and `t3.json` decide), and `autoPull`.

A project id or its exact stored workspace path remains valid for renaming, removal, and action
management after the folder is moved or deleted. Removing a project that still has threads requires
`--force`, which deletes them too.

### Project actions

Project actions can also be managed by project id or exact workspace-root path:

```bash
t3 project action list /absolute/path/to/repository --json

t3 project action add /absolute/path/to/repository \
  --name "Install iOS" \
  --command "pnpm ios:local:release" \
  --icon build \
  --run-on-worktree-create \
  --json

t3 project action update /absolute/path/to/repository install-ios \
  --command "pnpm ios:local" \
  --json

t3 project action remove /absolute/path/to/repository install-ios --json
```

`add` derives a stable action id from the name unless `--id` is supplied. Use the exact id returned
by `add` or `list` for later updates and removals. The optional action fields exposed by the desktop
UI are available as `--run-on-worktree-create`, `--async`, `--preview-url`, and `--auto-open-preview`;
boolean update flags also accept the `--no-...` form, and `--clear-preview-url` removes both preview
settings. Keybindings are user-level settings rather than project action data and are not changed by
these commands.

Setup and the first agent turn run together by default. Pass `--no-async` to wait for setup before
the agent starts; a failing setup then fails the thread's start. An unrelated update preserves the
action's current async setting.

Actions inherit environment defaults until a project overrides them. CLI edits save the effective
list as a project override in Settings, preserving the project's other settings.

Action commands require the running server so concurrent UI and CLI edits are serialized safely. If
another client changed the actions after the CLI read them, the mutation fails with a conflict; list
the actions again and retry. The CLI also verifies that the running server supports conditional
action updates before writing; update and restart T3 Code if it reports an incompatible server.

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
t3 thread move <thread-id> --group "Inbox" --json
t3 thread move <thread-id> --active --json
t3 thread pin <thread-id> --json
t3 thread unpin <thread-id> --json
t3 thread list --pinned --json
t3 thread list --group "Inbox" --json
t3 group list --json
t3 thread status <thread-id> --json
t3 thread messages <thread-id> --json
t3 thread input list <thread-id> --json
t3 thread input respond <thread-id> <request-id> --answers-json '{"scope":"server"}' --json
t3 thread interrupt <thread-id> --json
t3 thread wait <thread-id> --json
t3 thread archive <thread-id> --json
```

Thread commands require a running T3 server; mutations travel over the same authenticated
connection the app uses. `thread new` creates a thread and starts its first agent turn. `thread send`
starts a new turn when the thread is idle and otherwise hands the message to the server, which steers
or queues it like the app does; sending to an archived thread unarchives it. `send` does not resolve a
question the agent asked. Use `thread input respond` for that.

Without `--title`, T3 generates the title from the first message, like the app. `--model` selects an
advertised provider model, with `--effort` and `--instance` to pick its effort option and provider
instance; without them the project's default model applies.

The project argument accepts either a project id or an exact workspace-root path. Thread mutation
commands intentionally require a thread id so automation cannot act on an ambiguous title. Inside a
T3 terminal or provider process, `self` names the owning thread (from `T3CODE_THREAD_ID`).

Thread list and status JSON summaries contain `id`, `projectId`, `title`, `state` (`idle`,
`running`, `interrupted`, `completed`, or `error`, from the latest turn), `branch`, `worktreePath`,
`sessionStatus`, `activeTurnId`, `backgroundLiveness`, the snooze fields, `pinnedAt`,
`customGroupId`, `settled`, `settledAt`, `hasPendingApprovals`, `hasPendingUserInput`,
`hasPendingBlockingUserInput`, `latestUserMessageAt`, `updatedAt`, `archiveRequest`, and
`worktreeSwitch`. Turn ids are the server's run ids.

- **Snooze.** `snoozedUntil`, `snoozedAt`, and `snoozedUntilTurnId` hold the stored snooze request,
  all `null` when nothing was requested. An indefinite snooze ("until I wake it") carries a
  `snoozedAt` with a `null` `snoozedUntil`, and a snooze until the work finishes ("until it's done")
  also carries the awaited turn in `snoozedUntilTurnId`. These fields stay set after a snooze wakes
  on its own; the `thread status` text line reports whether the thread is currently snoozed.
- **Settled.** `settled` is `true` when the thread is settled, by a person or by automatic
  settlement. `settledAt` is `null` when unsettled.
- **Background work.** `backgroundLiveness` is `"working"` for native subagents or workflows,
  `"monitoring"` when only watch loops remain, and `null` when no native background work is known.
- **Worktree moves.** `worktreeSwitch` is the latest agent-requested move or `null`. Its `status` is
  `pending`, `completed`, `cancelled`, or `error`; `detail` explains a cancellation or failure. While
  pending, `worktreePath` still names the current checkout. See
  [moving a Codex thread](thread-sidebar.md#move-a-codex-thread-to-a-worktree).

Snooze and settled are inbox overlays and do not change the thread's turn `state`.

### Groups and pins

`t3 group list` prints the custom thread groups in sidebar order, with Active's position marked by
an entry whose `id` is `null`, plus each group's count of unarchived threads. Group definitions come
from Settings, so the CLI lists the same groups as the app. `thread new --group` starts the thread in
a group, `thread move --group` moves an existing one, and `thread move --active` returns it to Active.
`--group` takes a group id or name. An exact name wins; otherwise the name may leave out emoji and
differ in spacing or case, so `Release & Marketing` finds `🔥 Release  &  🪜 Marketing`. When that
looser match fits more than one group, such as `Inbox` for both `📨 Inbox` and `📬 Inbox`, the
command fails and lists every candidate with its id.

`thread pin` places the thread at the top of the pinned threads, like pinning in the app, and
`thread unpin` removes it. Like pinning in the app, `thread pin` also brings a settled or snoozed
thread back. Both report `unchanged` when there is nothing to do. `thread list --pinned` lists pinned
threads in their pinned order. A `customGroupId` naming a deleted group shows in Active.

### Answering user input

List unresolved questions before answering one:

```bash
t3 thread input list <thread-id> --json
t3 thread input respond <thread-id> <request-id> \
  --answers-json '{"scope":"server","checks":["lint","tests"]}' \
  --json
```

The list result is `{ "threadId", "requests" }`. Each request has `id`, `responseMode`
(`"blocking"` or `"message"`), `createdAt`, and `questions`. Each question has `id`, `header`,
`prompt`, `allowCustomAnswer`, `multiSelect`, and `options`; each option has `id`, `label`, and
`description`. Use question ids as the answer-map keys. Use option ids as values, an array of option
ids for a multi-select question, or a custom string when the question allows one.

`thread input respond` requires the complete answer map and only answers a pending question; it
refuses approvals and requests that are no longer pending. A question may disappear when its turn
ends. A successful JSON result has `threadId`, `requestId`, `commandId`, and `sequence`. Its `action`
is `"response-requested"`. The sequence is the mutation acknowledgement and can be passed to `thread
wait --after-sequence`.

Message-mode questions (Codex) do not pause the active turn. Answer them with `thread input respond`
too; a plain `thread send` leaves the question unresolved.

### Reading messages

`t3 thread messages <thread-id>` prints the conversation as a transcript, user and assistant
messages only, without tool calls or file activity. `--json` returns a document with `threadId`,
`title`, `state`, `archived`, `machine`, `messages`, `hasMoreOlder`, and `nextBefore`; each message
carries its id, role, text, `createdAt` timestamp, turn id, and attachment metadata, plus
`streaming: true` while the assistant is still writing it. Messages with inline context also include
the optional `context` object. Unlike the other thread commands, this one also reads archived
threads; the output marks those with `"archived": true` and a `null` title and state. Messages a
forked thread inherited from its parent are included, as the app shows them.

The default is the full history, paged from the server internally. `--limit N` returns only the
newest N messages; when older ones remain, the JSON sets `hasMoreOlder` and provides a `nextBefore`
cursor to pass as `--before` on the next call. A `--before` value that is not such a cursor fails
with an explicit cursor error rather than printing an empty transcript. `--role
user|assistant|system|reasoning` narrows to one role; system notices and the agent's thinking only
appear when requested that way. The `--limit` window is counted before any role filtering, including
the default exclusion of system and thinking messages, so a filtered result can contain fewer than N
messages, or none, while older history still exists.

Attachments are files on the machine that runs the server. Each one resolves to an absolute `path`
on that machine plus an `exists` flag (`path` is `null` in the rare case the record cannot be
resolved to a file location), and the output names the machine itself: `machine.hostname`, with the
environment id and label when the server reports them. When you run this command over SSH on
another machine, the paths belong to that host, not yours. Fetch the files over SSH rather than
concluding they are missing.

### Archiving after a turn

Ask an agent to archive its thread when it finishes. Agents with T3's MCP tools can use
`archive_thread`, optionally setting `removeWorktree: true` when you also request cleanup.
`archive_thread_status` inspects the request and `cancel_thread_archive` cancels it before
archiving starts. A pending request means the archive is scheduled; the agent must finish its
response before it can run.

The CLI supports the same workflow:

```bash
t3 thread archive self --after-turn --remove-worktree --json
```

An explicit thread ID works too, including another running thread. The request waits for the
turn that is running when the server accepts it, including its final checkpoint, and for background
work that holds the turn open. Idle threads archive immediately unless background work is still
running. Archiving is refused while queued messages are waiting to run. Requests survive server
restarts, and cancel if the turn fails or is stopped, new work starts, or the thread's workspace
changes. There is no turn-ID argument.

`--remove-worktree` is optional. Cleanup stops the provider session and closes the thread's
terminals before removing the worktree. It preserves the branch and refuses dirty or locked
worktrees, detached worktrees, and worktrees containing a project root, another unarchived
thread's checkout, or its pending move destination. A worktree that can never qualify is refused
up front, and the thread stays unarchived. A later cleanup failure leaves the worktree in place and
records the error on the archive request. The thread may already be archived.

Inspect progress or cancel before archiving starts:

```bash
t3 thread archive <thread-id> --status --json
t3 thread archive <thread-id> --cancel --json
```

Status works after the thread is archived. Thread list and status summaries include
`archiveRequest`, with its selected turn, request ID, status, and any failure detail.

Provider processes receive `T3CODE_THREAD_ID`, `T3CODE_WORKTREE_PATH`, `T3CODE_HOME`, and
`T3CODE_STATE_DIR` for their owning thread and environment. The worktree variable contains the
effective working directory, including the project checkout when no worktree is selected.
`self` resolves from `T3CODE_THREAD_ID`; outside a provider process or T3 terminal, pass a thread ID.
For a provider connected to an externally managed server, T3 cannot change that server's process
environment, so pass the explicit thread ID.

Turn ids change with every turn. Read current context when needed instead of inheriting a stale
turn ID:

```bash
t3 thread context self --json
eval "$(t3 thread context self --shell)"
```

The POSIX shell form exports all three context variables, including `T3CODE_TURN_ID`. That value
is empty while idle and is a snapshot of the turn at command time. Refresh it for each turn.

### Waiting for turns

`t3 thread wait <thread-id>` blocks until the thread's current turn settles. The default timeout is 30
minutes; change it with `--timeout 30s`, `--timeout 5m`, or another duration. This wait deadline is
separate from `--timeout-ms`, which controls each live-server read. The wait follows the server's
live updates rather than polling, and reconnects if the connection drops. The command is suitable for
shell composition:

```bash
t3 thread wait "$thread_id" && run-the-next-step
```

When a script starts or steers a turn, anchor the wait to the dispatch sequence returned by that
mutation. This prevents an older, idle-looking state from satisfying the wait before the new turn is
visible:

```bash
seq=$(t3 thread send "$thread_id" --message "Run the checks" --json | jq .sequence)
t3 thread wait "$thread_id" --after-sequence "$seq"
```

A turn counts as settled only once nothing is running, finalizing, or queued on the thread. Use
`--turn <turn-id>` to wait for one specific turn. If another turn becomes latest first, the wait
returns `superseded` with exit code 0. By default a pending approval or blocking question returns
immediately as outcome `blocked`; `--on-blocked wait` keeps waiting instead. A message-mode question
does not end the wait while its turn is active.

After the turn settles, `--drain` (equivalent to `--drain=agents`) also waits for native subagents and
workflows. `--drain=all` additionally waits for monitoring/watch loops. Background work is what the
server tracks for the thread; detached external processes are invisible to it and cannot be drained,
so keep a finite `--timeout`.

A successful wait means the observed turn settled, not that every external artifact or filesystem
flush is durable. Check the artifact itself when later automation requires that stronger guarantee.

Terminal outcomes use these exit codes:

| Outcome                                                              | Exit code |
| -------------------------------------------------------------------- | --------: |
| `completed`, `idle`, or `superseded`                                 |         0 |
| `timeout`                                                            |         2 |
| `error`                                                              |         3 |
| `interrupted`                                                        |         4 |
| `blocked`                                                            |         5 |
| Thread archived or deleted during the wait (`vanished`)              |         6 |
| Transport, authentication, initial not-found, or other command error |         1 |
| SIGINT                                                               |       130 |

`--exit-zero` collapses observed terminal outcomes 2–6 to exit code 0; it does not hide transport,
authentication, or parsing failures. If the server stops during the wait, the command fails with
`"outcome": "unknown"`; if reconnecting keeps failing for 30 seconds, it fails with
`ThreadCliWaitConnectionError`. JSON extends the normal thread summary with `outcome`, `waited`,
`waitedMs`, `observedSequence`, and `turn` (`turnId`, `state`, `requestedAt`, `startedAt`,
`completedAt`) for the latest turn. A timeout retains the last observed thread state and background
liveness so callers can distinguish active work from stale or wedged state.

### Permissions and Isolation

`thread new` accepts `--runtime-mode` (`approval-required`, `auto-accept-edits`, `auto`,
`full-access`) and `--interaction-mode` (`default`, `plan`). Runtime mode inherits the project's
effective setting, falling back to the environment setting. Interaction mode defaults to `default`.
With `--runtime-mode full-access`, the agent edits files and runs commands without asking for
approval. Pass `--runtime-mode approval-required` for unattended automation you do not fully trust.
`--runtime-mode auto` is provider-specific: Codex sends on-request approvals to its AI reviewer,
Claude uses Claude Code's native Auto permission mode, and providers without Auto support continue
prompting the user. It is not equivalent to full access and is not suitable for fully unattended
runs. `thread send` uses the thread's current runtime and interaction modes and cannot change them.

### Workspaces

Without a workspace flag, `thread new` honors the same default environment mode as the app's
new-thread flow: the per-project setting, then the environment setting, then the repository's
checked-in `t3.json` (`defaultThreadEnvMode`), then the built-in checkout default. When nothing
selects worktrees, the thread runs directly in the project workspace root, so concurrent CLI threads
on the same project share one working tree. When the default resolves to worktree mode, `thread new`
behaves like `--new-worktree` below and also honors the "start new worktrees from origin" setting.
Explicit flags always win over the configured defaults:

- `--checkout` forces the plain project checkout even when the configured default is a worktree.
- `--new-worktree` asks the server to create a fresh git worktree for the thread (running the
  project's setup action, the same as "New worktree" in the app). `--base <ref>` picks the base ref
  (default: the project checkout's current branch), `--branch <name>` names the new branch
  (default: a temporary name that is renamed from the thread title), and `--start-from-origin` bases
  the worktree on `origin/<base>` instead of the local ref. The command returns once the worktree
  exists. If preparation fails it reports `ThreadCliLaunchError` with reason `preparation-failed`;
  after 3 minutes without a worktree it reports `preparation-pending`, and the thread keeps
  preparing on the server.
- `--worktree <path>` starts the thread in an existing worktree at that path (see
  `git worktree list`). The path must exist on the server machine, is canonicalized, and must be a
  worktree of the project's repository; the worktree's checked-out branch is recorded on the thread
  automatically, and an explicit `--branch <ref>` fails the command when it does not match.

A launch the server rejects removes the thread it may already have created, so a rejection means
nothing was left behind.

For an existing **No project** project, use its workspace root with `--project` and
`--checkout`. The server assigns each thread a separate plain folder; JSON reports
`workspace.mode: "scratch"`, a null branch, and the folder in `worktreePath`. It is not a Git
worktree, and archiving or deleting the thread keeps its files. The CLI still requires `--project`.

`thread new --json` returns `threadId`, `projectId`, `createCommandId`, `commandId`, `messageId`,
`sequence`, `group`, and a `workspace` object (`mode` plus `branch` and `worktreePath`, both `null`
for the plain checkout).

## Session import

```bash
t3 session candidates --project /absolute/path/to/repository --json
t3 session candidates --project /absolute/path/to/repository --cwd /absolute/path/to/worktree --json
t3 session import --file /path/to/transcript.jsonl --project /absolute/path/to/repository --json
t3 session import --file /path/to/transcript.jsonl --project /absolute/path/to/repository --worktree-branch feature/example --title "Continue the task" --json
```

Session commands require a running T3 server. `candidates` lists local Claude and Codex sessions for
the selected project or validated worktree. Sessions already attached to a T3 Code thread are listed
rather than hidden, whether that thread came from an earlier import or was created inside T3 Code at
the selected workspace root. Human output appends `linked:<thread-id>` and `(archived)` when
applicable. The JSON is `{ "projectId", "candidates" }`; every candidate includes `instanceId`,
`provider`, `providerDisplayName`, `nativeSessionId`, `name`, `preview`, `messageCount`, and
`updatedAt`. `linkedThread` is `null` for an unlinked session; otherwise it contains `threadId`,
`title`, `archivedAt`, the owning thread's `updatedAt`, and `canFork`. Older servers may omit
`linkedThread`; treat absence as `null`.

`import` reads the provider and native session identity from the transcript itself, so a Claude
file renamed in transit still imports. It places the file in the provider instance's home for the
target workspace, never overwriting a different existing file, and creates a T3 thread that resumes
the native session. A Codex rollout's recorded working directory is rewritten to the workspace it
is imported into; mentions in message text stay untouched. `--project` also accepts the path of an
existing git repository that is not a project yet; it is added first. `--worktree-branch` uses or
creates T3's standard worktree for an existing local branch (it never fetches) without running setup
scripts. Model, effort, provider instance, and title can be overridden with the corresponding flags;
otherwise the model comes from the transcript when the instance advertises it.

The JSON result has `threadId`, `action: "imported"`, `projectId`, `instanceId`, `nativeSessionId`,
`placedPath`, and, when they apply, `worktreePath`, `retargetedCwdFields`, and `warnings`. History
past the import cap is trimmed to the most recent messages with a `history-truncated` warning; the
provider keeps the full transcript. Running the same import again is safe: it reports
`{ "threadId", "action": "already-imported" }` for the existing thread.

Importing a linked candidate as a fork, which copies its latest history into a fresh provider
session, is done from the app's import dialog; `t3 session import` has no fork flag.

## Environment Status

```bash
t3 status --json
```

Status reports whether the selected local server is running, its origin and process id, project and
thread counts, running-thread count, and pending approval or user-input counts. With no server it
prints `{ "running": false }` and exits `0`.

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
