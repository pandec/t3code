import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  MessageInputOrigin,
  ModelSelection,
  type OrchestrationSessionStatus,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type ModelSelection as ModelSelectionType,
  type ProjectId as ProjectIdType,
  type ProviderInteractionMode as ProviderInteractionModeType,
  type RuntimeMode as RuntimeModeType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { isTransportConnectionErrorMessage } from "../errors/index.ts";
import {
  PersistedDraftComposerImageAttachmentSchema,
  type DraftComposerImageAttachment,
} from "./composerAttachment.ts";
import type { EnvironmentShellStatus } from "./shell.ts";

const THREAD_OUTBOX_SCHEMA_VERSION = 5;
const THREAD_OUTBOX_MAX_RETRY_DELAY_MS = 16_000;

const QueuedThreadCreationSchema = Schema.Struct({
  projectId: ProjectId,
  // Snapshot of the project's display metadata so a pending task stays
  // presentable in the thread list even when the project shell is not loaded.
  projectTitle: Schema.optional(Schema.String),
  projectCwd: Schema.optional(Schema.String),
  workspaceMode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

/**
 * How a queued message behaves while its thread has an active turn: "queue"
 * holds until the turn completes, "steer" delivers into the running turn.
 * Messages persisted before schema version 5 carry no intent and decode as
 * "queue" — holding is the safer reading of an old queued message.
 */
export const ThreadOutboxDeliveryIntent = Schema.Literals(["queue", "steer"]);
export type ThreadOutboxDeliveryIntent = typeof ThreadOutboxDeliveryIntent.Type;

export const QueuedThreadMessageSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2, 3, 4, THREAD_OUTBOX_SCHEMA_VERSION]),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  inputOrigin: Schema.optional(MessageInputOrigin),
  attachments: Schema.Array(PersistedDraftComposerImageAttachmentSchema),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  deliveryIntent: Schema.optional(ThreadOutboxDeliveryIntent),
  // Web-only snapshot of the checked-out branch when it differs from the
  // thread metadata. Delivery applies it before starting the queued turn.
  localCheckoutBranch: Schema.optional(Schema.String),
  // Present when the queued item creates a brand-new thread (pending task)
  // instead of appending a turn to an existing one.
  creation: Schema.optional(QueuedThreadCreationSchema),
  createdAt: IsoDateTime,
});

const decodeStoredQueuedThreadMessage = Schema.decodeUnknownSync(QueuedThreadMessageSchema);
const encodeStoredQueuedThreadMessage = Schema.encodeUnknownSync(QueuedThreadMessageSchema);

export interface QueuedThreadCreation {
  readonly projectId: ProjectIdType;
  readonly projectTitle?: string | undefined;
  readonly projectCwd?: string | undefined;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean | undefined;
}

export interface QueuedThreadMessage {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
  readonly inputOrigin?: typeof MessageInputOrigin.Type | undefined;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly modelSelection?: ModelSelectionType | undefined;
  readonly runtimeMode?: RuntimeModeType | undefined;
  readonly interactionMode?: ProviderInteractionModeType | undefined;
  readonly deliveryIntent?: ThreadOutboxDeliveryIntent | undefined;
  readonly localCheckoutBranch?: string | undefined;
  readonly creation?: QueuedThreadCreation | undefined;
  readonly createdAt: string;
}

export function queuedThreadMessageIntent(
  message: Pick<QueuedThreadMessage, "deliveryIntent">,
): ThreadOutboxDeliveryIntent {
  return message.deliveryIntent ?? "queue";
}

/** One-line row label for the queued-messages list. */
export function queuedThreadMessagePreview(
  message: Pick<QueuedThreadMessage, "text" | "attachments">,
): string {
  const collapsed = message.text.replace(/\s+/g, " ").trim();
  if (collapsed.length > 0) {
    return collapsed;
  }
  const count = message.attachments.length;
  return count === 1 ? "1 image attachment" : `${count} image attachments`;
}

export interface ThreadSettingsSnapshot {
  readonly modelSelection: ModelSelectionType;
  readonly branch: string | null;
  readonly runtimeMode: RuntimeModeType;
  readonly interactionMode: ProviderInteractionModeType;
}

export function resolveQueuedThreadSettings(
  message: QueuedThreadMessage,
  thread: ThreadSettingsSnapshot,
): ThreadSettingsSnapshot {
  return {
    modelSelection: message.modelSelection ?? thread.modelSelection,
    branch: message.localCheckoutBranch ?? thread.branch,
    runtimeMode: message.runtimeMode ?? thread.runtimeMode,
    interactionMode: message.interactionMode ?? thread.interactionMode,
  };
}

export function modelSelectionsEqual(left: ModelSelectionType, right: ModelSelectionType): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

export function encodeQueuedThreadMessage(message: QueuedThreadMessage): unknown {
  return encodeStoredQueuedThreadMessage({
    schemaVersion: THREAD_OUTBOX_SCHEMA_VERSION,
    ...message,
    attachments: message.attachments.map(
      ({ previewUri: _previewUri, ...attachment }) => attachment,
    ),
  });
}

