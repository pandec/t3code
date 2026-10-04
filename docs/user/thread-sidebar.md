# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from **New thread in...** in the command
palette, or press `mod+alt+n`. On mobile, pick **No project** from the project
list. To move a draft into a project, pick the project in the heading.

Each thread without a project works in its own folder under `~/.t3/scratch` (the
`scratch` folder of your T3 data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git project.

### Move a Codex thread to a worktree

Ask Codex to create a worktree and switch this thread to it. The agent requests the move with
`switch_worktree`. T3 Code waits for the current turn and its checkpoint, and for subagents or
monitors it left running, then updates the thread's checkout. Your next message continues the
same conversation in that directory.

The move stays pending during the current turn and survives a server restart. Ask the agent to
inspect or cancel it with `worktree_switch_status` or `cancel_worktree_switch`. A failed or
stopped turn cancels the move, as do a new message, archiving the thread, or changing its
checkout before the move applies. The target must be an existing checkout of the same
repository on the connected server; if it is gone when the move applies, the thread stays where
it is and the status explains why. To move back, ask the agent to switch to the project
checkout.

## Pin and reorder threads

Pin a thread from its menu or use the pin button that appears when you hover its row on web and
desktop. The filled button unpins it. `Cmd/Ctrl+Shift+P` toggles the open thread.

The **Pinned** and **Active** sections are collapsible and show their thread counts while folded.
T3 Code remembers the fold state on each device and keeps the open thread visible. Search shows
matching threads even when their section was folded. On web and desktop, unsent drafts appear in
their own **Drafts** section at the top of the sidebar, which folds the same way.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show
a notification with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position and any snooze that settling cleared ("until I
wake it" included). Settling stops the work an "until it's done" snooze waits on, so
Undo leaves that thread awake. If archiving left you on an empty new-thread screen, undo
can reopen the restored thread. It keeps another active conversation in place.
`mod+z` triggers the most recent Undo when no text field is focused; see
[Keybindings](./keybindings.md#commands-with-special-behavior). With **Archive
confirmation** on (Settings), every archive path (menus, command palette, shortcut) asks first.

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
During a drag, the other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; **Done** returns to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

On web and desktop, **Move current thread to top** in the command palette moves the open thread to
the top of Pinned, Active, or its custom group without dragging. It counts group members hidden by
a filter or a collapsed group, so the thread lands above all of them. The action is unavailable for
drafts and for archived, snoozed, or settled threads.

If dragging is unavailable for one environment, update the T3 Code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

To generate a fresh title from the conversation, open a thread's menu and choose
**Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

Agents connected through T3 Code can use the same server-owned metadata workflow to
rename a thread, regenerate its title, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

### Fold working threads (beta)

On web and desktop, turn on **Settings → General → Working section (beta)** to move threads that
are working or monitoring into a collapsed **Working** section at the bottom of the sidebar. A
thread returns to the top of the active list when it finishes, fails, or needs an approval or
answer. Pinned threads stay in the pinned section.

While this is on, the active list is ordered by when each thread last came back to you, so you
cannot drag to reorder it. Your saved order returns when you turn it off.

## Organize threads into custom groups

On web and desktop, open the command palette (`Cmd/Ctrl+K`) and choose **New thread group** or
**Manage thread groups** to create, rename, reorder, or remove groups. Settings → Extras → Sidebar
can add a **Thread groups** button to the sidebar toolbar for the same dialog. Each group gets its
own header next to **Active**; each folds on its own and keeps the open thread visible.

Drag a thread onto a group header or between its rows, use **Move current thread to group** in the
palette, or use **Move to group** from the thread menu. Cmd/Ctrl-click multiple threads, then use
**Move to group** from their context menu or **Move selected threads to group** in the palette to
move them together. Failed threads stay selected so you can retry. Each thread belongs to one
group. Removing a group keeps its threads and returns its active threads to Active.

New threads start in Active. Choose a group below the new-thread heading, or use **New thread in
group…** in the palette to pick the group and then the project. The choice is saved with the draft
until its first send. Forked threads join the source thread's group.

Groups can hold threads from any project or connected environment. Group definitions sync when a
web or mobile client is connected to the environments together. Each thread's group is saved on the
server that owns the conversation, so every device connected to it sees the same assignment.
Grouping threads requires an updated server.

A drag into a group saves the group, the thread state, and the order as separate steps. If the
connection drops partway, the finished steps stay saved; arrange the thread again to finish.

Pinned, snoozed, settled, and archived threads stay in their usual sections and remember their
group, so unpinning, waking, or reopening returns them to it. Grouped threads still auto-settle.

New groups start below Active. In the Thread groups dialog, drag a group across the Active divider,
or use the arrows, to place it above or below Active. Every connected client shows the same
arrangement.

Mobile shows the same groups. Use **Arrange threads** to drag between groups or back to Active.
**Move up** and **Move down** stay within the current group. Create and manage groups on web or
desktop.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the thread's
terminals that wait at an idle prompt, and keeps their output. A terminal that
runs a command, such as a dev server, stays open.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, queued messages, pending questions or approvals, and live
background work prevent automatic settlement. An open pull request does not prevent inactivity
settlement, but an old closed or merged pull request does not settle work you
resumed after it closed.

To disable automatic settlement for one thread, open its menu, choose **Auto-settle behavior**,
and pick **Disabled**. Pick **Enabled** to use the environment and project rules again.
Manual settle, snooze, and archive still work while automatic settlement is disabled.

Change these rules in **Settings → General** on web and desktop, or **Settings → Thread behavior**
on mobile. Select a project to override its rules. They continue to run when your apps are closed.
On web and desktop, choose an environment at the top to change only its rules, or
**All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Archive when done

Archiving a thread that is still working schedules the archive for when it is done. The thread
menus (and swipe-right on mobile), plus the command palette and the archive keybinding on web and
desktop, offer **Archive when done** while a turn runs. On any client, send
[`/t3-archive`](./composer.md#commands-and-skills) in the thread. An agent can also schedule
its own thread, for example when you ask it to "archive this thread when you're done". The
archive waits for the turn and its checkpoint, and for subagents or monitors it left running;
background commands such as dev servers do not hold it and stop when the thread archives. An
idle thread archives right away.

A thread with a pending archive shows an archive icon in its row. Choose **Cancel pending
archive** from its menu, use the archive keybinding again, or send `/t3-archive` again to keep
it. Sending a new message, stopping the turn it waits on, a
failed turn, or a workspace change also cancels it. If the turn's final checkpoint fails, the
thread stays unarchived and the archive status shows the error. A pending archive survives a
server restart.

You can also ask the agent to remove the thread's worktree when it archives. The branch is
always kept. Removal only happens when the worktree has no uncommitted or untracked changes, is
on a branch, is not a project's checkout, no other unarchived thread uses it, and no thread is
waiting to switch into it. If the
worktree can never qualify, the agent is told right away. If it is dirty when the thread
archives, the thread still archives, the worktree stays, and the agent can read the reason from
the archive status. Unarchiving the thread, or sending it a message, before removal finishes
keeps the worktree.

Sending a message to an archived thread unarchives it, then delivers the message.

## Find recently archived threads

The thread list ends with an **Archived** shelf of your most recently archived threads, folded
to a count by default. Expand it to open one: the thread shows that it is archived, and sending
a message or choosing **Unarchive** restores it. Unarchive a row directly, or delete it from its
context menu (long-press on mobile). **View all archived threads** opens the full archive in
Settings.

On web and desktop the shelf follows the sidebar's environment and project filters. On mobile it
hides while a search or filter is active. Set how many threads it shows with **Recent archived
threads** in **Settings → Extras** on web and desktop, or **Settings → Thread behavior** on
mobile.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

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

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
On web and desktop, press **Resume** in an empty composer to continue a limited
or interrupted turn manually.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. You can cancel it from the thread. Enable **Auto-resume limited
threads** in **Settings → General** on web and desktop, or **Settings → Thread
behavior** on mobile, to schedule limit stops by default.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Sending a new message, archiving, or settling the
thread prevents a pending continuation from starting.

Choose **Snooze until reset** to hide the thread until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the thread without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Enable **Snooze limited threads** in thread behavior settings to
snooze limit stops by default. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow work delegated to subagents.

When a turn ends while work it started keeps running, the thread list shows **Working** for live
subagents and workflows, and **Monitoring** when only watch loops remain, such as a dev server or a
monitor tailing checks. The conversation lists that work with a **Stop** button. Settling or
archiving the thread also stops it.

Subagent threads started by the agent can't take messages; message the parent
thread instead. When such a subagent needs an approval or an answer, the parent
thread asks for it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

## Identify environments

Development and Nightly environments can show artwork at the top of the sidebar and in the send
button. Choose **Artwork**, **Version pill**, or **None** under environment identification in
Settings. Packaged Dev builds are protected from development artwork. Custom themes use the version
pill because T3 Code cannot recolor their palette safely.

## Snooze until later

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.

On web and desktop, **Snooze → Until I wake it** snoozes without a timer. The thread stays in the
Snoozed section, after the timed snoozes, until you wake, pin, settle, or message it, or until it
needs attention: a question or approval, a failure, or the agent finishing its work. Automatic
settlement skips these threads.

While the agent is mid-turn or its subagents are still working, **Snooze → Until it's done** hides
the thread until that work finishes, including the agent's follow-up on the subagents' results. Watch
loops such as a running dev server or a monitor don't hold it. These threads sit at the top of the
Snoozed section and come back on their own, or earlier if they need attention. It's available on web,
desktop, and mobile when the server supports it.
