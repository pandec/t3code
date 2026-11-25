import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import {
  type DesktopThreadLinkResolution,
  resolveDesktopThreadLink,
} from "../../desktopThreadLink";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { environmentShell } from "../../state/shell";
import { toastManager } from "../ui/toast";

// Generous enough for a cold start, where the link waits for the backend and
// the environment's first synchronization.
const LIST_TIMEOUT_MS = 30_000;
const ARCHIVE_TIMEOUT_MS = 10_000;

/** Resolves false when the atom does not reach the state in time. */
function waitFor<A>(atom: Atom.Atom<A>, reached: (value: A) => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const finish = (done: boolean) => {
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(done);
    };
    const timeout = setTimeout(() => finish(false), LIST_TIMEOUT_MS);
    unsubscribe = appAtomRegistry.subscribe(atom, (value) => {
      if (reached(value)) finish(true);
    });
    if (reached(appAtomRegistry.get(atom))) finish(true);
  });
}

// A cached snapshot can predate threads created or unarchived elsewhere, so wait until it is live.
const waitForThreadList = (environmentId: EnvironmentId) =>
  waitFor(environmentShell.stateValueAtom(environmentId), (state) => state.status === "live");

async function hasArchivedThread(threadRef: ScopedThreadRef): Promise<boolean | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    orchestrationEnvironment.archivedShellSnapshot({
      environmentId: threadRef.environmentId,
      input: {},
    }),
    {
      label: "thread link archived lookup",
      reportFailure: false,
      refresh: true,
      signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
    },
  ).catch(() => null);
  if (result?._tag !== "Success") return null;
  return result.value.threads.some((thread) => thread.id === threadRef.threadId);
}

const FAILURE_DESCRIPTIONS: Record<Exclude<DesktopThreadLinkResolution["kind"], "open">, string> = {
  "environment-not-found": "The link's environment isn't connected to this app.",
  "environment-unavailable": "The link's environment isn't reachable right now.",
  "thread-not-found": "The thread doesn't exist or was deleted.",
};

/**
 * Fork: the thread a desktop link names, active or archived, with `primary` standing in for the
 * primary environment. Shows a short error and resolves null when there is no such thread.
 */
export async function resolveLinkedThread(
  environmentId: string,
  threadId: string,
): Promise<ScopedThreadRef | null> {
  // Until the catalog loads, every environment (and the primary alias) reads as unknown.
  await waitFor(environmentCatalog.catalogValueAtom, (catalog) => catalog.isReady);
  const resolution = await resolveDesktopThreadLink(
    { environmentId, threadId },
    {
      isKnownEnvironment: (id) =>
        appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(id)?.enabled === true,
      primaryEnvironmentId: () => appAtomRegistry.get(primaryEnvironmentIdAtom),
      waitForThreadList,
      hasActiveThread: (threadRef) => readThreadShell(threadRef) !== null,
      hasArchivedThread,
    },
  );
  if (resolution.kind === "open") return resolution.threadRef;
  toastManager.add({
    type: "error",
    title: "Couldn't open thread link",
    description: FAILURE_DESCRIPTIONS[resolution.kind],
  });
  return null;
}
