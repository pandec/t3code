# T3 Code — pandec fork

This is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Everything about the base project — what T3 Code is, installation, documentation, and contributing — is covered by the [upstream README](https://github.com/pingdotgg/t3code#readme). This file only documents what the fork adds on top.

## Branches

- **`dev`** — the fork. All fork work lands here; this is the branch you want.
- **`main`** — a clean mirror of `pingdotgg/t3code`, deliberately kept free of fork commits so it can be fast-forwarded on every upstream sync. This README is the only file that differs from upstream. Synced `main` is merged into `dev` regularly.

## What the fork adds

### Conversations & threads

- **Conversation forking** — fork a Codex or Claude thread mid-conversation into a new thread; forked threads are titled with a 🔱 prefix.
- **Session import** — import external Claude Code and Codex CLI sessions as native T3 threads, including strict resume/continuation and CLI-assigned session names in the import picker.
- **Archived-thread search & grouping** — archived chats are searchable and grouped by project, with repository identity persisted so grouping survives project changes.
- **Archive undo** — press Command+Z outside the composer after archiving to restore the latest thread; an empty new-thread screen reopens it, while another active conversation stays in place.
- **Message queueing** — sending while an agent turn runs queues the message by default instead of steering; a visible queue above the composer (web and mobile) lets each message be steered into the running turn, edited back into the composer, or deleted, and drains in order when the turn completes.
- **Composer thread commands** — `/t3-rename` (prefilled with the current title, on web and mobile) and `/t3-status` to set a thread's status emoji.
- **Thread naming & sidebar polish** — split thread naming with refined fork titles, and the thread's provider icon shown on sidebar hover.

### Voice

- **Voice dictation** — ElevenLabs-powered voice transcription in the composer, including mobile.
- **Message listening** — optional spoken versions of assistant messages with playback controls; per-turn summaries and speech artifacts are persisted, with mobile playback support.

### Agents & skills

- **Mobile agent steering** — steer an active agent turn directly from the mobile app.
- **Project-aware Codex skills** — Codex skill discovery respects the active project.
- **Claude skill picker** — the `$` composer skill picker discovers workspace skills for Claude.

### CLI & automation

- **`t3` CLI automation** — project and thread automation commands: manage projects and their actions by repository path, create and control threads, send and steer messages, and inspect server/project/thread status, with JSON output kept clean for scripting.

### Reliability

- Bounded catch-up for stale clients reconnecting to the server.
- The session reaper spares provider sessions that still have pending deliverables.
- Escalating desktop process termination and an interactive sidebar resize rail.

### Fork infrastructure

- **Dev app flavor** — a separate Dev flavor of the desktop app with isolated state directories (shared provider homes), a Linux Dev AppImage build, and personal-team iOS builds.
- **Upstream sync workflow** — a scripted `sync-upstream` flow that fast-forwards the `main` mirror from upstream, merges it into `dev`, and runs the required checks before pushing.
