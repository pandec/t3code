import { setForegroundThreadEventPriority } from "@t3tools/client-runtime/state/threads";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";

export const foregroundThreadEventPriorityCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "thread-event-priority.foreground",
  concurrency: { mode: "latest", key: () => "foreground-thread" },
  execute: (threadRef: ScopedThreadRef | null) => setForegroundThreadEventPriority(threadRef),
});

export function useForegroundThreadEventPriority(threadRef: ScopedThreadRef | null): void {
  const setForeground = useAtomCommand(foregroundThreadEventPriorityCommand, {
    reportFailure: false,
  });

  useEffect(() => {
    void setForeground(threadRef);
  }, [setForeground, threadRef]);
}
