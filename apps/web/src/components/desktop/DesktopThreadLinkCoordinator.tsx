import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { DesktopThreadLink, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

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
import { buildThreadRouteParams, resolveThreadRouteRef } from "../../threadRoutes";
import { openThreadInActivePane } from "../thread-split/threadOpenTarget";
import { toastManager } from "../ui/toast";

// Generous enough for a cold start, where the link waits for the backend and
// its first shell snapshot.
const THREAD_LIST_TIMEOUT_MS = 30_000;
const ARCHIVE_TIMEOUT_MS = 10_000;

function waitForThreadList(environmentId: EnvironmentId): Promise<boolean> {
  const atom = environmentShell.stateValueAtom(environmentId);
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const finish = (loaded: boolean) => {
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(loaded);
    };
    const timeout = setTimeout(() => finish(false), THREAD_LIST_TIMEOUT_MS);
    unsubscribe = appAtomRegistry.subscribe(atom, (state) => {
      if (state.snapshot._tag === "Some") finish(true);
    });
    if (appAtomRegistry.get(atom).snapshot._tag === "Some") finish(true);
  });
}

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

/** Opens threads from `<scheme>://app/<environmentId>/<threadId>` links the desktop shell forwards. */
export function DesktopThreadLinkCoordinator() {
  const router = useRouter();
  const threadLinks = window.desktopBridge?.threadLinks;
  const latestLinkRef = useRef(0);

  const openLink = useEffectEvent(async (link: DesktopThreadLink) => {
    const linkId = ++latestLinkRef.current;
    const resolution = await resolveDesktopThreadLink(link, {
      isKnownEnvironment: (environmentId) =>
        appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(environmentId)
          ?.enabled === true,
      primaryEnvironmentId: () => appAtomRegistry.get(primaryEnvironmentIdAtom),
      waitForThreadList,
      hasActiveThread: (threadRef) => readThreadShell(threadRef) !== null,
      hasArchivedThread,
    });
    // A newer link supersedes this one while it was still resolving.
    if (linkId !== latestLinkRef.current) return;
    if (resolution.kind !== "open") {
      toastManager.add({
        type: "error",
        title: "Couldn't open thread link",
        description: FAILURE_DESCRIPTIONS[resolution.kind],
      });
      return;
    }
    const matches = router.state.matches;
    const { threadRef } = resolution;
    openThreadInActivePane({
      targetRef: threadRef,
      routeThreadRef: resolveThreadRouteRef(matches[matches.length - 1]?.params ?? {}),
      navigateToPrimary: () =>
        router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        }),
    });
  });

  useEffect(() => {
    if (threadLinks === undefined) return;
    const unsubscribe = threadLinks.onOpen((link) => void openLink(link));
    void threadLinks.setReady(true).catch(() => undefined);
    return () => {
      void threadLinks.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [threadLinks]);

  return null;
}
