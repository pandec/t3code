import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  decodeLegacyQueuedThreadMessage,
  isRetryableThreadSubmissionError,
  LegacyMessageInputOrigin,
} from "@t3tools/client-runtime/state/thread-submission-outbox";
import {
  ChatAttachment,
  ChatAttachmentId,
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  OrchestrationMessageContext,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  UploadChatImageAttachment,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import type { ChatMessage } from "../types";

/**
 * Durable web outbox for messages the server has not accepted yet: composed
 * while the environment is offline, or in flight when the page reloads or the
 * socket drops. Once the server accepts a message (by its stable commandId,
 * so a replay after reload is idempotent) the row is removed and v2's server
 * queue owns it. One localStorage entry per message so writes never clobber
 * siblings.
 */

const STORAGE_KEY_PREFIX = "t3code:thread-submission-outbox:v1:";
/** Rows of the fork's client-owned outbox; migrated once on load. */
const LEGACY_STORAGE_KEY_PREFIX = "t3code:thread-outbox:v1:";

const PendingThreadSubmissionSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  commandId: CommandId,
  messageId: MessageId,
  text: Schema.String,
  inputOrigin: Schema.optional(LegacyMessageInputOrigin),
  context: Schema.optional(OrchestrationMessageContext),
  // Inline uploads first: a stored attachment shape would match them and drop the bytes.
  attachments: Schema.Array(Schema.Union([UploadChatImageAttachment, ChatAttachment])),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(Schema.String),
  dispatchMode: Schema.Literals(["auto", "queue", "steer", "restart"]),
  /** Thread settings to apply before sending; absent when the sender already applied them. */
  settings: Schema.optional(
    Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
  ),
  createdAt: IsoDateTime,
});

export type PendingThreadSubmission = Omit<
  typeof PendingThreadSubmissionSchema.Type,
  "schemaVersion"
>;

const decodeRow = Schema.decodeUnknownSync(PendingThreadSubmissionSchema);
const encodeRow = Schema.encodeUnknownSync(PendingThreadSubmissionSchema);
const isChatAttachmentId = Schema.is(ChatAttachmentId);

/** Converts a fork outbox row; null when it holds something web cannot send. */
export function pendingSubmissionFromLegacyRow(value: unknown): PendingThreadSubmission | null {
  const legacy = decodeLegacyQueuedThreadMessage(value);
  // Pending thread creations were mobile-only.
  if (legacy.creation !== undefined) return null;
  const attachments: UploadChatImageAttachment[] = [];
  for (const attachment of legacy.attachments) {
    if (attachment.type !== "image" || attachment.dataUrl === undefined) return null;
    attachments.push({
      ...(isChatAttachmentId(attachment.id) ? { id: attachment.id } : {}),
      type: "image",
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      dataUrl: attachment.dataUrl,
      ...(attachment.source ? { source: attachment.source } : {}),
    });
  }
  return {
    environmentId: legacy.environmentId,
    threadId: legacy.threadId,
    commandId: legacy.commandId,
    messageId: legacy.messageId,
    text: legacy.text,
    ...(legacy.inputOrigin === undefined ? {} : { inputOrigin: legacy.inputOrigin }),
    ...(legacy.context === undefined ? {} : { context: legacy.context }),
    attachments,
    ...(legacy.modelSelection === undefined ? {} : { modelSelection: legacy.modelSelection }),
    dispatchMode: legacy.dispatchMode,
    ...(legacy.runtimeMode !== undefined && legacy.interactionMode !== undefined
      ? {
          settings: { runtimeMode: legacy.runtimeMode, interactionMode: legacy.interactionMode },
        }
      : {}),
    createdAt: legacy.createdAt,
  };
}

function storageKey(messageId: MessageId): string {
  return `${STORAGE_KEY_PREFIX}${messageId}`;
}

function sortSubmissions(
  submissions: ReadonlyArray<PendingThreadSubmission>,
): ReadonlyArray<PendingThreadSubmission> {
  return [...submissions].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Reads every stored row, migrating fork rows to the current key and shape. */
export function loadThreadOutbox(storage: Storage): ReadonlyArray<PendingThreadSubmission> {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(STORAGE_KEY_PREFIX) || key?.startsWith(LEGACY_STORAGE_KEY_PREFIX)) {
      keys.push(key);
    }
  }
  const submissions = new Map<MessageId, PendingThreadSubmission>();
  for (const key of keys) {
    const raw = storage.getItem(key);
    if (raw === null) continue;
    try {
      const value = JSON.parse(raw) as unknown;
      if (key.startsWith(STORAGE_KEY_PREFIX)) {
        const { schemaVersion: _, ...submission } = decodeRow(value);
        submissions.set(submission.messageId, submission);
        continue;
      }
      const migrated = pendingSubmissionFromLegacyRow(value);
      if (migrated === null) {
        console.warn("[thread-outbox] kept a fork outbox row web cannot send", key);
        continue;
      }
      storage.setItem(storageKey(migrated.messageId), JSON.stringify(encodeSubmission(migrated)));
      storage.removeItem(key);
      submissions.set(migrated.messageId, migrated);
    } catch (error) {
      // Unreadable rows stay in storage untouched.
      console.warn("[thread-outbox] ignored unreadable outbox row", key, error);
    }
  }
  return sortSubmissions([...submissions.values()]);
}

function encodeSubmission(submission: PendingThreadSubmission): unknown {
  return encodeRow({ schemaVersion: 1, ...submission });
}

function browserStorage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

