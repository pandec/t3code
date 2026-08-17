import type { SessionImportCandidate } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { SidebarProjectGroupMember } from "../sidebarProjectGrouping";
import { readThreadShell } from "../state/entities";
import { sessionImportEnvironment } from "../state/sessionImport";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import {
  getAmbiguousSessionImportProviders,
  getLinkedSessionsGroupLabel,
  getSessionImportCandidateKey,
  getSessionImportEmptyStateLabel,
  getSessionImportProviderLabel,
  isSessionImportFailureWithReason,
  partitionSessionImportCandidates,
} from "./SessionImportDialog.logic";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function SessionImportDialog(props: {
  readonly member: SidebarProjectGroupMember | null;
  readonly onClose: () => void;
}) {
  const { member, onClose } = props;
  const navigate = useNavigate();
  const [importing, setImporting] = useState<{ key: string; fork: boolean } | null>(null);
  const [linkedSectionOpen, setLinkedSectionOpen] = useState(false);
  const importSession = useAtomCommand(sessionImportEnvironment.importSession);

  const candidatesQuery = useEnvironmentQuery(
    member !== null
      ? sessionImportEnvironment.candidates({
          environmentId: member.environmentId,
          input: { projectId: member.id },
        })
      : null,
  );
  const candidates = candidatesQuery.data?.candidates;
  const ambiguousProviders = getAmbiguousSessionImportProviders(candidates ?? []);
  const hasAmbiguousProviders = ambiguousProviders.size > 0;
  const refreshCandidates = candidatesQuery.refresh;

  // The candidates query atom is cached per project; refresh on every dialog
  // open so freshly imported/bound sessions move to their linked state. The
  // linked section collapses again so the import flow stays front and center.
  useEffect(() => {
    if (member !== null) {
      refreshCandidates();
      setLinkedSectionOpen(false);
    }
  }, [member, refreshCandidates]);

  const handleOpenLinkedThread = async (candidate: SessionImportCandidate) => {
    if (
      member === null ||
      candidate.linkedThread === null ||
      candidate.linkedThread === undefined ||
      importing !== null
    ) {
      return;
    }
    // Archived threads render fine when navigated to directly: the thread
    // route subscribes to the thread detail, which the server serves for
    // archived threads too — only deleted threads hit the "/" redirect.
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(member.environmentId, candidate.linkedThread.threadId),
      ),
    });
    onClose();
  };

  const handleImport = async (candidate: SessionImportCandidate, options?: { fork: boolean }) => {
    if (member === null || importing !== null) {
      return;
    }
    const fork = options?.fork === true;
    setImporting({ key: getSessionImportCandidateKey(candidate), fork });
    try {
      const result = await importSession({
        environmentId: member.environmentId,
        input: {
          projectId: member.id,
          instanceId: candidate.instanceId,
          nativeSessionId: candidate.nativeSessionId,
          ...(fork ? { fork: true } : {}),
        },
      });
      if (result._tag === "Success") {
        // The thread route redirects to "/" when the thread is not yet in
        // client state; wait briefly for the shell push to land first.
        const threadRef = scopeThreadRef(member.environmentId, result.value.threadId);
        for (let attempt = 0; attempt < 40 && readThreadShell(threadRef) === null; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (readThreadShell(threadRef) === null) {
          toastManager.add({
            type: "warning",
            title: "Session imported",
            description:
              "The imported conversation is still syncing. It will appear in the project shortly.",
          });
          onClose();
          return;
        }
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
        onClose();
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        if (isSessionImportFailureWithReason(error, "already-imported")) {
          // Race: the session was bound to a thread after this list loaded.
          // Refresh so the row flips to its linked state with its actions.
          refreshCandidates();
          toastManager.add({
            type: "warning",
            title: "Session already in T3 Code",
            description:
              "A thread already continues this session. The list has been refreshed to show it.",
          });
          return;
        }
        toastManager.add({
          type: "error",
          title: "Failed to import session",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to import session",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setImporting(null);
    }
  };

  const groups = partitionSessionImportCandidates(candidates ?? []);
  const emptyStateLabel = getSessionImportEmptyStateLabel(groups);

  const renderCandidateSummary = (candidate: SessionImportCandidate, isImporting: boolean) => {
    const providerLabel = getSessionImportProviderLabel(
      candidate,
      ambiguousProviders.has(candidate.provider),
    );
    return (
      <>
        <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <Tooltip>
            <TooltipTrigger
              render={<span className="font-medium text-foreground">{providerLabel}</span>}
            />
            <TooltipPopup>{providerLabel}</TooltipPopup>
          </Tooltip>
          <span>
            {candidate.messageCount !== null ? `${candidate.messageCount} messages · ` : ""}
            {formatRelativeTimeLabel(candidate.updatedAt)}
          </span>
        </span>
        <span className="mt-1 block truncate text-sm">
          {isImporting ? "Importing…" : (candidate.name ?? candidate.preview)}
        </span>
        {candidate.name !== null && !isImporting ? (
          <span className="block truncate text-xs text-muted-foreground">{candidate.preview}</span>
        ) : null}
      </>
    );
  };

  return (
    <Dialog
      open={member !== null}
      onOpenChange={(open) => {
        if (!open && importing === null) {
          onClose();
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import CLI session</DialogTitle>
          <DialogDescription>
            {member !== null
              ? `Sessions found for ${member.workspaceRoot}, including ones already in T3 Code.`
              : "Import a session created outside T3 Code."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          {hasAmbiguousProviders ? (
            <p className="text-xs text-muted-foreground">
              More than one instance can import these sessions. Choose the instance to continue
              with.
            </p>
          ) : null}
          {candidatesQuery.isPending ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Scanning sessions…</p>
          ) : candidatesQuery.error !== null ? (
            <p className="py-6 text-center text-sm text-destructive">
              Failed to list sessions: {candidatesQuery.error}
            </p>
          ) : (
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {emptyStateLabel !== null ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{emptyStateLabel}</p>
              ) : (
                <ul className="space-y-1">
                  {groups.importable.map((candidate) => {
                    const candidateKey = getSessionImportCandidateKey(candidate);
                    const isImporting = importing?.key === candidateKey && !importing.fork;
                    return (
                      <li key={candidateKey}>
                        <button
                          type="button"
                          className="w-full rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-accent disabled:opacity-60"
                          disabled={importing !== null}
                          onClick={() => void handleImport(candidate)}
                        >
                          {renderCandidateSummary(candidate, isImporting)}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {groups.linked.length > 0 ? (
                <Collapsible open={linkedSectionOpen} onOpenChange={setLinkedSectionOpen}>
                  <CollapsibleTrigger className="group flex min-h-7 w-full items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                    {getLinkedSessionsGroupLabel(groups.linked.length)}
                    <ChevronRightIcon className="size-3.5 transition-transform duration-200 group-data-panel-open:rotate-90" />
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <ul className="space-y-1 pt-1">
                      {groups.linked.map((candidate) => {
                        if (
                          candidate.linkedThread === null ||
                          candidate.linkedThread === undefined
                        ) {
                          return null;
                        }
                        const candidateKey = getSessionImportCandidateKey(candidate);
                        const isForking = importing?.key === candidateKey && importing.fork;
                        return (
                          <li key={candidateKey}>
                            <div className="rounded-md border border-border px-3 py-2">
                              {renderCandidateSummary(candidate, false)}
                              <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                                <span className="shrink-0">In thread</span>
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <span className="min-w-0 truncate font-medium text-foreground">
                                        {candidate.linkedThread.title}
                                      </span>
                                    }
                                  />
                                  <TooltipPopup>{candidate.linkedThread.title}</TooltipPopup>
                                </Tooltip>
                                {candidate.linkedThread.archivedAt !== null ? (
                                  <Badge size="sm" variant="secondary">
                                    Archived
                                  </Badge>
                                ) : null}
                                <span className="shrink-0">
                                  · updated{" "}
                                  {formatRelativeTimeLabel(candidate.linkedThread.updatedAt)}
                                </span>
                              </span>
                              <span className="mt-2 flex items-center gap-2">
                                <Button
                                  size="sm"
                                  disabled={importing !== null}
                                  onClick={() => void handleOpenLinkedThread(candidate)}
                                >
                                  Open thread
                                </Button>
                                {candidate.linkedThread.canFork ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={importing !== null}
                                    onClick={() => void handleImport(candidate, { fork: true })}
                                  >
                                    {isForking ? "Importing as fork…" : "Import as fork"}
                                  </Button>
                                ) : null}
                              </span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </CollapsiblePanel>
                </Collapsible>
              ) : null}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={importing !== null} onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
