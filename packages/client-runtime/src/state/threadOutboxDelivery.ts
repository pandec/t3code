import {
  CommandId,
  type ChatFileAttachment,
  type EnvironmentId,
  type OrchestrationSessionStatus,
  type TurnId,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  toUploadChatImageAttachments,
  type DraftComposerAttachment,
} from "./composerAttachment.ts";
import type {
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  StartThreadTurnInput,
  UpdateThreadMetadataInput,
} from "./threadCommands.ts";
import {
  modelSelectionsEqual,
  resolveQueuedThreadSettings,
  resolveThreadOutboxFailureAction,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
  type ThreadSettingsSnapshot,
} from "./threadOutboxModel.ts";
import type { AtomCommandResult } from "./runtime.ts";

export type ThreadOutboxCommandExecutor<Input> = (args: {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}) => Promise<AtomCommandResult<unknown, unknown>>;

export interface ThreadOutboxDeliveryCommands {
  readonly startTurn: ThreadOutboxCommandExecutor<StartThreadTurnInput>;
  readonly updateMetadata: ThreadOutboxCommandExecutor<UpdateThreadMetadataInput>;
  readonly setRuntimeMode: ThreadOutboxCommandExecutor<SetThreadRuntimeModeInput>;
  readonly setInteractionMode: ThreadOutboxCommandExecutor<SetThreadInteractionModeInput>;
}

/**
 * The thread's live turn as the drain saw it immediately before sending. The
 * settings snapshot beside it says how to send; this says what the send landed
 * on — `sessionStatus: "running"` means the message steered into a turn that
 * was already in flight rather than starting one of its own.
 */
export interface ThreadOutboxDeliveryContext {
  readonly sessionBaselineKnown: boolean;
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly sessionUpdatedAt: string | null;
  readonly latestTurnId: TurnId | null;
}

const IDLE_DELIVERY_CONTEXT: ThreadOutboxDeliveryContext = {
  sessionBaselineKnown: false,
  sessionStatus: null,
  sessionUpdatedAt: null,
  latestTurnId: null,
};

export interface ThreadOutboxDeliveryOptions {
  readonly commands: ThreadOutboxDeliveryCommands;
  /** Removes a delivered message from the queue; rejections are reported, not thrown. */
  readonly removeQueuedMessage: (message: QueuedThreadMessage) => Promise<unknown>;
  /** Fires after startTurn is accepted, before queue cleanup or projection catch-up. */
  readonly onStartTurnAccepted?: (
    message: QueuedThreadMessage,
    thread: ThreadSettingsSnapshot,
    context: ThreadOutboxDeliveryContext,
  ) => void;
  /**
   * Fires once a queued message is delivered and cleaned up, carrying the
   * thread as it looked at send time — that pre-send snapshot is how a caller
   * sees that the server just auto-unarchived the thread. Throwing here is
   * reported, never unwinds the delivery.
   */
  readonly onDelivered?: (
    message: QueuedThreadMessage,
    thread: ThreadSettingsSnapshot,
    context: ThreadOutboxDeliveryContext,
  ) => void;
  readonly warn: (message: string, attributes: Record<string, unknown>) => void;
}

function settingsCommandId(message: QueuedThreadMessage, setting: string): CommandId {
  return CommandId.make(`${message.commandId}:${setting}`);
}

function toStartTurnAttachments(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): ReadonlyArray<UploadChatImageAttachment | ChatFileAttachment> | null {
  const prepared: Array<UploadChatImageAttachment | ChatFileAttachment> = [];
  for (const attachment of attachments) {
    if (attachment.type === "image") {
      prepared.push(...toUploadChatImageAttachments([attachment]));
      continue;
    }
    if (attachment.uploadedAttachmentId === undefined) {
      return null;
    }
    prepared.push({
      type: "file",
      id: attachment.uploadedAttachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    });
  }
  return prepared;
}

/**
 * The single send pipeline for queued messages: settings sync, then startTurn,
 * then queue cleanup. Shared by every platform's drain so delivery semantics
 * cannot diverge. Callers own the dispatch slot and any retry policy; the
 * returned boolean is "delivered and cleaned up" — false means retry later.
 */
