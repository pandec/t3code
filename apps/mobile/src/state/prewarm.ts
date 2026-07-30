import { useAtomValue } from "@effect/atom-react";
import {
  advanceThreadStreamingSnapshot,
  createEnvironmentThreadPrewarmAtoms,
  createThreadPrewarmSummaryAtom,
  didEnvironmentPrewarmRunsAdvance,
  seedThreadStreamingSnapshot,
  ThreadPrewarmTriggers,
  type ThreadPrewarmSummary,
  type ThreadPrewarmTriggerRequest,
  type ThreadStreamingSnapshot,
} from "@t3tools/client-runtime/state/threads";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";
import { useThreadShells } from "./entities";

export const environmentThreadPrewarm = createEnvironmentThreadPrewarmAtoms(connectionAtomRuntime);

export const threadPrewarmSummaryAtom = createThreadPrewarmSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  statusAtom: environmentThreadPrewarm.statusAtom,
});

export const threadPrewarmTriggerCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "thread-prewarm.trigger",
  execute: (request: ThreadPrewarmTriggerRequest) =>
    ThreadPrewarmTriggers.pipe(Effect.flatMap((triggers) => triggers.fire(request))),
});

export function useThreadPrewarmSummary(): ThreadPrewarmSummary {
  return useAtomValue(threadPrewarmSummaryAtom);
}

export { didEnvironmentPrewarmRunsAdvance };
export type { ThreadPrewarmSummary };

/**
 * Keeps the per-environment thread prewarm streams mounted for as long as the
 * caller stays mounted, and fires a targeted rewarm whenever a thread's
 * session leaves the streaming states — so a conversation that just finished
 * is re-cached while the app sits on the thread list. Mirrors the web
 * turn-completion snapshot/diff pattern; the first observation seeds silently.
 */
export function useThreadPrewarm(): void {
  useAtomValue(threadPrewarmSummaryAtom);
  const threadShells = useThreadShells();
  const fireTrigger = useAtomCommand(threadPrewarmTriggerCommand, { reportFailure: false });
  const snapshotRef = useRef<ThreadStreamingSnapshot | null>(null);

  useEffect(() => {
    if (snapshotRef.current === null) {
      snapshotRef.current = seedThreadStreamingSnapshot(threadShells);
      return;
    }
    const { snapshot, settled } = advanceThreadStreamingSnapshot(snapshotRef.current, threadShells);
    snapshotRef.current = snapshot;
    for (const thread of settled) {
      void fireTrigger({ reason: "thread-settled", ...thread });
    }
  }, [fireTrigger, threadShells]);
}
