# Cross-machine session handover

Moving an in-progress Claude or Codex thread to another development machine, continued natively with
full history rather than through a summary. The same repositories live at the same home-relative paths
on each machine. An in-app "Hand off to" action does not exist; handover is run by an agent in a T3
thread on the source machine, following the `t3-session-handover` skill in the owner's dotfiles.

## Key insight

T3 stores no provider transcript. A thread continues a native session through the provider thread's
`nativeThreadRef` (Claude session UUID or Codex thread id) in
`orchestration_v2_projection_provider_threads`. The conversation itself lives in the provider's home:

- Claude: `<claude home>/projects/<escaped-cwd>/<uuid>.jsonl`, where the escaped cwd is the absolute
  cwd with non-alphanumerics replaced by `-` (`claudeProjectDirectoryName` in
  `apps/server/src/provider/Drivers/ClaudeSessionImport.ts`).
- Codex: the rollout under `<codex home>/sessions/YYYY/MM/DD/`. Codex finds a rollout by filename scan
  without its state-DB entry, across version skew.

So **handover = copy the provider file + session import on the target**
(`apps/server/src/sessionImport/SessionImportService.ts`). T3 database rows never move: they are
environment-scoped, and threads are environment-local.

Verified live (2026-07): transcripts copied unmodified resume natively on another OS, including tool
history and dirty trees. Tool records are inert history; nothing re-executes on resume. Only the Claude
_directory name_ must be translated for the target's absolute path. Codex is the exception for
content: it validates a thread's recorded `cwd` against the workspace it resumes in, so recorded `cwd`
fields (never message text) must be rewritten to the target path when the rollout is placed.

## The flow

1. **Quiesce (source, MCP tools).** Check the thread's state; interrupt a running turn only with the
   user's consent. Queued messages are T3 state and do not travel, so surface them first.
2. **Move git state (SSH).** Committed and pushed, or an ignore-aware, size-capped patch of tracked and
   untracked-not-ignored files, applied on the target only if it is clean and holds the base commit.
   Otherwise stop with an actionable message. No auto-stash, no WIP refs.
3. **Copy the transcript (SSH).** Locate it on the source (provider thread ref → session id → file)
   and copy it into the target's provider home for the target cwd: the Claude file under the
   translated escaped-cwd directory, the Codex rollout with its `cwd` fields rewritten.
4. **Retire the source (MCP tools).** Rename the source thread to mark the handover, then archive it.
5. **Import (target, by the user).** The user opens the web Import dialog in the target project's
   settings and imports the session; it continues natively in the new thread.

The import dialog lists and imports sessions for the project checkout, so place the transcript keyed
to the checkout path even when the source thread ran in a T3-managed worktree; the imported thread
then works in the checkout. An agent-made auxiliary worktree is recreated with ordinary git at the
same relative path.

## Constraints and traps

- **One-shot and directional.** Two machines resuming the same session id fork the transcript. T3
  enforces one owner per native session (a second import needs an explicit fork into a fresh native
  session); nothing stops `claude --resume` in a terminal on the source.
- **Titles do not travel.** Titles live in the T3 database, never in a transcript; the imported thread
  takes the provider-derived title.
- **Session side state does not travel**: todos, rewind/file-history checkpoints, shell snapshots,
  background shells. Rewind cannot reach back before the handover.
- **Never blind-copy the Claude project directory.** The target usually has its own `memory/` for the
  same repository. Copy the session `.jsonl`; copy anything else only when missing.
- **Caps.** Display history is capped at `SESSION_IMPORT_MAX_MESSAGES` (5,000); past it the import
  keeps the newest messages with a `history-truncated` warning, and the provider keeps the full
  transcript. Transcripts over 256 MB are rejected, though native resume still works.
- **Parser strictness.** The Claude transcript parser fails on an unknown record type, so Claude Code
  version skew can break _import_ while native resume still works. Report it; don't paper over it.
- **Identity.** Claude identity comes from the records (one UUID `sessionId`), so keep the file named
  `<sessionId>.jsonl`. Codex rollouts must keep their canonical `rollout-<timestamp>-<id>.jsonl`
  filename.
- **Idempotent retry.** Imported threads get the deterministic id `import:<instance>:<native-id>`
  (shared with the bulk agent-session importer), and a repeated import reports `already-imported` with
  the existing thread id. A failed import needs no rollback: the placed transcript stays an ordinary
  import candidate.
- **Strict resume.** Imported Codex sessions resume strictly (`StrictResume`); they are never silently
  replaced by a fresh native session.
- **Provider scope.** Claude and Codex only. Both machines must be reachable over SSH at handover time.