export function createThreadOutboxDelivery(options: ThreadOutboxDeliveryOptions) {
  const warn = options.warn;

  const makeDeliveryHelpers = (queuedMessage: QueuedThreadMessage) => {
    const reportFailure = (
      commandResult: AtomCommandResult<unknown, unknown>,
      stage: ThreadOutboxCommandStage,
    ): boolean => {
      if (!AsyncResult.isFailure(commandResult)) {
        return false;
      }
      const action = resolveThreadOutboxFailureAction({
        stage,
        error: Cause.squash(commandResult.cause),
        interrupted: Cause.hasInterruptsOnly(commandResult.cause),
      });
      const retry = action === "retry";
      warn("[thread-outbox] queued message delivery failed", {
        environmentId: queuedMessage.environmentId,
        threadId: queuedMessage.threadId,
        messageId: queuedMessage.messageId,
        stage,
        cause: commandResult.cause,
        retry,
      });
      return retry;
    };
    const completeDelivery = async (
      deliveryResult: AtomCommandResult<unknown, unknown>,
    ): Promise<boolean> => {
      if (reportFailure(deliveryResult, "start-turn")) {
        return false;
      }

      try {
        await options.removeQueuedMessage(queuedMessage);
      } catch (error) {
        warn("[thread-outbox] failed to remove delivered queued message", {
          environmentId: queuedMessage.environmentId,
          threadId: queuedMessage.threadId,
          messageId: queuedMessage.messageId,
          error,
        });
        return false;
      }
      return true;
    };
    return { reportFailure, completeDelivery };
  };

  const sendQueuedMessage = async (
    queuedMessage: QueuedThreadMessage,
    thread: ThreadSettingsSnapshot,
    context: ThreadOutboxDeliveryContext = IDLE_DELIVERY_CONTEXT,
  ): Promise<boolean> => {
    const settings = resolveQueuedThreadSettings(queuedMessage, thread);
    const { reportFailure, completeDelivery } = makeDeliveryHelpers(queuedMessage);

    const modelSelectionChanged = !modelSelectionsEqual(
      settings.modelSelection,
      thread.modelSelection,
    );
    const branchChanged = settings.branch !== thread.branch;
    if (modelSelectionChanged) {
      const updateResult = await options.commands.updateMetadata({
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: settingsCommandId(queuedMessage, "model-selection"),
          threadId: queuedMessage.threadId,
          modelSelection: settings.modelSelection,
        },
      });
      if (AsyncResult.isFailure(updateResult)) {
        reportFailure(updateResult, "settings-sync");
        return false;
      }
    }
    if (branchChanged) {
      const updateResult = await options.commands.updateMetadata({
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: settingsCommandId(queuedMessage, "branch"),
          threadId: queuedMessage.threadId,
          branch: settings.branch,
          worktreePath: null,
        },
      });
      if (AsyncResult.isFailure(updateResult)) {
        reportFailure(updateResult, "settings-sync");
        return false;
      }
    }

    if (settings.runtimeMode !== thread.runtimeMode) {
      const runtimeResult = await options.commands.setRuntimeMode({
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: settingsCommandId(queuedMessage, "runtime-mode"),
          threadId: queuedMessage.threadId,
          runtimeMode: settings.runtimeMode,
          createdAt: queuedMessage.createdAt,
        },
      });
      if (AsyncResult.isFailure(runtimeResult)) {
        reportFailure(runtimeResult, "settings-sync");
        return false;
      }
    }

    if (settings.interactionMode !== thread.interactionMode) {
      const interactionResult = await options.commands.setInteractionMode({
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: settingsCommandId(queuedMessage, "interaction-mode"),
          threadId: queuedMessage.threadId,
          interactionMode: settings.interactionMode,
          createdAt: queuedMessage.createdAt,
        },
      });
      if (AsyncResult.isFailure(interactionResult)) {
        reportFailure(interactionResult, "settings-sync");
        return false;
      }
    }

    const attachments = toStartTurnAttachments(queuedMessage.attachments);
    if (attachments === null) {
      warn("[thread-outbox] queued file attachment is not uploaded", {
        environmentId: queuedMessage.environmentId,
        threadId: queuedMessage.threadId,
        messageId: queuedMessage.messageId,
      });
      return false;
    }

    const deliveryResult = await options.commands.startTurn({
      environmentId: queuedMessage.environmentId,
      input: {
        commandId: queuedMessage.commandId,
        threadId: queuedMessage.threadId,
        message: {
          messageId: queuedMessage.messageId,
          role: "user",
          text: queuedMessage.text,
          attachments,
          ...(queuedMessage.inputOrigin !== undefined
            ? { inputOrigin: queuedMessage.inputOrigin }
            : {}),
        },
        modelSelection: settings.modelSelection,
        runtimeMode: settings.runtimeMode,
        interactionMode: settings.interactionMode,
        createdAt: queuedMessage.createdAt,
      },
    });
    if (AsyncResult.isSuccess(deliveryResult)) {
      try {
        options.onStartTurnAccepted?.(queuedMessage, thread, context);
      } catch (error) {
        warn("[thread-outbox] start-accepted callback failed", {
          environmentId: queuedMessage.environmentId,
          threadId: queuedMessage.threadId,
          messageId: queuedMessage.messageId,
          error,
        });
      }
    }
    const delivered = await completeDelivery(deliveryResult);
    if (delivered) {
      try {
        options.onDelivered?.(queuedMessage, thread, context);
      } catch (error) {
        warn("[thread-outbox] delivered-message callback failed", {
          environmentId: queuedMessage.environmentId,
          threadId: queuedMessage.threadId,
          messageId: queuedMessage.messageId,
          error,
        });
      }
    }
    return delivered;
  };

  return { makeDeliveryHelpers, sendQueuedMessage };
}

export type ThreadOutboxDelivery = ReturnType<typeof createThreadOutboxDelivery>;
