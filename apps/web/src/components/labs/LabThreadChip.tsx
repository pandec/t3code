import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { GitBranchIcon, ScrollTextIcon } from "lucide-react";

import { useRightPanelStore } from "../../rightPanelStore";
import { useLabsInventory, useLabsSnapshot } from "../../state/labs";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { LabReservationActions, LabStackActions, useLabCommands } from "./LabActions";
import { LabHealthDot } from "./LabParts";
import { findLabForWorktree, resolveLabStackHealth } from "./labs.logic";

/**
 * Fork (SP Labs): the header chip of a lab thread. The cheap inventory decides whether the thread
 * is a lab thread; only then does the chip read the live snapshot.
 */
export function LabThreadChip({
  threadRef,
  worktreePath,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly worktreePath: string | null;
}) {
  const inventory = useLabsInventory(worktreePath ? threadRef.environmentId : null);
  const lab =
    inventory?.configured === true
      ? findLabForWorktree(inventory.environments, worktreePath)
      : null;
  if (!lab) return null;
  return <LiveLabChip threadRef={threadRef} labId={lab.id} name={lab.name} />;
}

function LiveLabChip({
  threadRef,
  labId,
  name,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly labId: string;
  readonly name: string;
}) {
  const environmentId: EnvironmentId = threadRef.environmentId;
  const snapshot = useLabsSnapshot(environmentId);
  const commands = useLabCommands(environmentId);
  const environment = snapshot.data?.environments.find((candidate) => candidate.id === labId);
  const t3 = snapshot.data?.t3[labId];
  const health = environment
    ? resolveLabStackHealth(environment, t3)
    : { tone: "off" as const, label: snapshot.error ?? "Loading" };

  return (
    <Popover>
      <PopoverTrigger
        render={<Button size="xs" variant="ghost-muted" aria-label={`${name}: ${health.label}`} />}
      >
        <LabHealthDot tone={health.tone} />
        {name}
      </PopoverTrigger>
      <PopoverPopup width="md" padding="compact" align="end">
        <div className="flex flex-col gap-2 text-xs">
          <div className="flex items-center gap-2">
            <LabHealthDot tone={health.tone} />
            <span className="font-medium text-sm">{name}</span>
            <span className="text-muted-foreground">{health.label}</span>
          </div>
          {environment?.runtime.git ? (
            <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <GitBranchIcon className="size-3 shrink-0" />
              <span className="min-w-0 truncate font-mono">{environment.runtime.git.branch}</span>
              {environment.runtime.git.dirty ? (
                <span className="text-warning-foreground">· uncommitted changes</span>
              ) : null}
            </div>
          ) : null}
          {t3?.lastUp && !t3.lastUp.ok ? (
            <p className="text-destructive-foreground">
              Start failed: {t3.lastUp.detail ?? "unknown error"}
            </p>
          ) : null}
          {environment ? (
            <>
              <LabStackActions environment={environment} t3={t3} commands={commands} />
              <LabReservationActions
                environmentId={environmentId}
                environment={environment}
                t3={t3}
                commands={commands}
              />
            </>
          ) : null}
          <Button
            size="xs"
            variant="ghost-muted"
            className="self-start"
            onClick={() => useRightPanelStore.getState().open(threadRef, "labs")}
          >
            <ScrollTextIcon />
            Logs and history in the Labs panel
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
