# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

On mobile, **New thread** starts in the current thread's project, or else in the
last project you opened or chose on that device. If neither is available, the
project picker opens. Turn off **Settings → General → Use last project** to
choose a project every time. When you pick a project that is on more than one
machine, the thread starts on a connected one if any is connected.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from **New thread in...** in the command
palette, or press `mod+alt+n`. On mobile, pick **No project** from the project
list. It starts on your current machine; before sending, pick another machine
from the machine menu to move it there. To move a draft into a project, pick the
project in the heading.

Each thread without a project works in its own folder under `~/.t3/scratch` (the
`scratch` folder of your T3 data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Option+Enter` on macOS or `Ctrl+Alt+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git project.

### Move a Codex thread to a worktree

Ask Codex to create a worktree and switch this thread to it. The agent requests the move with
`switch_worktree`. T3 Code waits for the current turn and its checkpoint, for subagents, and
for commands or monitors the agent waits on, then updates the thread's checkout. Your next message continues the
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
state, including its pinned position and any snooze that settling cleared. Settling stops
the work an "until it's done" snooze waits on, so Undo leaves that thread awake. Snoozing
or archiving the thread you are viewing returns you to the previous thread. Undoing the
archive reopens it while you are still there, or when archiving left you on an empty
new-thread screen; it keeps another active conversation in place.
Discarding an unsent draft from the sidebar works the same way: Undo brings back its
text and attachments. `mod+z` triggers the most recent Undo, even from the composer; see
[Keybindings](./keybindings.md#commands-with-special-behavior). With **Archive
confirmation** on (Settings), every archive path (menus, command palette, shortcut) asks first.

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinned threads don't settle automatically. Settling a thread removes its pin.

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
or **Settled** to drag a parked thread back into either live section. Each drop saves; close the sheet to return to the thread list.
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

To change how titles are written, add **Thread title instructions** in **Settings → Threads →
Text generation**, under Advanced, such as a length limit or an identifier to put first. They apply to new and
regenerated titles. Select a project to give it its own instructions.

Agents connected through T3 Code can use the same server-owned metadata workflow to
rename a thread, regenerate its title, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

### Fold working threads (beta)

Threads that are working or waiting on work they will resume from move into a collapsed
**Working** section below the active list.
That includes subagents, watched pull requests, and background commands or monitors the agent
says it is waiting on. A dev server or other process an agent leaves running does not keep a thread
there. A thread returns to the top of the active list when it finishes, fails, or needs an approval or
answer. The Working section lists the thread you last sent work to first. Pinned threads stay in
the pinned section.

This is on by default. Turn it off with **Settings → General → Working section** on web and desktop,
or **Settings → General → Working section** on iOS and Android. Each device keeps its own
choice.

While this is on, the active list is ordered by when each thread last came back to you, so you
cannot drag or move threads within it. Your saved order returns when you turn it off.

### Group threads by project (beta)

Turn on **Settings → Labs → Boring sidebar (group by project)** on web and desktop to put active
threads in a folder for each project. A project with no active threads has no folder until you
pick it in the project filter. Click a folder to open or close it. A closed folder shows how
many threads it holds, and a dot when one of them needs you. Use the pen button on a folder, or
right-click it, to start a thread in that project. Pinned threads stay above the folders, and
Snoozed and Settled stay below them. In this mode you cannot drag threads, and the Working section
is off. Custom thread groups do not show; their active threads appear in their project's folder.
Each device keeps its own choice.

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

To reclaim disk space from settled work, turn on **Run in the thread's worktree when the
thread settles** for one of the project's actions, or set `"runOnSettle": true` on a
`t3.json` script, for example `cargo clean`. It runs each time a thread in its own
worktree settles, manually or automatically, even if a terminal there still runs a
command such as a dev server. Threads in the project's main checkout skip it. Its terminal
closes when the command succeeds and stays open when it fails.

On web and desktop, press a thread's **Settle** button and drag up or down to
settle every thread in that section between it and the one you release on.
The **Un-settle** and **Wake** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. An empty thread's inactivity counts from when it was created.
Work in progress, queued messages, pending questions or approvals, and background work the
agent is waiting on prevent automatic settlement. An open pull request does not prevent inactivity
settlement unless you turn on **Keep threads with a PR** in **Settings → Threads**,
but an old closed or merged pull request does not settle work you
resumed after it closed. Only your own messages count as resuming. A turn that
finished background work or a pull request watch starts on its own does not.

To disable automatic settlement for one thread, open its menu, choose **Auto-settle behavior**,
and pick **Disabled**. Pick **Enabled** to use the environment and project rules again.
Manual settle, snooze, and archive still work while automatic settlement is disabled.

Change these rules in **Settings → Threads** on web and desktop, or **Settings → Threads**
on mobile. Select a project to override its rules. They continue to run when your apps are closed.
On web and desktop, choose an environment at the top to change only its rules, or
**All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Archive when done

Archiving a thread that is still working schedules the archive for when it is done. The thread
menus (and swipe-right on mobile), plus the row's hover archive button, the command palette and
the archive keybinding on web and desktop, offer **Archive when done** while a turn runs. On any client, send
[`/t3-archive`](./composer.md#commands-and-skills) in the thread. An agent can also schedule
its own thread, for example when you ask it to "archive this thread when you're done", or
another thread, such as one whose results it has just read. The
archive waits for the turn and its checkpoint, for subagents, and for commands or monitors the
agent waits on. Other background commands, such as dev servers, do not hold it and keep running
after the thread archives. An idle thread archives right away.

A thread with a pending archive shows an archive icon in its row. Choose **Cancel pending
archive** from its menu or hover archive button, use the archive keybinding again, or send `/t3-archive` again to keep
it. Sending a new message, stopping the turn it waits on, a
failed turn, or a workspace change also cancels it. Automatic follow-ups, such as subagent results
or background notifications that wake the thread, don't: the archive waits for them too. If the turn's final checkpoint fails, the
thread stays unarchived and the archive status shows the error. A pending archive survives a
server restart, and waits for a turn the server resumes after restarting.

On web and desktop, archiving the thread you have open takes you back to the thread you viewed
before it, the one `Ctrl+Tab` opens on desktop, or to a new thread when there is none. **Undo**
brings you back. An archive the agent requested or that was scheduled to run when the thread is
done leaves the thread on screen, so you can still read its final message.

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
Settings. Neither lists archived subagent threads.

On web and desktop the full archive groups threads the way the sidebar groups projects, so
checkouts of one repository share a section across environments, and it follows the Settings
scope: pick a project, checkout, or environment to narrow it. Search by thread title, project,
path, environment, or model; Command+F or Ctrl+F focuses the search.

On web and desktop the shelf follows the sidebar's environment and project filters. On mobile it
hides while a search or filter is active. Set how many threads it shows with **Recent archived
threads** in **Settings → Extras** on web and desktop, or **Settings → General** on
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
across connected environments by title, branch, pull request, or project.
Threads you open often or recently rank higher, and for three weeks the thread
you last picked for a query ranks higher when you type that query again.
Threads whose messages contain all your words appear below, under **In
messages**, and open at the matching message. Message search needs at least
one word of three or more letters, or two for Chinese, Japanese, and Korean.
On mobile, the thread list search also lists message matches and opens them at
the matching message; on an iPad with a keyboard, `Cmd+K` opens the same
palette.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise the thread itself, which pastes into a composer as
a thread chip. To copy the thread even when it has a PR, choose **Copy → Thread**
from its context menu, or **Copy thread** from its long-press menu on mobile.
**Thread ID** copies the bare ID for scripts and the `t3` CLI. See
[keybindings](./keybindings.md) for custom configuration.

## View two threads side by side

In a wide web or desktop window, choose **Open split view** in the thread header, or **Open
thread in split view…** in the command palette, to show a second thread beside the open one.
Threads you pick from the sidebar or the palette then open in the pane you are working in. Drag
the divider to resize the panes, or hover it to swap the threads, switch the second thread, or
close the split. `mod+\` moves focus to the other pane and `mod+shift+\` swaps the threads.
With no right-panel tab open, `mod+w` closes the active pane's thread and keeps the other one.
Snoozing a thread in either pane, or archiving it yourself, does the same.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
On web and desktop, press **Resume** in an empty composer to continue a limited
or interrupted turn manually.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. You can cancel it from the thread. Enable **Resume after
usage limits** in **Settings → Threads** to schedule limit stops by default.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Stopping the thread, sending a new message,
archiving, or settling it prevents a pending continuation from starting.

Choose **Snooze until reset** to hide the thread until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the thread without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Enable **Snooze until limits reset** in thread behavior settings to
snooze limit stops by default. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow work delegated to subagents.
On mobile, open a subagent from its conversation card or **Agents**. On iOS
layouts with an inspector, its thread opens beside the parent. Maximize it to
fill the screen; close the full-screen view to return to the parent and inspector.
Stop on a thread also stops the subagents it delegated to.

When a turn ends while work it started keeps running, the thread list shows **Working** for live
subagents and workflows, and **Monitoring** when only watch loops remain, such as a monitor tailing
checks, a pull request watch, or a command left running such as a test run or dev server. A command
or monitor still lets the thread complete and notify as usual unless the agent says it is waiting on
it. The conversation lists that work
with a **Stop** button. Settling or archiving the thread also stops it.

Subagent threads started by the agent can't take messages; message the parent
thread instead. When such a subagent needs an approval or an answer, the parent
thread asks for it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

On web and desktop, the thread details card lists the web servers that the
thread's terminals or its Claude agent started, with their ports. A server the
agent started stays listed after the agent's turn ends.
Select a server to open it in the browser panel. **Stop** ends the server's job
and keeps the agent, the terminal, and T3 Code running. Stop needs terminal
access to the environment and is not available on Windows.

## Identify environments

Development and Nightly environments can show artwork at the top of the sidebar and in the send
button. Under environment identification in Settings, choose the running channel's artwork, the
other channel's artwork, **Version pill**, or **None**. Packaged Dev builds show Dev artwork only
when you choose it. Custom themes use the version pill because T3 Code cannot recolor their palette
safely.

## Snooze until later

To change the choices in the snooze menu, open **Settings → Threads → Snooze options**.
Each option is a duration, such as 3 hours, or a time on a day, such as 9:00 PM
tomorrow. A weekday means the next one after today. Menus list the options soonest
first and hide a today option after its time passes. Saved with **All environments**
selected, the options apply to every connected environment, and the mobile app uses them too.

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.

A snoozed thread keeps working and stays hidden until its wake time, even while
its agent wakes itself for background work. It comes back early only when it needs
an approval or answer from you, when a run fails, or when you send it a message.

On web and desktop, snoozing the thread you have open takes you back to the thread you viewed
before it, the one `Ctrl+Tab` opens on desktop. If there is no such thread or it is snoozed too, a
snooze from the sidebar moves to the next thread in the list, and other snoozes keep you where you
are.

While the agent is mid-turn or its subagents are still working, **Snooze → Until it's done** hides
the thread until that work finishes, including the agent's follow-up on the subagents' results. Watch
loops such as a running dev server or a monitor don't hold it. These threads sit at the top of the
Snoozed section and come back on their own, or earlier if they need attention. It's available on web,
desktop, and mobile when the server supports it.

You can snooze a thread that has queued messages. **Until it's done** waits for the last queued
message to finish. Removing, reordering, editing, or resuming queued messages wakes the thread, as
sending a message does.
