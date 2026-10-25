import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type LabAction,
  type LabEnvironment,
  type LabT3State,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  AppWindowIcon,
  FlaskConicalIcon,
  LockIcon,
  LockOpenIcon,
  LogOutIcon,
  MessageSquareIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SquareIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { ensureLocalApi } from "../../localApi";
import { newCommandId, newMessageId } from "../../lib/utils";
import { labsEnvironment } from "../../state/labs";
import { enqueueThreadSubmission } from "../../state/threadOutbox";
import { useAtomCommand } from "../../state/use-atom-command";
import { DEFAULT_DRAFT_LAB_INTENT } from "../../composerDraftStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useLabOwnerThread } from "./LabParts";
import {
  buildLabWrapUpMessage,
  describeReleaseBlocker,
  isLabStackRunning,
  releaseCanStopFirst,
  resolveLabAvailability,
} from "./labs.logic";

function errorMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The sp-labs command failed.";
}

const ACTION_TITLES: Record<LabAction, string> = {
  up: "Start",
  "restart-wxt": "Restart WXT",
  down: "Stop",
  reload: "Reload",
  browser: "Focus browser",
  sidepanel: "Open side panel",
  hold: "Hold",
  unhold: "Unhold",
};

/**
 * Fork (SP Labs): the commands the Labs panel and the lab chip share. Each resolves when sp-labs
 * finishes; the live snapshot shows the running operation meanwhile.
 */
export function useLabCommands(environmentId: EnvironmentId) {
  const runAction = useAtomCommand(labsEnvironment.action, { reportFailure: false });
  const runRelease = useAtomCommand(labsEnvironment.release, { reportFailure: false });
  const canOperate = useAtomValue(labsEnvironment.action.permissionAtom(environmentId));

  const action = async (
    environment: Pick<LabEnvironment, "id" | "name">,
    kind: LabAction,
    note?: string,
  ) => {
    const result = await runAction({
      environmentId,
      input: { envId: environment.id, action: kind, ...(note === undefined ? {} : { note }) },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `${ACTION_TITLES[kind]} failed in ${environment.name}`,
        description: errorMessage(result),
      });
      return;
    }
    if (!result.value.ok) {
      toastManager.add({
        type: "warning",
        title: `${environment.name} started with problems`,
        description: result.value.detail ?? "The extension check failed.",
      });
    }
  };

  /** Releases without a handoff note; a running stack can be stopped first, other blockers show. */
  const release = async (environment: Pick<LabEnvironment, "id" | "name">) => {
    const attempt = async (stopFirst: boolean) => {
      const result = await runRelease({
        environmentId,
        input: { labId: environment.id, stopFirst },
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: `Could not release ${environment.name}`,
          description: errorMessage(result),
        });
        return;
      }
      if (result.value.status === "released") {
        toastManager.add({ type: "success", title: `Released ${environment.name}` });
        return;
      }
      const blockers = result.value.blockers;
      if (!stopFirst && releaseCanStopFirst(blockers)) {
        const confirmed = await ensureLocalApi().dialogs.confirm(
          `Stop ${environment.name}'s stack and release it?\nIts dev stack is still running.`,
        );
        if (confirmed) await attempt(true);
        return;
      }
      toastManager.add({
        type: "warning",
        title: `${environment.name} was not released`,
        description: blockers.map(describeReleaseBlocker).join("\n"),
      });
    };
    await attempt(false);
  };

  /** A normal, visible message to the owner thread; the outbox delivers it like any send. */
  const askOwnerToRelease = (
    environment: Pick<LabEnvironment, "id" | "name">,
    ownerThreadId: string,
  ) => {
    const queued = enqueueThreadSubmission({
      environmentId,
      threadId: ThreadId.make(ownerThreadId),
      commandId: newCommandId(),
      messageId: newMessageId(),
      text: buildLabWrapUpMessage(environment.id),
      attachments: [],
      dispatchMode: "queue",
      createdAt: new Date().toISOString(),
    });
    toastManager.add(
      queued
        ? { type: "success", title: `Asked the agent to wrap up ${environment.name}` }
        : { type: "error", title: "Could not send the message" },
    );
  };

  return { action, release, askOwnerToRelease, canOperate };
}

