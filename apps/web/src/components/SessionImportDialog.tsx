import type { SessionImportCandidate } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { SidebarProjectGroupMember } from "../sidebarProjectGrouping";
import { sessionImportEnvironment } from "../state/sessionImport";
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
import { toastManager } from "./ui/toast";

function providerLabel(candidate: SessionImportCandidate): string {
  if (candidate.providerDisplayName !== candidate.provider) {
    return candidate.providerDisplayName;
  }
  switch (candidate.provider) {
    case "claudeAgent":
      return "Claude Code";
    case "codex":
      return "Codex";
    default:
      return candidate.provider;
  }
}

export function SessionImportDialog(props: {
  readonly member: SidebarProjectGroupMember | null;
  readonly onClose: () => void;
}) {
  const { member, onClose } = props;
  const navigate = useNavigate();
  const [importingSessionId, setImportingSessionId] = useState<string | null>(null);
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
  const refreshCandidates = candidatesQuery.refresh;

  // The candidates query atom is cached per project; refresh on every dialog
  // open so freshly imported/bound sessions disappear from the list.
  useEffect(() => {
    if (member !== null) {
      refreshCandidates();
    }
  }, [member, refreshCandidates]);

  const handleImport = async (candidate: SessionImportCandidate) => {
    if (member === null || importingSessionId !== null) {
      return;
    }
    setImportingSessionId(candidate.nativeSessionId);
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
        onClose();
        await navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: member.environmentId,
            threadId: result.value.threadId,
          },
        });
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
      setImportingSessionId(null);
    }
  };

  return (
    <Dialog
      open={member !== null}
      onOpenChange={(open) => {
        if (!open) {
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
        <DialogPanel className="space-y-1">
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
              {candidates.map((candidate) => (
                <li key={`${candidate.instanceId}:${candidate.nativeSessionId}`}>
                  <button
                    type="button"
                    className="w-full rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-accent disabled:opacity-60"
                    disabled={importingSessionId !== null}
                    onClick={() => void handleImport(candidate)}
                  >
                    <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {providerLabel(candidate)}
                      </span>
                      <span>
                        {candidate.messageCount !== null
                          ? `${candidate.messageCount} messages · `
                          : ""}
                        {formatRelativeTimeLabel(candidate.updatedAt)}
                      </span>
                    </span>
                    <span className="mt-1 block truncate text-sm">
                      {importingSessionId === candidate.nativeSessionId
                        ? "Importing…"
                        : candidate.preview}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
