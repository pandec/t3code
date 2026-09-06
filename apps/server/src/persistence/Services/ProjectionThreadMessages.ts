/**
 * ProjectionThreadMessageRepository - Projection repository interface for messages.
 *
 * Owns persistence operations for projected thread messages rendered in the
 * orchestration read model.
 *
 * @module ProjectionThreadMessageRepository
 */
import {
  ChatAttachment,
  CommandId,
  MessageId,
  MessageInputOrigin,
  MessageSpeechOrigin,
  NonNegativeInt,
  OrchestrationMessageRole,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  IsoDateTime,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Struct from "effect/Struct";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadMessage = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  inputOrigin: Schema.optional(MessageInputOrigin),
  generationModelSelectionJson: Schema.optional(Schema.String),
  generationCwd: Schema.optional(Schema.String),
  speechRequestId: Schema.optional(Schema.NullOr(CommandId)),
  speechRequestStartedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  isStreaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadMessage = typeof ProjectionThreadMessage.Type;

export const PendingProjectionMessageSpeechRequest = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  requestId: CommandId,
});
export type PendingProjectionMessageSpeechRequest =
  typeof PendingProjectionMessageSpeechRequest.Type;

export const ProjectionMessageSpeech = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  speechId: TrimmedNonEmptyString,
  transcript: TrimmedNonEmptyString,
  mimeType: Schema.Literal("audio/mpeg"),
  sizeBytes: NonNegativeInt,
  sourceTextHash: TrimmedNonEmptyString,
  scriptRecipeHash: TrimmedNonEmptyString,
  voiceId: TrimmedNonEmptyString,
  ttsModel: TrimmedNonEmptyString,
  origin: MessageSpeechOrigin,
  createdAt: IsoDateTime,
});
export type ProjectionMessageSpeech = typeof ProjectionMessageSpeech.Type;

export const AppendStreamingProjectionThreadMessage = Schema.Struct(
  Struct.omit(ProjectionThreadMessage.fields, [
    "generationModelSelectionJson",
    "generationCwd",
    "speechRequestId",
    "speechRequestStartedAt",
    "isStreaming",
  ]),
);
export type AppendStreamingProjectionThreadMessage =
  typeof AppendStreamingProjectionThreadMessage.Type;

export const ListProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadMessagesInput = typeof ListProjectionThreadMessagesInput.Type;

export const GetProjectionThreadMessageInput = Schema.Struct({
  messageId: MessageId,
});
export type GetProjectionThreadMessageInput = typeof GetProjectionThreadMessageInput.Type;

export const HasProjectionThreadAssistantMessageInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  streamingOnly: Schema.Boolean,
});
export type HasProjectionThreadAssistantMessageInput =
  typeof HasProjectionThreadAssistantMessageInput.Type;

export const GetLatestProjectionThreadAssistantMessageInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type GetLatestProjectionThreadAssistantMessageInput =
  typeof GetLatestProjectionThreadAssistantMessageInput.Type;

export const DeleteProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadMessagesInput = typeof DeleteProjectionThreadMessagesInput.Type;

export const CopyProjectionThreadMessagesForForkInput = Schema.Struct({
  sourceThreadId: ThreadId,
  destinationThreadId: ThreadId,
});
export type CopyProjectionThreadMessagesForForkInput =
  typeof CopyProjectionThreadMessagesForForkInput.Type;

/**
 * ProjectionThreadMessageRepositoryShape - Service API for projected thread messages.
 */
export interface ProjectionThreadMessageRepositoryShape {
  /**
   * Insert or replace a projected thread message row.
   *
   * Upserts by `messageId`.
   */
  readonly upsert: (
    message: ProjectionThreadMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Insert a streaming message or append text to its existing row. */
  readonly appendStreaming: (
    message: AppendStreamingProjectionThreadMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected thread message by id.
   */
  readonly getByMessageId: (
    input: GetProjectionThreadMessageInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * Read raw projected speech metadata by message id.
   */
  readonly getSpeechByMessageId: (
    input: GetProjectionThreadMessageInput,
  ) => Effect.Effect<Option.Option<ProjectionMessageSpeech>, ProjectionRepositoryError>;

  /**
   * List persisted message speech requests that need startup reconciliation.
   */
  readonly listPendingSpeechRequests: Effect.Effect<
    ReadonlyArray<PendingProjectionMessageSpeechRequest>,
    ProjectionRepositoryError
  >;

  /**
   * Check for an assistant message in a turn without hydrating message text.
   */
  readonly hasAssistantMessageForTurn: (
    input: HasProjectionThreadAssistantMessageInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /**
   * Read the id of the turn's most recent assistant message without hydrating
   * message text. Ordered like thread detail (creation time, then id).
   */
  readonly getLatestAssistantMessageIdForTurn: (
    input: GetLatestProjectionThreadAssistantMessageInput,
  ) => Effect.Effect<Option.Option<MessageId>, ProjectionRepositoryError>;

  /**
   * List projected thread messages for a thread.
   *
   * Returned in ascending creation order.
   */
  readonly listByThreadId: (
    input: ListProjectionThreadMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /** Read the latest user-message timestamp without loading message bodies. */
  readonly getLatestUserMessageAt: (
    input: ListProjectionThreadMessagesInput,
  ) => Effect.Effect<ProjectionThreadMessage["createdAt"] | null, ProjectionRepositoryError>;

  /**
   * Delete projected thread messages by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadMessagesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly copyTextMessagesForFork: (
    input: CopyProjectionThreadMessagesForForkInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadMessageRepository - Service tag for message projection persistence.
 */
export class ProjectionThreadMessageRepository extends Context.Service<
  ProjectionThreadMessageRepository,
  ProjectionThreadMessageRepositoryShape
>()("t3/persistence/Services/ProjectionThreadMessages/ProjectionThreadMessageRepository") {}