export function decodeQueuedThreadMessage(value: unknown): QueuedThreadMessage {
  const { schemaVersion: _, ...message } = decodeStoredQueuedThreadMessage(value);
  return {
    ...message,
    attachments: message.attachments.map((attachment) => ({
      ...attachment,
      previewUri: attachment.dataUrl,
    })),
  };
}

export function scopedThreadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}:${threadId}`;
}

export function groupQueuedThreadMessages(
  messages: ReadonlyArray<QueuedThreadMessage>,
): Record<string, ReadonlyArray<QueuedThreadMessage>> {
  const deduplicated = new Map<MessageId, QueuedThreadMessage>();
  for (const message of messages) {
    deduplicated.set(message.messageId, message);
  }

  const grouped: Record<string, Array<QueuedThreadMessage>> = {};
  for (const message of deduplicated.values()) {
    const threadKey = scopedThreadKey(message.environmentId, message.threadId);
    (grouped[threadKey] ??= []).push(message);
  }
  for (const queue of Object.values(grouped)) {
    queue.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return grouped;
}

export function flattenQueuedThreadMessages(
  queues: Record<string, ReadonlyArray<QueuedThreadMessage>>,
): ReadonlyArray<QueuedThreadMessage> {
  return Object.values(queues).flat();
}

export function threadOutboxRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), THREAD_OUTBOX_MAX_RETRY_DELAY_MS);
}

export type ThreadOutboxDeliveryAction = "wait" | "remove" | "send";

export function resolveThreadOutboxDeliveryAction(input: {
  readonly isCreation: boolean;
  readonly threadExists: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly environmentConnected: boolean;
  readonly threadStatus: OrchestrationSessionStatus | null;
  readonly deliveryIntent: ThreadOutboxDeliveryIntent;
}): ThreadOutboxDeliveryAction {
  if (input.isCreation) {
    // A pending task creates its thread on delivery. If the thread already
    // exists the creation command went through and only cleanup remains.
    if (input.threadExists) {
      return "remove";
    }
    // Wait for the shell to be live before sending: until the thread list has
    // synchronized, a previously delivered creation whose cleanup failed would
    // look missing and get re-issued, duplicating the thread.
    return input.environmentConnected && input.shellStatus === "live" ? "send" : "wait";
  }
  if (!input.threadExists) {
    return input.shellStatus === "live" ? "remove" : "wait";
  }
  if (!input.environmentConnected || input.threadStatus === "starting") {
    return "wait";
  }
  // A held message waits out the active turn; a steer delivers into it (the
  // server treats a turn start on a running thread as a steer).
  return input.deliveryIntent === "queue" && input.threadStatus === "running" ? "wait" : "send";
}

export interface ThreadOutboxDispatchCandidate {
  readonly message: QueuedThreadMessage;
  readonly action: Exclude<ThreadOutboxDeliveryAction, "wait">;
}

/**
 * Picks the next deliverable message from one thread's FIFO queue. Held
 * ("wait") messages may only be overtaken by a later "steer" message — a
 * message that is merely editing or backing off after a failure blocks
 * everything behind it, so transient failures can never reorder the queue.
 */
export function selectNextQueuedThreadDispatch(
  queue: ReadonlyArray<QueuedThreadMessage>,
  context: {
    readonly isHeld: (message: QueuedThreadMessage) => boolean;
    readonly resolveAction: (message: QueuedThreadMessage) => ThreadOutboxDeliveryAction;
  },
): ThreadOutboxDispatchCandidate | null {
  let waitingSkipped = false;
  for (const message of queue) {
    if (context.isHeld(message)) {
      return null;
    }
    const action = context.resolveAction(message);
    if (action === "wait") {
      waitingSkipped = true;
      continue;
    }
    if (!waitingSkipped || action === "remove" || queuedThreadMessageIntent(message) === "steer") {
      return { message, action };
    }
    waitingSkipped = true;
  }
  return null;
}

/**
 * A queued creation can only be dispatched once its payload would pass server
 * validation; incomplete payloads stay pending until the user edits them.
 */
export function isQueuedThreadCreationSendable(message: QueuedThreadMessage): boolean {
  if (!message.creation) {
    return false;
  }
  if (message.text.trim().length === 0 || message.modelSelection === undefined) {
    return false;
  }
  return message.creation.workspaceMode !== "worktree" || Boolean(message.creation.branch);
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string" ? error.message : null;
  }
  return typeof error === "string" ? error : null;
}

export function shouldRetryThreadOutboxDelivery(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ConnectionTransientError"
  ) {
    return true;
  }
  return isTransportConnectionErrorMessage(errorMessage(error));
}

export type ThreadOutboxCommandStage = "settings-sync" | "start-turn";
export type ThreadOutboxFailureAction = "retry" | "discard";

export function resolveThreadOutboxFailureAction(input: {
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
}): ThreadOutboxFailureAction {
  if (
    input.stage === "settings-sync" ||
    input.interrupted ||
    shouldRetryThreadOutboxDelivery(input.error)
  ) {
    return "retry";
  }
  return "discard";
}
