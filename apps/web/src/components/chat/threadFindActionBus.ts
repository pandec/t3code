import type { ThreadPaneId } from "../thread-split/threadSplitStore";

const THREAD_FIND_OPEN_EVENT = "t3:thread-find-open";

/**
 * Fork: the event is window-wide, so it names the split pane whose thread
 * should open find. Without a target, only the active pane reacts.
 */
export function requestThreadFindOpen(paneId?: ThreadPaneId): void {
  window.dispatchEvent(new CustomEvent(THREAD_FIND_OPEN_EVENT, { detail: paneId }));
}

export function subscribeThreadFindOpen(
  listener: (paneId: ThreadPaneId | undefined) => void,
): () => void {
  const handle = (event: Event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
    listener(detail === "primary" || detail === "secondary" ? detail : undefined);
  };
  window.addEventListener(THREAD_FIND_OPEN_EVENT, handle);
  return () => window.removeEventListener(THREAD_FIND_OPEN_EVENT, handle);
}
