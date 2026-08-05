import type { SessionImportCandidate } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
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
import { Button } from "./ui/button";
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
  getSessionImportCandidateKey,
  getSessionImportProviderLabel,
} from "./SessionImportDialog.logic";
import { toastManager } from "./ui/toast";

export function SessionImportDialog(props: {
  readonly member: SidebarProjectGroupMember | null;
  readonly onClose: () => void;
}) {
  const { member, onClose } = props;
  const navigate = useNavigate();
  const [importingCandidateKey, setImportingCandidateKey] = useState<string | null>(null);
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
  // open so freshly imported/bound sessions disappear from the list.
  useEffect(() => {
    if (member !== null) {
      refreshCandidates();
    }
  }, [member, refreshCandidates]);

  const handleImport = async (candidate: SessionImportCandidate) => {
    if (member === null || importingCandidateKey !== null) {
      return;
    }
    setImportingCandidateKey(getSessionImportCandidateKey(candidate));
    try {
      const result = await importSession({
        environmentId: member.environmentId,
        input: {
          projectId: member.id,
          instanceId: candidate.instanceId,
          nativeSessionId: candidate.nativeSessionId,
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
      setImportingCandidateKey(null);
    }
  };

  return (
    <Dialog
      open={member !== null}
      onOpenChange={(open) => {
        if (!open && importingCandidateKey === null) {
          onClose();
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import CLI session</DialogTitle>
          <DialogDescription>
            {member !== null
              ? `Sessions found for ${member.workspaceRoot} that are not in T3 Code yet.`
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
          ) : candidates === undefined || candidates === null || candidates.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No importable sessions found for this project.
            </p>
          ) : (
            <ul className="max-h-80 space-y-1 overflow-y-auto">
              {candidates.map((candidate) => {
                const candidateKey = getSessionImportCandidateKey(candidate);
                const providerLabel = getSessionImportProviderLabel(
                  candidate,
                  ambiguousProviders.has(candidate.provider),
                );
                const isImporting = importingCandidateKey === candidateKey;
                return (
                  <li key={candidateKey}>
                    <button
                      type="button"
                      className="w-full rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-accent disabled:opacity-60"
                      disabled={importingCandidateKey !== null}
                      onClick={() => void handleImport(candidate)}
                    >
                      <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground" title={providerLabel}>
                          {providerLabel}
                        </span>
                        <span>
                          {candidate.messageCount !== null
                            ? `${candidate.messageCount} messages · `
                            : ""}
                          {formatRelativeTimeLabel(candidate.updatedAt)}
                        </span>
                      </span>
                      <span className="mt-1 block truncate text-sm">
                        {isImporting ? "Importing…" : (candidate.name ?? candidate.preview)}
                      </span>
                      {candidate.name !== null && !isImporting ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {candidate.preview}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={importingCandidateKey !== null} onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
