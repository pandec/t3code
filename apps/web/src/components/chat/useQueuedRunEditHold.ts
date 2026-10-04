import {
  QUEUED_RUN_EDIT_HOLD_RENEW_MS,
  type EnvironmentId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { useEffect } from "react";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Holds the queued message open in the composer on the server so it cannot
 * start or be steered mid-edit. The hold is renewed while the edit stays open
 * and released when it ends (saved, cancelled, or the run left the queue);
 * the server lets it lapse on its own if this client goes away.
 */
export function useQueuedRunEditHold(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  runId: RunId | null,
): void {
  const hold = useAtomCommand(threadEnvironment.holdQueuedRunForEdit, {
    reportFailure: false,
    reportDefect: false,
  });
  useEffect(() => {
    if (threadId === null || runId === null) return;
    const send = (held: boolean) => void hold({ environmentId, input: { threadId, runId, held } });
    send(true);
    const renew = window.setInterval(() => send(true), QUEUED_RUN_EDIT_HOLD_RENEW_MS);
    return () => {
      window.clearInterval(renew);
      send(false);
    };
  }, [environmentId, hold, runId, threadId]);
}