interface ThreadOutboxState {
  readonly submissions: ReadonlyArray<PendingThreadSubmission>;
  /** Rows a sender currently owns; the drain skips them. */
  readonly inFlight: ReadonlySet<MessageId>;
}

export const useThreadOutboxStore = create<ThreadOutboxState>(() => {
  const storage = browserStorage();
  return {
    submissions: storage === null ? [] : loadThreadOutbox(storage),
    inFlight: new Set(),
  };
});

/**
 * Persists a submission before it is sent, optionally claiming it for the
 * caller's own send. False when storage refused it (full or unavailable); the
 * caller then sends without durability.
 */
export function enqueueThreadSubmission(
  submission: PendingThreadSubmission,
  options: { readonly claim?: boolean } = {},
): boolean {
  const storage = browserStorage();
  if (storage === null) return false;
  try {
    storage.setItem(storageKey(submission.messageId), JSON.stringify(encodeSubmission(submission)));
  } catch (error) {
    console.warn("[thread-outbox] could not persist a pending message", error);
    return false;
  }
  useThreadOutboxStore.setState((state) => ({
    submissions: sortSubmissions([
      ...state.submissions.filter((entry) => entry.messageId !== submission.messageId),
      submission,
    ]),
    ...(options.claim ? { inFlight: new Set(state.inFlight).add(submission.messageId) } : {}),
  }));
  return true;
}

export function removeThreadSubmission(messageId: MessageId): void {
  browserStorage()?.removeItem(storageKey(messageId));
  useThreadOutboxStore.setState((state) => {
    const inFlight = new Set(state.inFlight);
    inFlight.delete(messageId);
    return {
      submissions: state.submissions.filter((entry) => entry.messageId !== messageId),
      inFlight,
    };
  });
}

/** Takes ownership of a stored row for sending; false if someone else holds it. */
export function claimThreadSubmission(messageId: MessageId): boolean {
  const { inFlight, submissions } = useThreadOutboxStore.getState();
  if (inFlight.has(messageId) || !submissions.some((entry) => entry.messageId === messageId)) {
    return false;
  }
  useThreadOutboxStore.setState({ inFlight: new Set(inFlight).add(messageId) });
  return true;
}

export function releaseThreadSubmission(messageId: MessageId): void {
  const { inFlight } = useThreadOutboxStore.getState();
  if (!inFlight.has(messageId)) return;
  const next = new Set(inFlight);
  next.delete(messageId);
  useThreadOutboxStore.setState({ inFlight: next });
}

/**
 * The next row to send per thread, oldest first. A thread waits while its
 * oldest row is in flight or backing off, so its messages keep their order.
 */
export function selectThreadSubmissionsToSend(input: {
  readonly submissions: ReadonlyArray<PendingThreadSubmission>;
  readonly inFlight: ReadonlySet<MessageId>;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly retryAtByMessageId: ReadonlyMap<MessageId, number>;
  readonly nowMs: number;
}): ReadonlyArray<PendingThreadSubmission> {
  const seenThreads = new Set<string>();
  const next: PendingThreadSubmission[] = [];
  for (const submission of sortSubmissions(input.submissions)) {
    const threadKey = `${submission.environmentId}:${submission.threadId}`;
    if (seenThreads.has(threadKey)) continue;
    seenThreads.add(threadKey);
    if (!input.connectedEnvironmentIds.has(submission.environmentId)) continue;
    if (input.inFlight.has(submission.messageId)) continue;
    if ((input.retryAtByMessageId.get(submission.messageId) ?? 0) > input.nowMs) continue;
    next.push(submission);
  }
  return next;
}

export type ThreadSubmissionOutcome = "delivered" | "retry" | "rejected";

/** Interrupted and transport-shaped failures stay queued; a server decision drops the row. */
export function resolveThreadSubmissionOutcome(
  failure: { readonly interrupted: boolean; readonly error: unknown } | null,
): ThreadSubmissionOutcome {
  if (failure === null) return "delivered";
  return failure.interrupted || isRetryableThreadSubmissionError(failure.error)
    ? "retry"
    : "rejected";
}

export function threadSubmissionFailure(result: AtomCommandResult<unknown, unknown>) {
  return result._tag === "Success"
    ? null
    : { interrupted: isAtomCommandInterrupted(result), error: squashAtomCommandFailure(result) };
}

/**
 * Settles a row its sender claimed: true when it stays queued for the drain
 * (the send may not have reached the server), false once it is gone.
 */
export function settleClaimedThreadSubmission(
  messageId: MessageId,
  result: AtomCommandResult<unknown, unknown>,
): boolean {
  if (resolveThreadSubmissionOutcome(threadSubmissionFailure(result)) === "retry") {
    releaseThreadSubmission(messageId);
    return true;
  }
  removeThreadSubmission(messageId);
  return false;
}

/** Presents a stored row as an optimistic transcript message. */
export function pendingSubmissionToChatMessage(submission: PendingThreadSubmission): ChatMessage {
  return {
    id: submission.messageId,
    role: "user",
    text: submission.text,
    ...(submission.attachments.length > 0
      ? {
          attachments: submission.attachments.map((attachment, index) =>
            "dataUrl" in attachment
              ? {
                  type: "image" as const,
                  id: attachment.id ?? `${submission.messageId}-${index}`,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  sizeBytes: attachment.sizeBytes,
                  previewUrl: attachment.dataUrl,
                }
              : attachment,
          ),
        }
      : {}),
    ...(submission.context === undefined ? {} : { context: submission.context }),
    runId: null,
    createdAt: submission.createdAt,
    updatedAt: submission.createdAt,
    streaming: false,
  };
}
