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
import { clampFileAttachmentUploadBytes, fileAttachmentTooLargeMessage } from "./attachments.ts";
import {
  PersistedDraftComposerAttachmentSchema,
  type DraftComposerAttachment,
} from "./composerAttachment.ts";
import type { EnvironmentShellStatus } from "./shell.ts";

const THREAD_OUTBOX_SCHEMA_VERSION = 7;
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

const ThreadSettingsSnapshotSchema = Schema.Struct({
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  modelSelection: ModelSelection,
  branch: Schema.NullOr(Schema.String),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
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
  schemaVersion: Schema.Literals([1, 2, 3, 4, 5, 6, THREAD_OUTBOX_SCHEMA_VERSION]),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  inputOrigin: Schema.optional(MessageInputOrigin),
  attachments: Schema.Array(PersistedDraftComposerAttachmentSchema),
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
  // Durable fallback for an existing thread that leaves the active shell
  // before delivery (for example, another client archives it).
  threadSettings: Schema.optional(ThreadSettingsSnapshotSchema),
  createdAt: IsoDateTime,
  // Optional restart anchor for the grace window. Keeping it separate preserves
  // the original creation timestamp used for FIFO ordering and delivery.
  graceStartedAt: Schema.optional(IsoDateTime),
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
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly modelSelection?: ModelSelectionType | undefined;
  readonly runtimeMode?: RuntimeModeType | undefined;
  readonly interactionMode?: ProviderInteractionModeType | undefined;
  readonly deliveryIntent?: ThreadOutboxDeliveryIntent | undefined;
  readonly localCheckoutBranch?: string | undefined;
  readonly creation?: QueuedThreadCreation | undefined;
  readonly threadSettings?: ThreadSettingsSnapshot | undefined;
  readonly createdAt: string;
  readonly graceStartedAt?: string | undefined;
}

export function queuedThreadMessageIntent(
  message: Pick<QueuedThreadMessage, "deliveryIntent">,
): ThreadOutboxDeliveryIntent {
  return message.deliveryIntent ?? "queue";
}

/**
 * How long a steer waits in the queue before it is delivered. Steering is
 * one-way — once a message reaches the provider's prompt stream it cannot be
 * recalled — so it rests here first, long enough to fix a typo or drop it.
 *
 * The default for every caller that does not pass a window. Web overrides it
 * per call from the `steerGraceWindowMs` client setting; mobile does not sync
 * client settings, so it passes the device preference of the same name.
 */
export const STEER_GRACE_WINDOW_MS = 5_000;

function resolveGraceWindowMs(graceWindowMs: number | undefined): number {
  return graceWindowMs === undefined || !Number.isFinite(graceWindowMs)
    ? STEER_GRACE_WINDOW_MS
    : Math.max(0, graceWindowMs);
}

/**
 * Milliseconds left before a steer is delivered, or 0 once it is due. Queued
 * messages never wait on this: they are already held by the running turn.
 */
export function steerGraceRemainingMs(
  message: Pick<QueuedThreadMessage, "deliveryIntent" | "createdAt" | "graceStartedAt">,
  nowMs: number,
  graceWindowMs?: number,
): number {
  if (queuedThreadMessageIntent(message) !== "steer") {
    return 0;
  }
  const graceStartedAtMs = Date.parse(message.graceStartedAt ?? message.createdAt);
  if (Number.isNaN(graceStartedAtMs) || graceStartedAtMs > nowMs) {
    return 0;
  }
  return Math.max(0, graceStartedAtMs + resolveGraceWindowMs(graceWindowMs) - nowMs);
}

/**
 * The newest steer that can still be recalled. An empty composer submit uses
 * this to confirm the message the user just sent rather than an older row.
 */
export function latestSteerWaitingOutGraceWindow(
  messages: ReadonlyArray<QueuedThreadMessage>,
  nowMs: number,
  graceWindowMs?: number,
): QueuedThreadMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && steerGraceRemainingMs(message, nowMs, graceWindowMs) > 0) {
      return message;
    }
  }
  return null;
}

/**
 * Whether a steer still owes its grace window. Expediting is the user saying
 * they are sure, so it retires the window rather than shortening it.
 */
export function isSteerWaitingOutGraceWindow(
  message: Pick<
    QueuedThreadMessage,
    "deliveryIntent" | "createdAt" | "graceStartedAt" | "messageId"
  >,
  input: {
    readonly nowMs: number;
    readonly expedited: Readonly<Record<MessageId, true>>;
    readonly graceWindowMs?: number;
  },
): boolean {
  if (input.expedited[message.messageId]) {
    return false;
  }
  return steerGraceRemainingMs(message, input.nowMs, input.graceWindowMs) > 0;
}

/**
 * Drops expedite latches once their message is no longer queued or otherwise
 * owned by an in-flight outbox action.
 */
export function pruneExpeditedQueuedMessageIds(
  expedited: Readonly<Record<MessageId, true>>,
  retainedMessageIds: ReadonlySet<MessageId>,
): Readonly<Record<MessageId, true>> {
  let next: Record<MessageId, true> | null = null;
  for (const messageId of Object.keys(expedited) as MessageId[]) {
    if (retainedMessageIds.has(messageId)) {
      continue;
    }
    next ??= { ...expedited };
    delete next[messageId];
  }
  return next ?? expedited;
}

