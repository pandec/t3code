import { createContext, use } from "react";

import type { ThreadPaneId } from "./threadSplitStore";

/**
 * Which split pane the current subtree renders in. Everything defaults to
 * "primary" so the whole app behaves as before unless a subtree is explicitly
 * mounted as the secondary pane by SplitThreadLayout.
 */
export const ThreadPaneContext = createContext<ThreadPaneId>("primary");

export function useThreadPaneId(): ThreadPaneId {
  return use(ThreadPaneContext);
}
