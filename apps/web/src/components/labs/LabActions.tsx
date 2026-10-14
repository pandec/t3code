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
  PanelRightIcon,
  PlayIcon,
  RotateCwIcon,
  SquareIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";

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

  const action = useCallback(
    async (environment: Pick<LabEnvironment, "id" | "name">, kind: LabAction, note?: string) => {
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
    },
    [environmentId, runAction],
  );

  /** Releases without a handoff note; a running stack can be stopped first, other blockers show. */
  const release = useCallback(
    async (environment: Pick<LabEnvironment, "id" | "name">) => {
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
    },
    [environmentId, runRelease],
  );

  /** A normal, visible message to the owner thread; the outbox delivers it like any send. */
  const askOwnerToRelease = useCallback(
    (environment: Pick<LabEnvironment, "id" | "name">, ownerThreadId: string) => {
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
    },
    [environmentId],
  );

  return { action, release, askOwnerToRelease, canOperate };
}

export type LabCommands = ReturnType<typeof useLabCommands>;

/** A small action with a one-line explanation; actions never stretch to fill their row. */
function ActionButton({
  label,
  tooltip,
  icon: Icon,
  disabled,
  variant = "outline",
  onClick,
}: {
  readonly label: string;
  readonly tooltip: string;
  readonly icon: typeof PlayIcon;
  readonly disabled?: boolean;
  readonly variant?: "outline" | "default";
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button size="xs" variant={variant} disabled={disabled} onClick={onClick} />}
      >
        <Icon />
        {label}
      </TooltipTrigger>
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function HoldButton({
  environment,
  disabled,
  commands,
}: {
  readonly environment: LabEnvironment;
  readonly disabled: boolean;
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
        onClick={() => void commands.action(environment, "unhold")}
      />
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger render={<Button size="xs" variant="outline" disabled={disabled} />} />
          }
        >
          <LockIcon />
          Hold
        </TooltipTrigger>
        <TooltipPopup>Keeps this lab for you: agents looking for a free lab skip it.</TooltipPopup>
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

/**
 * Every action for one lab in one wrapping row: a new thread in a free lab, the stack commands,
 * hold, and the two ways to release. Main/Staging and Preview have none; the CLI manages only lab
 * stacks. `extra` appends a caller's own action (the chip's Details).
 */
export function LabActionBar({
  environmentId,
  projectId,
  environment,
  t3,
  commands,
  extra,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  /** Null while the snapshot loads: only `extra` shows. */
  readonly environment: LabEnvironment | null;
  readonly t3: LabT3State | undefined;
  readonly commands: LabCommands;
  readonly extra?: ReactNode;
}) {
  const handleNewThread = useNewThreadHandler();
  const ownerThreadId = environment?.lease?.threadId ?? null;
  const owner = useLabOwnerThread(environmentId, ownerThreadId);
  if (environment === null || environment.kind !== "lab") {
    return extra ? <div className="flex flex-wrap items-center gap-1">{extra}</div> : null;
  }
  const busy = !commands.canOperate || t3?.operation != null;
  const running = isLabStackRunning(environment);
  const free = resolveLabAvailability(environment) === "free";
  return (
    <div className="flex flex-wrap items-center gap-1">
      {free && projectId !== null ? (
        <ActionButton
          label="New thread"
          tooltip={`Opens a new Lab-mode thread for ${environment.name}; sending its first message reserves the lab.`}
          icon={FlaskConicalIcon}
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
        label={running ? "Restart" : "Start"}
        tooltip={
          running
            ? "Runs sp-labs up again: restarts Chrome and the dev server and rechecks the extension."
            : "Runs sp-labs up: starts this lab's Chrome, dev server and backend (about 20 s)."
        }
        icon={PlayIcon}
        disabled={busy}
        onClick={() => void commands.action(environment, "up")}
      />
      {running ? (
        <ActionButton
          label="Stop"
          tooltip="Runs sp-labs down: stops this lab's Chrome, dev server and tmux session."
          icon={SquareIcon}
          disabled={busy}
          onClick={() => void commands.action(environment, "down")}
        />
      ) : null}
      {running ? (
        <ActionButton
          label="Reload"
          tooltip="Reloads the SalesPros extension in this lab's Chrome."
          icon={RotateCwIcon}
          disabled={busy}
          onClick={() => void commands.action(environment, "reload")}
        />
      ) : null}
      <ActionButton
        label="Browser"
        tooltip="Brings this lab's Chrome window to the front."
        icon={AppWindowIcon}
        disabled={busy}
        onClick={() => void commands.action(environment, "browser")}
      />
      <ActionButton
        label="Extension panel"
        tooltip="Opens the SalesPros side panel on a Salesforce tab in this lab's Chrome."
        icon={PanelRightIcon}
        disabled={busy}
        onClick={() => void commands.action(environment, "sidepanel")}
      />
      <HoldButton environment={environment} disabled={busy} commands={commands} />
      {environment.lease && owner && ownerThreadId ? (
        <ActionButton
          label="Ask agent to release"
          tooltip={`Sends ${owner.title} a message asking its agent to commit, stop the stack and release the lab.`}
          icon={MessageSquareIcon}
          disabled={!commands.canOperate}
          onClick={() => commands.askOwnerToRelease(environment, ownerThreadId)}
        />
      ) : null}
      {environment.lease ? (
        <ActionButton
          label="Release"
          tooltip="Releases the reservation now, keeping the standing handoff note. Offers to stop a running stack first; uncommitted changes block it."
          icon={LogOutIcon}
          disabled={busy}
          onClick={() => void commands.release(environment)}
        />
      ) : null}
      {extra}
    </div>
  );
}
