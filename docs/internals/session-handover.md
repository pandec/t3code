# Cross-machine session handover

Moving an in-progress Claude or Codex thread to another development machine, continued natively with
full history rather than through a summary. The same repositories live at the same home-relative paths
on each machine. Handover is agent-driven: the CLI provides the primitives, and the
`t3-session-handover` agent skill (in the owner's dotfiles) encodes the recipe. An in-app "Hand off to"
action does not exist.

## Key insight

T3 stores no provider transcript. A thread continues a native session through the provider thread's
`nativeThreadRef` (Claude session UUID or Codex thread id) in
`orchestration_v2_projection_provider_threads`. The conversation itself lives in the provider's home:

- Claude: `<claude home>/projects/<escaped-cwd>/<uuid>.jsonl`, where the escaped cwd is the absolute
  cwd with non-alphanumerics replaced by `-` (`claudeProjectDirectoryName` in
  `apps/server/src/provider/Drivers/ClaudeSessionImport.ts`).
- Codex: the rollout under `<codex home>/sessions/YYYY/MM/DD/`. Codex finds a rollout by filename scan
  without its state-DB entry, across version skew.

So **handover = transfer the provider file + session import on the target**
(`apps/server/src/sessionImport/SessionImportService.ts`). T3 database rows never move: they are
environment-scoped, and threads are environment-local.

Verified live (2026-07): transcripts copied unmodified resume natively on another OS, including tool
history and dirty trees. Tool records are inert history; nothing re-executes on resume. Only the Claude
_directory name_ must be translated for the target's absolute path. Codex is the exception for
content: it validates a thread's recorded `cwd` against the workspace it resumes in, so the CLI
rewrites recorded `cwd` fields (never message text) when it places a rollout.

## Constraints and traps

- **One-shot and directional.** Two machines resuming the same session id fork the transcript. T3
  enforces one owner per native session (a second import needs an explicit fork into a fresh native
  session); nothing stops `claude --resume` in a terminal on the source.
- **Session side state does not travel**: todos, rewind/file-history checkpoints, shell snapshots,
  background shells. Rewind cannot reach back before the handover.
- **Never blind-copy the Claude project directory.** The target usually has its own `memory/` for the
  same repository. Copy the session `.jsonl`; copy anything else only when missing.
- **Caps.** Display history is capped at `SESSION_IMPORT_MAX_MESSAGES` (5,000); past it the import
  keeps the newest messages with a `history-truncated` warning, and the provider keeps the full
  transcript. Transcripts over 256 MB are rejected, though native resume still works.
- **Parser strictness.** The Claude transcript parser fails on an unknown record type, so Claude Code
  version skew can break _import_ while native resume still works. Report it; don't paper over it.
- **Identity.** Claude identity comes from the records (one UUID `sessionId`), so a file renamed in
  transit imports and is placed under its record-derived name. Codex rollouts must keep their
  canonical `rollout-<timestamp>-<id>.jsonl` filename.
- **Idempotent retry.** Imported threads get the deterministic id `import:<instance>:<native-id>`
  (shared with the bulk agent-session importer). Placement skips an identical existing file and refuses
  a different one, and a repeated import reports `already-imported` with the existing thread id. A
  failed import needs no rollback: the placed transcript becomes an ordinary import candidate.
- **Strict resume.** Imported Codex sessions resume strictly (`StrictResume`); they are never silently
  replaced by a fresh native session.

## CLI surface

Documented for users in [CLI automation](../user/cli-automation.md#session-import).

- `t3 session import --file <transcript> --project <id-or-path> [--worktree-branch B] [--model M]
[--effort E] [--instance I] [--title T]` sniffs provider, session id, source cwd and last model from
  the file, picks the import-capable provider instance from `/api/providers/catalog`, places the file in
  that instance's home for the effective cwd, then calls `/api/session-import/import`. Path translation
  is the error-prone step, so code owns it. A repository path that is not a project yet is added first.
  `--worktree-branch` creates or reuses T3's standard worktree for an existing local branch; the CLI
  never fetches and does not run setup scripts. `--title` carries the T3 title across, since titles live
  in the database and never travel in a transcript.
- `t3 session candidates --project <id-or-path> [--cwd <worktree>]` lists importable sessions,
  including ones already linked to a thread.
- `t3 thread new --model M [--effort E] [--instance I]` starts a thread on a specific model.
- `t3 thread archive <thread-id>` retires the source thread after the target import succeeds.
- `t3 project list --json` resolves target projects through the running server.

## Division of labor

**The CLI moves conversations; the agent reproduces repository state.** The recipe:

1. Quiescence: check the thread state; interrupt a running turn only with the user's consent. Queued
   messages are T3 state and do not travel, so surface them first.
2. Git state: committed and pushed, or an ignore-aware, size-capped patch of tracked and
   untracked-not-ignored files, applied on the target only if it is clean and holds the base commit.
   Otherwise stop with an actionable message. No auto-stash, no WIP refs.
3. Make the branch's commit available on the target.
4. Locate the transcript on the source (provider thread ref → session id → file) and copy it.
5. Run `t3 session import` on the target.
6. Only after the import succeeds, archive the source thread.
7. On a cap or parser failure, report it: the session still resumes natively and can be imported after
   a T3 update.

Two worktree cases:

- **T3-managed worktree thread**: the thread's cwd is the worktree and the transcript is keyed to it;
  `--worktree-branch` recreates it and places the session under its path.
- **Thread in the main checkout, agent working in a self-made worktree**: everything is keyed to the
  main checkout, so import plainly and recreate the auxiliary worktree with ordinary git at the same
  relative path. The CLI does not parse conversation content to guess such worktrees.

## Decisions

| Decision                  | Choice                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Dirty tree                | Patch + clean target + has commit, else fail actionably; ignore-aware; size-capped               |
| Source thread fate        | Archive only after the target import succeeds; CLI resume on the source stays possible           |
| Direction                 | Direction-agnostic over SSH; both machines must be reachable at handover time                    |
| Mid-turn                  | Require quiescence; interrupt only with consent                                                  |
| Memory and side files     | Session file always; everything else copy-missing-only                                           |
| Caps and parser skew      | Trim past the message cap with a warning; fail clearly on parse errors or the byte cap           |
| Provider scope            | Claude and Codex only                                                                            |
| Missing project on target | Repository exists at the translated path: add the project. Repository missing: fail, no clone    |
| Handover note             | Tell the first resumed turn that the session was handed over and where the repo and worktree are |
