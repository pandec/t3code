# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Filtering by environment

When you are connected to more than one environment, a button beside the search box narrows the
thread list to the environments you pick. Choose any combination, or use **This environment only**
and **Remote environments only** for the two common cases. **All environments** clears the filter.
The button appears only when you have more than one environment to choose between.

Each row in the menu shows a status dot and how many threads that environment currently
contributes, and the machine you are using is marked as this device. Your selection is remembered
on this device until you change it.

A filtered environment that goes offline keeps its place in the filter rather than quietly
widening your view: the list tells you the environment is disconnected instead of reporting that
it has no threads, and its thread count is hidden while T3 Code cannot see it. An environment you
remove from your connections is reported as unavailable, so a temporary outage and a deliberate
removal never look alike.