/** The next steer grace deadline in a collection, if any steer is still waiting. */
export function soonestSteerGraceRemainingMs(
  messages: ReadonlyArray<
    Pick<QueuedThreadMessage, "deliveryIntent" | "createdAt" | "graceStartedAt">
  >,
  nowMs: number,
  graceWindowMs?: number,
): number | null {
  let soonest: number | null = null;
  for (const message of messages) {
    const remainingMs = steerGraceRemainingMs(message, nowMs, graceWindowMs);
    if (remainingMs > 0 && (soonest === null || remainingMs < soonest)) {
      soonest = remainingMs;
    }
  }
  return soonest;
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
  return count === 1 ? "1 attachment" : `${count} attachments`;
}

export interface ThreadSettingsSnapshot {
  readonly archivedAt?: string | null | undefined;
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
    attachments: message.attachments.map((attachment) => {
      if (attachment.type === "file") {
        return attachment;
      }
      const { previewUri: _previewUri, ...persisted } = attachment;
      return persisted;
    }),
  });
}

export function decodeQueuedThreadMessage(value: unknown): QueuedThreadMessage {
  const { schemaVersion: _, ...message } = decodeStoredQueuedThreadMessage(value);
  return {
    ...message,
    attachments: message.attachments.map((attachment) =>
      attachment.type === "image"
        ? {
            ...attachment,
            previewUri: attachment.dataUrl,
          }
        : attachment,
    ),
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

/**
 * Messages released together after a successful idle-thread dispatch. The
 * dispatched leader has already started the new turn; only the non-creation
 * rows that were behind it at selection time may follow that turn as steers.
 *
 * A steer selected while the thread is already running, a stale-row removal,
 * or a pending-task creation must never open a flush batch.
 *
 * Steer-intent rows are left out: they deliver themselves once their grace
 * window ends, and membership would pin them to a steer even after the user
 * demotes them back to a queue delivery.
 */
export function queueFlushBatchIds(
  messages: ReadonlyArray<Pick<QueuedThreadMessage, "messageId" | "creation" | "deliveryIntent">>,
  dispatchedMessage: Pick<QueuedThreadMessage, "messageId" | "creation">,
  input: {
    readonly delivered: boolean;
    readonly action: Exclude<ThreadOutboxDeliveryAction, "wait">;
    readonly threadStatus: OrchestrationSessionStatus | null;
  },
): ReadonlySet<MessageId> {
  if (
    !input.delivered ||
    input.action !== "send" ||
    input.threadStatus === "running" ||
    dispatchedMessage.creation !== undefined
  ) {
    return new Set();
  }
  const leaderIndex = messages.findIndex(
    (message) => message.messageId === dispatchedMessage.messageId,
  );
  if (leaderIndex < 0) {
    return new Set();
  }
  return new Set(
    messages
      .slice(leaderIndex + 1)
      .filter(
        (message) =>
          message.creation === undefined && queuedThreadMessageIntent(message) !== "steer",
      )
      .map(({ messageId }) => messageId),
  );
}

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

export type ThreadOutboxDispatchStep =
  | { readonly step: "wait" }
  | { readonly step: "remove" }
  | { readonly step: "retry" }
  | { readonly step: "restore"; readonly reason: string }
  | { readonly step: "send" };

/**
 * Orders the resolved delivery action against the file-capability gate. The
 * gate applies only to a message that will send: a message whose thread
 * already exists (or is gone) must be removed even while the server config is
 * still loading, and a missing config defers with a retry instead of parking
 * the message forever.
 */
export function resolveThreadOutboxDispatchStep(input: {
  readonly deliveryAction: ThreadOutboxDeliveryAction;
  readonly fileAttachments: ReadonlyArray<{ readonly name: string; readonly sizeBytes: number }>;
  /** Null while the environment's server config has not synced yet. */
  readonly serverConfig: { readonly maxFileUploadBytes: number | undefined } | null;
}): ThreadOutboxDispatchStep {
  if (input.deliveryAction !== "send") {
    return { step: input.deliveryAction };
  }
  if (input.fileAttachments.length === 0) {
    return { step: "send" };
  }
  if (input.serverConfig === null) {
    return { step: "retry" };
  }
  const maxBytes = input.serverConfig.maxFileUploadBytes;
  if (maxBytes === undefined) {
    return { step: "restore", reason: "This server does not support file attachments." };
  }
  const effectiveMaxBytes = clampFileAttachmentUploadBytes(maxBytes);
  const oversized = input.fileAttachments.find(
    (attachment) => attachment.sizeBytes > effectiveMaxBytes,
  );
  return oversized
    ? { step: "restore", reason: fileAttachmentTooLargeMessage(oversized.name, effectiveMaxBytes) }
    : { step: "send" };
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

export function outboxDeliveryErrorMessages(error: unknown): ReadonlyArray<string> {
  const messages: string[] = [];
  const visited = new Set<object>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > 5) return;
    if (typeof value === "string") {
      messages.push(value);
      return;
    }
    if (typeof value !== "object" || value === null || visited.has(value)) return;
    visited.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ["message", "detail", "cause", "error"] as const) {
      if (key in record) visit(record[key], depth + 1);
    }
  };

  visit(error, 0);
  return messages;
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
  if (error instanceof Error) {
    return isTransportConnectionErrorMessage(error.message);
  }
  if (typeof error !== "object" || error === null) {
    return typeof error === "string" && isTransportConnectionErrorMessage(error);
  }
  const record = error as Record<string, unknown>;
  const detail =
    typeof record.message === "string"
      ? record.message
      : typeof record.detail === "string"
        ? record.detail
        : "";
  return isTransportConnectionErrorMessage(detail);
}

export type ThreadOutboxCommandStage = "settings-sync" | "start-turn";
export type ThreadOutboxFailureAction = "retry" | "restore";

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
  return "restore";
}
