# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes need a separate
branch and working directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model and mode
selections, unless the destination project has its own model default. Its branch and workspace mode
come from your configured defaults. To continue in an existing worktree, use **New thread in this
worktree** from the branch toolbar.

When you change a new thread's project, T3 Code stays in the current environment if that project
exists there. Otherwise it selects an environment that has it.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and
Linux to start a new thread and immediately open another draft. The next draft keeps the workspace
mode and base branch you selected. With **New worktree**, each background submission creates its own
worktree.

Rows for background work still show **Working** or **Monitoring**, but recede when they are not
selected. The colored status remains visible while the sidebar gives more prominence to work that
needs your attention.

## Pin and reorder threads

Pin a thread from its menu or use the pin button that appears when you hover its row on web and
desktop. The filled button unpins it. `Cmd/Ctrl+Shift+P` toggles the open thread. Drag pinned threads
to reorder them on web and desktop, or use **Move up** and **Move down** on mobile. The order syncs
across devices.

The **Pinned** section is collapsible and shows its thread count while folded. T3 Code remembers the
fold state on each device. Search and the Attention filter show matching pinned threads even when
the section was folded.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

## Snooze or promote active work

Choose **Snooze** to hide a thread until a preset time. **Until I wake it** snoozes without a timer
on supported environments. A snoozed thread returns when its timer expires, you wake it, or it needs
attention.

Choose **Move to top** for an active, unpinned thread. This changes its sidebar position without
changing conversation timestamps. The action is unavailable for pinned, snoozed, or settled
threads and on environments that need a server update.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list without deleting
the conversation. **Un-settle thread** restores it to the top of active work and prevents automatic
settlement until new activity resumes the usual rules.

**Settings → Extras → Sidebar → Auto-settle threads** is the master switch. Turn it off to stop
automatic settlement while keeping manual settlement available. **Settings → General** controls
settlement after inactivity and pull request merges.

By default, environments settle inactive threads after three days and settle threads whose pull
request merged. A closed pull request can also settle an idle thread. Work in progress, pending
questions or approvals, and live background work prevent automatic settlement. An open pull request
does not prevent inactivity settlement, but an old closed or merged pull request does not settle
work you resumed after it closed.

These rules continue to run when your apps are closed. Changes apply to connected environments that
support shared settings. Offline environments and older servers keep their previous values. If
connected environments disagree, **Apply to all** copies your current settings to those named in
the warning. Changing a rule does not reopen already settled threads.

## Link a pull request

On web and desktop, right-click a pull request link in a thread and choose **Link to thread**. Use
**Unlink from thread** on the same link to remove it. The linked pull request participates in
automatic settlement.

## Fold older threads

Enable **Older section** under **Settings → Extras → Sidebar** on web and desktop, or
**Settings → General** on mobile. It groups quiet active threads below current work without
settling, snoozing, or archiving them.

The default threshold is seven days and can be set from one day to one year. Pinned, snoozed,
settled, running, monitoring, and attention-needed threads stay in their normal sections. Activity
moves an older thread back into the active list. You can choose whether the section starts folded,
and T3 Code remembers later fold changes on each device.

## Filter threads

Use the project menu beside search to show selected projects or hide projects from the list. The
project filter stays active while you navigate between threads and other app views. Use **Clear
project filter** to return to all projects.

When more than one environment is connected, use the environment filter beside search to select any
combination. Shortcuts select this environment only, remote environments only, or all environments.
The selection is remembered on the device until you change it. Thread rows and unsent drafts follow
the filter.

A selected environment that stops responding remains in the filter and is marked disconnected. An
environment removed from Connections is marked unavailable. T3 Code does not silently widen the
filter or show either state as an empty environment.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads across connected
environments. Message search starts after two characters and includes your messages and final agent
responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files and copying a
thread reference. A copied reference uses the thread's pull request link when available, otherwise
its thread ID. See [keybindings](./keybindings.md) for custom configuration.

## Inspect agent work

On web and desktop, use **Agents** to follow work delegated to subagents.

Expand a tool call in the conversation to see its full command and output. Summaries shorten shell
wrappers and can still describe the latest call after it finishes. The call's own result shows its
status.

## Identify environments

Development and Nightly environments can show artwork at the top of the sidebar and in the send
button. Choose **Artwork**, **Version pill**, or **None** under environment identification in
Settings. Packaged Dev builds are protected from development artwork. Custom themes use the version
pill because T3 Code cannot recolor their palette safely.

## Regenerate a thread title

Open a thread's menu and choose **Regenerate title** to generate a new title from its conversation.
The action reads **Regenerating…** while it runs and cannot be selected again. It is hidden when the
connected environment needs a server update.
