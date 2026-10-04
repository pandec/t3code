/**
 * Holds every queued message open for editing on the server, so it cannot
 * start or be steered mid-edit. Edits outlive the thread screen (they are
 * keyed by thread), so the holds follow the edit records rather than a
 * screen. Each hold is renewed while its edit stays open and released when it
 * ends; the server lets it lapse on its own if the app is suspended.
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

  useEffect(() => {
    const holds = active.current;
    return () => {
      for (const stop of holds.values()) stop();
      holds.clear();
    };
  }, []);
}
