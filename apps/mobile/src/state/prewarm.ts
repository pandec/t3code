import { useAtomValue } from "@effect/atom-react";
import {
  advanceThreadActivitySnapshot,
  createEnvironmentThreadPrewarmAtoms,
  createThreadPrewarmSummaryAtom,
  didEnvironmentPrewarmRunsAdvance,
  seedThreadActivitySnapshot,
  ThreadPrewarmTriggers,
  type ThreadActivitySnapshot,
  type ThreadPrewarmSummary,
  type ThreadPrewarmTriggerRequest,
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
 * Keeps the per-environment prewarm streams mounted while the caller is
 * mounted, and fires a targeted missing-cache fill whenever a thread's run
 * finishes. The first observation seeds silently.
 */
export function useThreadPrewarm(): void {
  useAtomValue(threadPrewarmSummaryAtom);
  const threadShells = useThreadShells();
  const fireTrigger = useAtomCommand(threadPrewarmTriggerCommand, { reportFailure: false });
  const snapshotRef = useRef<ThreadActivitySnapshot | null>(null);

  useEffect(() => {
    if (snapshotRef.current === null) {
      snapshotRef.current = seedThreadActivitySnapshot(threadShells);
      return;
    }
    const { snapshot, settled } = advanceThreadActivitySnapshot(snapshotRef.current, threadShells);
    snapshotRef.current = snapshot;
    for (const thread of settled) {
      void fireTrigger({ reason: "thread-settled", ...thread });
    }
  }, [fireTrigger, threadShells]);
}
