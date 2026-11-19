import {
  QUEUED_RUN_EDIT_HOLD_RENEW_MS,
  type EnvironmentId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { randomUUID } from "~/lib/utils";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Holds the queued message on the server so it cannot start or be steered mid-edit; the lease
 * renews while the edit stays open, ends with it, and lapses if this client goes away. The
 * returned release ends it at once, for a command sent as the edit ends.
 */
export function useQueuedRunEditHold(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  runId: RunId | null,
): () => Promise<void> {
  const hold = useAtomCommand(threadEnvironment.holdQueuedRunForEdit, {
    reportFailure: false,
    reportDefect: false,
  });
  const leaseRef = useRef<{ readonly holderId: string; readonly renew: number } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds and renews the server edit lease
  useEffect(() => {
    if (threadId === null || runId === null) return;
    // One lease per edit session, so another client's release cannot drop it.
    const holderId = randomUUID();
    const send = (held: boolean) =>
      void hold({ environmentId, input: { threadId, runId, held, holderId } });
    send(true);
    const lease = {
      holderId,
      renew: window.setInterval(() => send(true), QUEUED_RUN_EDIT_HOLD_RENEW_MS),
    };
    leaseRef.current = lease;
    return () => {
      window.clearInterval(lease.renew);
      if (leaseRef.current !== lease) return;
      leaseRef.current = null;
      send(false);
    };
  }, [environmentId, hold, runId, threadId]);
  return async () => {
    const lease = leaseRef.current;
    if (lease === null || threadId === null || runId === null) return;
    leaseRef.current = null;
    window.clearInterval(lease.renew);
    await hold({
      environmentId,
      input: { threadId, runId, held: false, holderId: lease.holderId },
    });
  };
}
