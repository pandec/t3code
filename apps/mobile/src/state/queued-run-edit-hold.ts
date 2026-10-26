/**
 * Holds each queued message open on the server while it is edited so it cannot start or be
 * steered mid-edit. Holds follow the thread-keyed edit records, not a screen; each is renewed
 * while open and released when it ends, and the server lets it lapse if the app is suspended.
 */
import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { QUEUED_RUN_EDIT_HOLD_RENEW_MS } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { uuidv4 } from "../lib/uuid";
import { queuedRunEditsAtom } from "./queued-run-edit";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

export function useQueuedRunEditHolds(): void {
  const edits = useAtomValue(queuedRunEditsAtom);
  const hold = useAtomCommand(threadEnvironment.holdQueuedRunForEdit, {
    reportFailure: false,
    reportDefect: false,
  });
  const active = useRef(new Map<string, () => void>());

  // oxlint-disable-next-line t3code/react-effect-budget -- holds and renews server-side edit leases as edits begin and end
  useEffect(() => {
    const wanted = new Map<string, () => () => void>();
    for (const [threadKey, edit] of Object.entries(edits)) {
      const thread = parseScopedThreadKey(threadKey);
      if (thread === null) continue;
      wanted.set(`${threadKey}\u0000${edit.runId}`, () => {
        // One lease per edit, so another client's release cannot drop it.
        const holderId = uuidv4();
        const send = (held: boolean) =>
          void hold({
            environmentId: thread.environmentId,
            input: { threadId: thread.threadId, runId: edit.runId, held, holderId },
          });
        send(true);
        const renew = setInterval(() => send(true), QUEUED_RUN_EDIT_HOLD_RENEW_MS);
        return () => {
          clearInterval(renew);
          send(false);
        };
      });
    }
    // Only edits that began or ended change their hold; a release followed by
    // a re-hold would let the queue start the message in between.
    for (const [key, stop] of active.current) {
      if (wanted.has(key)) continue;
      stop();
      active.current.delete(key);
    }
    for (const [key, start] of wanted) {
      if (!active.current.has(key)) active.current.set(key, start());
    }
  }, [edits, hold]);

  // oxlint-disable-next-line t3code/react-effect-budget -- releases every held lease on unmount
  useEffect(() => {
    const holds = active.current;
    return () => {
      for (const stop of holds.values()) stop();
      holds.clear();
    };
  }, []);
}