export type LabCommands = ReturnType<typeof useLabCommands>;

/** Stack commands wait for permission and for the lab's running operation to finish. */
export function isLabBusy(commands: LabCommands, t3: LabT3State | undefined): boolean {
  return !commands.canOperate || t3?.operation != null;
}

/** A tooltip naming the action, then what it does in one line. */
export function LabActionTooltip({
  label,
  description,
}: {
  readonly label: string;
  readonly description: string;
}) {
  return (
    <TooltipPopup>
      <span className="flex max-w-64 flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        <span>{description}</span>
      </span>
    </TooltipPopup>
  );
}

/**
 * A small action that never stretches to fill its row. `compact` shows only the icon (the header
 * chip); the label then lives in the aria-label and the tooltip.
 */
function ActionButton({
  label,
  tooltip,
  icon: Icon,
  disabled,
  variant = "outline",
  compact,
  onClick,
}: {
  readonly label: string;
  readonly tooltip: string;
  readonly icon: typeof PlayIcon;
  readonly disabled?: boolean;
  readonly variant?: "outline" | "default" | "destructive";
  readonly compact: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size={compact ? "icon-xs" : "xs"}
            variant={variant}
            disabled={disabled}
            aria-label={compact ? label : undefined}
            onClick={onClick}
          />
        }
      >
        <Icon />
        {compact ? null : label}
      </TooltipTrigger>
      <LabActionTooltip label={label} description={tooltip} />
    </Tooltip>
  );
}

