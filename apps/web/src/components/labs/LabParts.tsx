import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { useThreadShell } from "../../state/entities";
import { Badge } from "../ui/badge";
import type { LabAvailability, LabHealthTone } from "./labs.logic";

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

export function LabAvailabilityBadge({ availability }: { readonly availability: LabAvailability }) {
  const { label, variant } = AVAILABILITY[availability];
  return (
    <Badge size="sm" variant={variant}>
      {label}
    </Badge>
  );
}

/** The owner thread, read from the cheap thread shells; null when it is not a T3 thread. */
export function useLabOwnerThread(environmentId: EnvironmentId, threadId: string | null) {
  return useThreadShell(
    threadId === null ? null : scopeThreadRef(environmentId, threadId as ThreadId),
  );
}

export function LabOwnerTitle({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string | null;
}) {
  const owner = useLabOwnerThread(environmentId, threadId);
  if (threadId === null) return <span className="text-muted-foreground">No owner thread</span>;
  return owner ? (
    <span className="min-w-0 truncate">{owner.title}</span>
  ) : (
    <span className="text-muted-foreground">Owner outside T3</span>
  );
}
