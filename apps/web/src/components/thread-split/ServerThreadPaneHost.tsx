import { useEffect, useState } from "react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import ChatView from "../ChatView";
import { Button } from "~/components/ui/button";
import { openCommandPalette } from "../../commandPaletteBus";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../../state/entities";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { resolveThreadRouteRenderState } from "../../threadRoutes";
import { resolveThreadSyncPhase } from "../../threadSync";
import { useThreadSplitStore } from "./threadSplitStore";

/**
 * Mounts one server thread as a split pane. This mirrors the thread route's
 * loading rules with one deliberate difference: a missing or deleted thread
 * must never navigate the router (that would move the primary pane), so it
 * renders an in-pane unavailable state instead.
 */
export function ServerThreadPaneHost({ threadRef }: { threadRef: ScopedThreadRef }) {
  const threadPaneKey = scopedThreadKey(threadRef);
  const shell = useEnvironmentQuery(environmentShell.stateAtom(threadRef.environmentId));
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  const [detailLoad, setDetailLoad] = useState<{
    readonly threadPaneKey: string | null;
    readonly started: boolean;
  }>({ threadPaneKey: null, started: false });
  useEffect(() => {
    setDetailLoad((current) => {
      if (current.threadPaneKey !== threadPaneKey) {
        return { threadPaneKey, started: serverThreadStatus !== "empty" };
      }
      if (!current.started && serverThreadStatus !== "empty") {
        return { ...current, started: true };
      }
      return current;
    });
  }, [serverThreadStatus, threadPaneKey]);
  const detailLoadStarted = detailLoad.threadPaneKey === threadPaneKey && detailLoad.started;
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadDetailExists: serverThreadDetail !== null,
    serverThreadDetailUnavailable:
      serverThreadStatus === "deleted" || (detailLoadStarted && serverThreadStatus === "empty"),
    draftThreadExists: false,
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverThreadDetail !== null,
    shellExists: serverThreadShell !== null,
    status: serverThreadStatus,
  });

  const { isReady: environmentCatalogReady } = useEnvironments();
  const environment = useEnvironment(threadRef.environmentId);

  if (renderState === "missing" || (environmentCatalogReady && environment === null)) {
    return (
      <ThreadPaneNotice
        title="Thread unavailable"
        description="This thread was deleted or its environment is gone."
      />
    );
  }

  // The route can lean on the sidebar's connection indicators; this pane has
  // no chrome of its own, so a never-bootstrapping environment must say so
  // instead of staying blank forever.
  if (
    renderState === "loading" &&
    environment !== null &&
    environment.connection.phase !== "connected"
  ) {
    return (
      <ThreadPaneNotice
        title="Environment not connected"
        description={`Waiting for ${environment.label} to connect.`}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground">
      {renderState === "ready" || (renderState === "loading" && serverThreadShell !== null) ? (
        <ChatView
          key={threadPaneKey}
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="server"
          threadSyncPhase={threadSyncPhase}
          reserveTitleBarControlInset={false}
        />
      ) : null}
    </div>
  );
}

function ThreadPaneNotice({ title, description }: { title: string; description: string }) {
  const closeSplit = useThreadSplitStore((state) => state.closeSplit);
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-background p-6 text-center">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="max-w-64 text-sm text-muted-foreground">{description}</div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => openCommandPalette({ open: "open-in-split" })}
        >
          Choose thread...
        </Button>
        <Button size="sm" variant="ghost" onClick={closeSplit}>
          Close split
        </Button>
      </div>
    </div>
  );
}
