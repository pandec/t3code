import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { liveArchivedShellSnapshotAtom } from "../../lib/archivedThreadsState";
import { cn } from "~/lib/utils";
import { useThreadShell } from "../../state/entities";
import { environmentThreadShells, useThreadFamily } from "../../state/threads";
import { Badge } from "../ui/badge";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { useOpenThreadInPane } from "../thread-split/useOpenThreadInPane";
import type { LabAvailability, LabHealthTone, LabOwnerView, LabSummarySegment } from "./labs.logic";

const TONE_CLASS: Record<LabHealthTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-destructive",
  off: "bg-muted-foreground/40",
  busy: "bg-info",
};

/** A static health dot; busy states never pulse (no repainting animations). */
export function LabHealthDot({
  tone,
  className,
}: {
  readonly tone: LabHealthTone;
  readonly className?: string;
}) {
  return (
    <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE_CLASS[tone], className)} />
  );
}

const AVAILABILITY: Record<
  LabAvailability,
  { label: string; variant: "success" | "warning" | "info" | "outline" }
> = {
  free: { label: "Free", variant: "success" },
  held: { label: "Held", variant: "warning" },
  reserved: { label: "Reserved", variant: "info" },
  unavailable: { label: "Unavailable", variant: "outline" },
};

export function LiteLabBadge() {
  return (
    <Badge size="sm" variant="outline">
      Lite
    </Badge>
  );
}

export function LabAvailabilityBadge({ availability }: { readonly availability: LabAvailability }) {
  const { label, variant } = AVAILABILITY[availability];
  return (
    <Badge size="sm" variant={variant}>
      {label}
    </Badge>
  );
}

/**
 * Shells can leave idle subagent children out, so an owner missing from them may be a delegated
 * child rather than gone: mount its family before reading it as absent. Sticky per owner, since
 * the mounted rows put it back in the shell.
 */
function useLabOwnerFamily(environmentId: EnvironmentId, threadId: string | null): void {
  const shell = useThreadShell(
    threadId === null ? null : scopeThreadRef(environmentId, threadId as ThreadId),
  );
  const [familyThreadId, setFamilyThreadId] = useState<string | null>(null);
  if (threadId !== null && shell === null && familyThreadId !== threadId) {
    setFamilyThreadId(threadId);
  }
  useThreadFamily(
    environmentId,
    familyThreadId === threadId ? (threadId as ThreadId | null) : null,
  );
}

/** The owner thread, read from the cheap thread shells; null when it is not a T3 thread. */
export function useLabOwnerThread(environmentId: EnvironmentId, threadId: string | null) {
  useLabOwnerFamily(environmentId, threadId);
  return useThreadShell(
    threadId === null ? null : scopeThreadRef(environmentId, threadId as ThreadId),
  );
}

function toLabOwnerView(owner: EnvironmentThreadShell): LabOwnerView {
  // A guest's request outranks the run in the sidebar status, but the owner still works.
  const status = resolveSidebarThreadStatus({ ...owner, pendingGuestMessageCount: 0 });
  return {
    title: owner.title,
    working: status === "working" || status === "monitoring",
    needsYou:
      status === "approval" || status === "input" || (owner.pendingGuestMessageCount ?? 0) > 0,
    archived: owner.archivedAt !== null,
    // The latest run, not `updatedAt`: pull request syncs and settling bump that without work.
    lastActivityAt:
      owner.latestRun?.completedAt ??
      owner.latestRun?.startedAt ??
      owner.latestRun?.requestedAt ??
      null,
  };
}

function archivedOwnerShell(
  get: Atom.AtomContext,
  environmentId: EnvironmentId,
  threadId: string,
): EnvironmentThreadShell | null {
  const snapshot = Option.getOrNull(
    AsyncResult.value(get(liveArchivedShellSnapshotAtom(environmentId))),
  );
  const thread = snapshot?.threads.find((candidate) => candidate.id === threadId);
  return thread ? presentThreadShell(environmentId, thread) : null;
}

/** The owner as the summaries read it; null when the lease names no T3 thread. */
export function useLabOwnerView(
  environmentId: EnvironmentId,
  threadId: string | null,
): LabOwnerView | null {
  useLabOwnerFamily(environmentId, threadId);
  return useLabOwnerViews(environmentId, [threadId]).get(threadId ?? "") ?? null;
}

// Keyed by the environment and owner ids joined by newlines, which neither contains, so every
// caller asking for the same owners shares one atom.
const labOwnerViewsAtom = Atom.family((key: string) => {
  const [environmentId, ...ids] = key.split("\n") as [EnvironmentId, ...string[]];
  return Atom.make((get) => {
    const views = new Map<string, LabOwnerView>();
    for (const id of ids) {
      const shell =
        get(
          environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, id as ThreadId)),
        ) ?? archivedOwnerShell(get, environmentId, id);
      if (shell) views.set(id, toLabOwnerView(shell));
    }
    return views;
  });
});

/**
 * Owner views for many leases at once, keyed by thread id; one subscription per owner shell. An
 * owner missing from the active shell is looked up in the archive, which is fetched only then.
 * Owner families are mounted per row, by `LabSummarySentence` and the single-owner hooks.
 */
export function useLabOwnerViews(
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<string | null>,
): ReadonlyMap<string, LabOwnerView> {
  const ids = threadIds.filter((id): id is string => id !== null);
  return useAtomValue(labOwnerViewsAtom([environmentId, ...ids].join("\n")));
}

/**
 * An owner thread inside a sentence. Opens the thread like the sidebar does, without
 * activating whatever row or label it sits in.
 */
export function LabOwnerLink({
  environmentId,
  threadId,
  title,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly title: string;
  readonly onOpen?: () => void;
}) {
  const openThread = useOpenThreadInPane();
  return (
    <button
      type="button"
      className="inline cursor-pointer rounded-sm bg-info/10 px-1 text-left text-info-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openThread(scopeThreadRef(environmentId, threadId as ThreadId));
        onOpen?.();
      }}
    >
      {title}
    </button>
  );
}

/** A summary sentence, with the owner thread rendered as a link. */
export function LabSummarySentence({
  environmentId,
  threadId,
  segments,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string | null;
  readonly segments: ReadonlyArray<LabSummarySegment>;
}) {
  useLabOwnerFamily(environmentId, threadId);
  return (
    <>
      {segments.map((segment) =>
        typeof segment === "string" ? (
          <span key={`text:${segment}`}>{segment}</span>
        ) : threadId ? (
          <LabOwnerLink
            key="owner"
            environmentId={environmentId}
            threadId={threadId}
            title={segment.owner}
          />
        ) : (
          <span key="owner">{segment.owner}</span>
        ),
      )}
    </>
  );
}
