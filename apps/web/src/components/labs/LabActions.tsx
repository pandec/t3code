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
import { useCallback, useState } from "react";

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

function ActionButton({
  label,
  icon: Icon,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly icon: typeof PlayIcon;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Button size="xs" variant="outline" disabled={disabled} onClick={onClick}>
      <Icon />
      {label}
    </Button>
  );
}

/** Stack controls: start, stop, reload, browser and side panel. */
export function LabStackActions({
  environment,
  t3,
  commands,
}: {
  readonly environment: LabEnvironment;
  readonly t3: LabT3State | undefined;
  readonly commands: LabCommands;
}) {
  const busy = !commands.canOperate || t3?.operation != null;
  const running = isLabStackRunning(environment);
  return (
    <div className="flex flex-wrap gap-1">
      {running ? (
        <ActionButton
          label="Stop"
          icon={SquareIcon}
          disabled={busy}
          onClick={() => void commands.action(environment, "down")}
        />
      ) : null}
      <ActionButton
        label={running ? "Restart" : "Start"}
        icon={PlayIcon}
        disabled={busy}
        onClick={() => void commands.action(environment, "up")}
      />
      <ActionButton
        label="Reload"
        icon={RotateCwIcon}
        disabled={busy || !running}
        onClick={() => void commands.action(environment, "reload")}
      />
      <ActionButton
        label="Browser"
        icon={AppWindowIcon}
        disabled={busy}
        onClick={() => void commands.action(environment, "browser")}
      />
      <ActionButton
        label="Side panel"
        icon={PanelRightIcon}
        disabled={busy}
        onClick={() => void commands.action(environment, "sidepanel")}
      />
    </div>
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
        icon={LockOpenIcon}
        disabled={disabled}
        onClick={() => void commands.action(environment, "unhold")}
      />
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="xs" variant="outline" disabled={disabled} />}>
        <LockIcon />
        Hold
      </PopoverTrigger>
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

/** Reservation controls for a lab: hold, release, and asking its owner agent to release. */
export function LabReservationActions({
  environmentId,
  environment,
  t3,
  commands,
}: {
  readonly environmentId: EnvironmentId;
  readonly environment: LabEnvironment;
  readonly t3: LabT3State | undefined;
  readonly commands: LabCommands;
}) {
  const busy = !commands.canOperate || t3?.operation != null;
  const ownerThreadId = environment.lease?.threadId ?? null;
  const owner = useLabOwnerThread(environmentId, ownerThreadId);
  if (environment.kind !== "lab") return null;
  return (
    <div className="flex flex-wrap gap-1">
      <HoldButton environment={environment} disabled={busy} commands={commands} />
      {environment.lease ? (
        <>
          {owner && ownerThreadId ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!commands.canOperate}
                    onClick={() => commands.askOwnerToRelease(environment, ownerThreadId)}
                  />
                }
              >
                <MessageSquareIcon />
                Ask agent to wrap up & release
              </TooltipTrigger>
              <TooltipPopup>Sends a message to {owner.title}</TooltipPopup>
            </Tooltip>
          ) : null}
          <ActionButton
            label="Release"
            icon={LogOutIcon}
            disabled={busy}
            onClick={() => void commands.release(environment)}
          />
        </>
      ) : null}
    </div>
  );
}

/** Stages a Lab-mode draft for `environment` in the labs project; nothing is reserved yet. */
export function NewThreadInLabButton({
  environmentId,
  projectId,
  environment,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly environment: LabEnvironment;
}) {
  const handleNewThread = useNewThreadHandler();
  if (projectId === null || resolveLabAvailability(environment) !== "free") return null;
  return (
    <Button
      size="xs"
      onClick={() =>
        void handleNewThread(scopeProjectRef(environmentId, projectId), {
          envMode: "lab",
          worktreePath: null,
          lab: { ...DEFAULT_DRAFT_LAB_INTENT, labId: environment.id },
        })
      }
    >
      <FlaskConicalIcon />
      New thread here
    </Button>
  );
}
