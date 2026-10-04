import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  OrchestrationMessageContext,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { isTransportConnectionErrorMessage } from "../errors/transport.ts";
import {
  PersistedDraftComposerAttachmentSchema,
  type DraftComposerAttachment,
} from "./composerAttachment.ts";

/**
 * Helpers for the clients' pre-acceptance outboxes: messages the server has not
 * accepted yet (offline, reload). After acceptance the server queue owns them.
 *
 * The fork stored a client-owned outbox (schema versions 1-9) under the same
 * keys/directories the v2 outboxes use. Those rows are decoded here once and
 * rewritten in each client's current shape.
 */

const LegacyQueuedThreadCreationSchema = Schema.Struct({
  projectId: ProjectId,
  projectTitle: Schema.optional(Schema.String),
  projectCwd: Schema.optional(Schema.String),
  workspaceMode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

/** Voice-dictated input; the only origin the fork recorded. */
export const LegacyMessageInputOrigin = Schema.Literal("voice-transcription");
export type LegacyMessageInputOrigin = typeof LegacyMessageInputOrigin.Type;

// Fork-only fields with no v2 meaning (grace anchor, settings fallback, web
// checkout branch) are ignored rather than rejected.
const LegacyQueuedThreadMessageSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2, 3, 4, 5, 6, 7, 8, 9]),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  inputOrigin: Schema.optional(LegacyMessageInputOrigin),
  context: Schema.optional(OrchestrationMessageContext),
  attachments: Schema.Array(PersistedDraftComposerAttachmentSchema),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  deliveryIntent: Schema.optional(Schema.Literals(["queue", "steer"])),
  creation: Schema.optional(LegacyQueuedThreadCreationSchema),
  createdAt: IsoDateTime,
});

const decodeLegacyRow = Schema.decodeUnknownSync(LegacyQueuedThreadMessageSchema);

type LegacyRow = typeof LegacyQueuedThreadMessageSchema.Type;

export interface LegacyQueuedThreadMessage extends Omit<
  LegacyRow,
  "schemaVersion" | "attachments" | "deliveryIntent"
> {
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  /** The fork's delivery intent; rows without one were always queued. */
  readonly dispatchMode: "queue" | "steer";
}

/** Decodes a row written by the fork's client-owned outbox; throws when it is not one. */
export function decodeLegacyQueuedThreadMessage(value: unknown): LegacyQueuedThreadMessage {
  const { schemaVersion: _, deliveryIntent, attachments, ...message } = decodeLegacyRow(value);
  return {
    ...message,
    dispatchMode: deliveryIntent ?? "queue",
    // Fork rows omit the duplicate preview of inline images.
    attachments: attachments.map((attachment): DraftComposerAttachment => {
      if (attachment.type === "file") return attachment;
      if (attachment.dataUrl !== undefined) {
        return { ...attachment, dataUrl: attachment.dataUrl, previewUri: attachment.dataUrl };
      }
      if (attachment.fileUri === undefined) {
        throw new Error(`Queued image '${attachment.name}' has no preview source.`);
      }
      return {
        ...attachment,
        fileUri: attachment.fileUri,
        previewUri: attachment.previewUri ?? attachment.fileUri,
      };
    }),
  };
}

/**
 * Whether a failed send should stay in the outbox. Only a failure the server
 * decided means the payload itself is bad; transport-shaped failures (dropped
 * socket, environment not connected or registered) are retried.
 */
export function isRetryableThreadSubmissionError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "OrchestrationDispatchCommandError":
      case "EnvironmentAuthorizationError":
        return false;
      case "ConnectionTransientError":
      case "RpcClientError":
      case "EnvironmentRpcUnavailableError":
      case "EnvironmentNotRegisteredError":
        return true;
      default:
        break;
    }
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof error.message === "string"
          ? error.message
          : null;
  return isTransportConnectionErrorMessage(message);
}

const THREAD_SUBMISSION_MAX_RETRY_DELAY_MS = 16_000;

export function threadSubmissionRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), THREAD_SUBMISSION_MAX_RETRY_DELAY_MS);
}