function HoldButton({
  environment,
  disabled,
  compact,
  commands,
}: {
  readonly environment: LabEnvironment;
  readonly disabled: boolean;
  readonly compact: boolean;
  readonly commands: LabCommands;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (environment.hold) {
    return (
      <ActionButton
        label="Unhold"
        tooltip="Drops your hold so agents looking for a free lab can take it again."
        icon={LockOpenIcon}
        disabled={disabled}
        compact={compact}
        onClick={() => void commands.action(environment, "unhold")}
      />
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size={compact ? "icon-xs" : "xs"}
                  variant="outline"
                  disabled={disabled}
                  aria-label={compact ? "Hold" : undefined}
                />
              }
            />
          }
        >
          <LockIcon />
          {compact ? null : "Hold"}
        </TooltipTrigger>
        <LabActionTooltip
          label="Hold"
          description="Keeps this lab for you: agents looking for a free lab skip it."
        />
      </Tooltip>
      <PopoverPopup width="sm" padding="compact" align="start">
        <form
          className="flex flex-col gap-2 text-xs"
          onSubmit={(event) => {
            event.preventDefault();
            setOpen(false);
            void commands.action(environment, "hold", note.trim());
            setNote("");
          }}
        >
          <span className="text-muted-foreground">
            A held lab is skipped by agents that look for a free one.
          </span>
          <Input
            size="sm"
            autoFocus
            aria-label="Hold note"
            placeholder="Why you are keeping it (optional)"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button type="submit" size="xs" className="self-end">
            Hold {environment.name}
          </Button>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

/** Releases the reservation; `emphasized` (solid destructive) when nothing else will release it. */
export function LabReleaseButton({
  environment,
  commands,
  disabled,
  compact = false,
  emphasized = false,
}: {
  readonly environment: LabEnvironment;
  readonly commands: LabCommands;
  readonly disabled: boolean;
  readonly compact?: boolean;
  readonly emphasized?: boolean;
}) {
  return (
    <ActionButton
      label="Release"
      tooltip="Releases the reservation now, keeping the standing handoff note. Offers to stop a running stack first; uncommitted changes block it."
      icon={LogOutIcon}
      compact={compact}
      variant={emphasized ? "destructive" : "outline"}
      disabled={disabled}
      onClick={() => void commands.release(environment)}
    />
  );
}

/**
 * Main/Staging and Preview have no actions; the CLI manages only lab stacks. `extra` appends the
 * caller's own action, `compact` renders the chip's single icon row, and `emphasizeRelease` colors
 * Release when the owner thread is archived.
 */
export function LabActionBar({
  environmentId,
  projectId,
  environment,
  t3,
  commands,
  extra,
  compact = false,
  emphasizeRelease = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  /** Null while the snapshot loads: only `extra` shows. */
  readonly environment: LabEnvironment | null;
  readonly t3: LabT3State | undefined;
  readonly commands: LabCommands;
  readonly extra?: ReactNode;
  readonly compact?: boolean;
  readonly emphasizeRelease?: boolean;
}) {
  const handleNewThread = useNewThreadHandler();
  const ownerThreadId = environment?.lease?.threadId ?? null;
  const owner = useLabOwnerThread(environmentId, ownerThreadId);
  if (environment === null || environment.kind !== "lab") {
    return extra ? <div className="flex flex-wrap items-center gap-1">{extra}</div> : null;
  }
  const busy = isLabBusy(commands, t3);
  const running = isLabStackRunning(environment);
  const free = resolveLabAvailability(environment) === "free";
  return (
    <div className={compact ? "flex items-center gap-1" : "flex flex-wrap items-center gap-1"}>
      {free && projectId !== null ? (
        <ActionButton
          label="New thread"
          tooltip={`Opens a new Lab-mode thread for ${environment.name}; sending its first message reserves the lab.`}
          icon={FlaskConicalIcon}
          compact={compact}
          variant="default"
          onClick={() =>
            void handleNewThread(scopeProjectRef(environmentId, projectId), {
              envMode: "lab",
              worktreePath: null,
              lab: { ...DEFAULT_DRAFT_LAB_INTENT, labId: environment.id },
            })
          }
        />
      ) : null}
      <ActionButton
        label={running ? "Refresh" : "Start"}
        tooltip={
          running
            ? "Starts whatever is stopped and restarts the dev server only if it is stale (dependencies or branch changed). Chrome keeps running."
            : "Starts this lab's Chrome, dev server and backend (about 20 s)."
        }
        icon={PlayIcon}
        compact={compact}
        disabled={busy}
        onClick={() => void commands.action(environment, "up")}
      />
      {running ? (
        <ActionButton
          label="Restart WXT"
          tooltip="Restarts this lab's dev server and backend watcher, then reloads the extension. Chrome and its sign-ins stay."
          icon={RefreshCwIcon}
          compact={compact}
          disabled={busy}
          onClick={() => void commands.action(environment, "restart-wxt")}
        />
      ) : null}
      {running ? (
        <ActionButton
          label="Stop"
          tooltip="Stops this lab's Chrome, dev server and tmux session."
          icon={SquareIcon}
          compact={compact}
          disabled={busy}
          onClick={() => void commands.action(environment, "down")}
        />
      ) : null}
      {running ? (
        <ActionButton
          label="Reload"
          tooltip="Reloads the SalesPros extension in this lab's Chrome."
          icon={RotateCwIcon}
          compact={compact}
          disabled={busy}
          onClick={() => void commands.action(environment, "reload")}
        />
      ) : null}
      <ActionButton
        label="Browser"
        tooltip="Brings this lab's Chrome window to the front."
        icon={AppWindowIcon}
        compact={compact}
        disabled={busy}
        onClick={() => void commands.action(environment, "browser")}
      />
      <HoldButton environment={environment} disabled={busy} compact={compact} commands={commands} />
      {environment.lease && owner && ownerThreadId ? (
        <ActionButton
          label="Ask agent to release"
          tooltip={`Sends ${owner.title} a message asking its agent to commit, stop the stack and release the lab.`}
          icon={MessageSquareIcon}
          compact={compact}
          disabled={!commands.canOperate}
          onClick={() => commands.askOwnerToRelease(environment, ownerThreadId)}
        />
      ) : null}
      {environment.lease ? (
        <LabReleaseButton
          environment={environment}
          commands={commands}
          disabled={busy}
          compact={compact}
          emphasized={emphasizeRelease}
        />
      ) : null}
      {extra}
    </div>
  );
}
