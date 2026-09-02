# Organizing threads

Pin a thread from its context menu, or from the pin button that appears when you hover its card on
web and desktop, to keep it in the pinned section above your active work. The same button, filled
while the thread is pinned, unpins it again. `mod+shift+p` pins or unpins the thread you have
open. Pinned threads are shown independently of their project, including when you connect to more
than one environment.

To require confirmation before unpinning, enable **Settings → General → Unpin confirmation**. The
confirmation applies to the sidebar controls, thread menus, and the `mod+shift+p` shortcut.

The pinned section folds behind its **Pinned** header like the other sections, with a count while
it is folded. It starts unfolded, and folding it is remembered per device. The thread you have
open keeps its row even while the section is folded, and while the Attention filter is on or you
are searching, the fold steps aside entirely — both have already narrowed the list to what you
asked to see, and a pinned match should never sit behind a fold.

Pinned threads still move to **Settled** when they become inactive or their pull request closes or
merges. Settling and pinning are mutually exclusive, so un-settling returns the thread to the active
list rather than restoring its old pinned position.

Each server stores its own copy of the automatic settlement settings and checks them even when no
web, desktop, or mobile client is connected. **Settings → Extras → Sidebar → Auto-settle threads**
is the master switch. **Settings → General** controls settlement after inactivity and pull request
merges. Turning the master switch off keeps manual settlement available.

Changing any of these settings writes the change to every environment you are connected to at that
moment. An environment that is offline keeps its old value. When a connected environment holds a
different value, **Settings > General** shows a warning that names it. Choose **Apply to all** to
write your current values to every connected environment. The same applies to the new-thread
workspace mode and the source control writing style.

Settings saved by older clients on one device no longer control this behavior.

By default, the server settles threads after three days without activity and when their pull request
merges. An eligible idle thread also settles when its pull request closes. An open pull request blocks
inactivity settlement. Active work, pending input, and live background work keep the thread active.
A closed or merged pull request settles a thread only when its timestamp is not older than the user's
latest activity. If that timestamp is unavailable, the inactivity rule still applies. Changing the
settings affects future settlement and does not reopen a settled thread.

When you un-settle a thread, it returns to the top of the active list. Its conversation and timestamps
do not change, and other threads keep their positions.

Right-click a pull request link in a thread and choose **Link to thread** to show that pull request
in the sidebar. The thread settles when the linked pull request merges if **Auto-settle merged
threads** is enabled. Right-click the same link and choose **Unlink from thread** to remove it.

## Snoozing and moving active threads

Choose **Snooze** from a thread's menu to hide it until a preset time. On environments that support
indefinite snooze, **Until I wake it** hides the thread without a timer. Snoozed threads stay in their
own section. They return when the timer expires, when you wake them manually, or when the thread
raises its hand for attention.

Choose **Move to top** for an active, unpinned thread to place it above the other active work. This
changes its sidebar position without changing its conversation timestamps. The action is hidden for
pinned, snoozed, or settled threads and on environments that need a server update.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Folding away older threads

Some threads are worth keeping around without being worth looking at today. Turn on **Older
section** — Settings → Extras → Sidebar on web and desktop, Settings → General on mobile — and the
thread list files anything that has gone quiet into a foldable **Older** section below your live
threads, with a count on the header while it is folded.

Quiet means no messages and no agent turns for longer than the window you set — seven days by
default, anywhere from one day to a year. Nothing is settled, snoozed, or archived on your behalf:
an Older thread is an ordinary active thread that happens to be grouped, and it returns to the list
the moment you message it or un-settle it (or move it to the top, on servers that support that).
Pinned, snoozed, and settled threads stay in their own sections and are never filed here.

Live and waiting work is never folded away, however long it has been sitting there: a thread with a
running session, background work still going after its turn, an approval or input request, or a
plan waiting on your decision stays in the list. So does a thread that has just come back from a
snooze — waking it puts it in front of you, which is the whole point. While the Attention filter is
on, or while you are searching, the section steps aside entirely: both have already narrowed the
list to what you asked to see, and a search match should never sit behind a fold.

The section starts folded; a second setting starts it unfolded instead. Whichever you choose, once
you fold or unfold the section yourself that choice wins, remembered per device on every client.
The thread you have open keeps its row even while the section is folded, so it never disappears
out from under you.

The window and the choices around it are set per device: mobile keeps its own copy of these
settings rather than following the ones on your desktop.

## Filtering by environment

When you are connected to more than one environment, a button beside the search box narrows the
thread list to the environments you pick. Choose any combination, or use **This environment only**
and **Remote environments only** for the two common cases. **All environments** clears the filter.
The button appears once you have more than one environment to choose between, and stays put while
a filter is active so you can always clear one.

Each row in the menu shows a status dot and how many threads that environment currently
contributes, and the machine you are using is marked as this device. Your selection is remembered
on this device until you change it.

Threads and unsent drafts follow your selection. The recently archived section hides itself while
a filter is active — as it already does when you filter by project — and comes back when you
return to all environments.

A filtered environment that stops responding keeps its place in the filter rather than quietly
widening your view: the list says T3 Code is not connected to it instead of reporting that it has
no threads, and its thread count is hidden while T3 Code cannot see it. An environment you remove
from your connections is reported as unavailable instead, so a temporary outage and a deliberate
removal never look alike.

## Environment artwork

Development-build and Nightly environments can identify themselves with artwork at the top of the
sidebar and in the send button. Packaged Dev builds remain protected from development artwork.
Choose **Artwork**, **Version pill**, or **None** in Settings under environment identification.
Artwork is recolored to match each built-in theme; custom themes use the **Version pill** fallback
because their colors are not controlled by T3 Code.

## Regenerating a thread title

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
