import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import {
  ChatAttachment,
  CommandId,
  IsoDateTime,
  MessageId,
  MessageInputOrigin,
} from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  AppendStreamingProjectionThreadMessage,
  GetProjectionThreadMessageInput,
  CopyProjectionThreadMessagesForForkInput,
  GetLatestProjectionThreadAssistantMessageInput,
  HasProjectionThreadAssistantMessageInput,
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
  DeleteProjectionThreadMessagesInput,
  ListProjectionThreadMessagesInput,
  PendingProjectionMessageSpeechRequest,
  ProjectionMessageSpeech,
  ProjectionThreadMessage,
} from "../Services/ProjectionThreadMessages.ts";

const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    inputOrigin: Schema.NullOr(MessageInputOrigin),
    generationModelSelectionJson: Schema.NullOr(Schema.String),
    generationCwd: Schema.NullOr(Schema.String),
    speechRequestId: Schema.NullOr(CommandId),
    speechRequestStartedAt: Schema.NullOr(IsoDateTime),
  }),
);
const ProjectionThreadMessageExistsDbRowSchema = Schema.Struct({ exists: Schema.Number });
const ProjectionThreadMessageIdDbRowSchema = Schema.Struct({ messageId: MessageId });

function toProjectionThreadMessage(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): ProjectionThreadMessage {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    turnId: row.turnId,
    role: row.role,
    text: row.text,
    isStreaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    ...(row.inputOrigin !== null ? { inputOrigin: row.inputOrigin } : {}),
    ...(row.generationModelSelectionJson !== null
      ? { generationModelSelectionJson: row.generationModelSelectionJson }
      : {}),
    ...(row.generationCwd !== null ? { generationCwd: row.generationCwd } : {}),
    speechRequestId: row.speechRequestId,
    speechRequestStartedAt: row.speechRequestStartedAt,
  };
}

const makeProjectionThreadMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadMessageRow = SqlSchema.void({
    Request: ProjectionThreadMessage,
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      const speechRequestSpecified =
        row.speechRequestId !== undefined || row.speechRequestStartedAt !== undefined;
      return sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          input_origin,
          generation_model_selection_json,
          generation_cwd,
          speech_request_id,
          speech_request_started_at,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.threadId},
          ${row.turnId},
          ${row.role},
          ${row.text},
          COALESCE(
            ${nextAttachmentsJson},
            (
              SELECT attachments_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          COALESCE(
            ${row.inputOrigin ?? null},
            (
              SELECT input_origin
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          COALESCE(
            ${row.generationModelSelectionJson ?? null},
            (
              SELECT generation_model_selection_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          COALESCE(
            ${row.generationCwd ?? null},
            (
              SELECT generation_cwd
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          ${row.speechRequestId ?? null},
          ${row.speechRequestStartedAt ?? null},
          ${row.isStreaming ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          role = excluded.role,
          text = excluded.text,
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_thread_messages.attachments_json
          ),
          input_origin = COALESCE(
            excluded.input_origin,
            projection_thread_messages.input_origin
          ),
          generation_model_selection_json = COALESCE(
            excluded.generation_model_selection_json,
            projection_thread_messages.generation_model_selection_json
          ),
          generation_cwd = COALESCE(
            excluded.generation_cwd,
            projection_thread_messages.generation_cwd
          ),
          speech_request_id = CASE
            WHEN ${speechRequestSpecified ? 1 : 0} = 1 THEN excluded.speech_request_id
            ELSE projection_thread_messages.speech_request_id
          END,
          speech_request_started_at = CASE
            WHEN ${speechRequestSpecified ? 1 : 0} = 1 THEN excluded.speech_request_started_at
            ELSE projection_thread_messages.speech_request_started_at
          END,
          is_streaming = excluded.is_streaming,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `;
    },
  });

  const appendStreamingProjectionThreadMessageRow = SqlSchema.void({
    Request: AppendStreamingProjectionThreadMessage,
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      return sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          input_origin,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.threadId},
          ${row.turnId},
          ${row.role},
          ${row.text},
          ${nextAttachmentsJson},
          ${row.inputOrigin ?? null},
          1,
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          role = excluded.role,
          text = projection_thread_messages.text || excluded.text,
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_thread_messages.attachments_json
          ),
          input_origin = COALESCE(
            excluded.input_origin,
            projection_thread_messages.input_origin
          ),
          is_streaming = 1,
          updated_at = excluded.updated_at
      `;
    },
  });

  const getProjectionThreadMessageRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadMessageInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          input_origin AS "inputOrigin",
          generation_model_selection_json AS "generationModelSelectionJson",
          generation_cwd AS "generationCwd",
          speech_request_id AS "speechRequestId",
          speech_request_started_at AS "speechRequestStartedAt",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
        LIMIT 1
      `,
  });

  const getProjectionMessageSpeechRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadMessageInput,
    Result: ProjectionMessageSpeech,
    execute: ({ messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          speech_id AS "speechId",
          transcript,
          mime_type AS "mimeType",
          size_bytes AS "sizeBytes",
          source_text_hash AS "sourceTextHash",
          script_recipe_hash AS "scriptRecipeHash",
          voice_id AS "voiceId",
          tts_model AS "ttsModel",
          origin,
          created_at AS "createdAt"
        FROM projection_message_speech
        WHERE message_id = ${messageId}
        LIMIT 1
      `,
  });

  const listPendingProjectionMessageSpeechRequestRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PendingProjectionMessageSpeechRequest,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          message_id AS "messageId",
          speech_request_id AS "requestId"
        FROM projection_thread_messages
        WHERE speech_request_id IS NOT NULL
        ORDER BY thread_id ASC, message_id ASC
      `,
  });

  const hasProjectionThreadAssistantMessageRow = SqlSchema.findOne({
    Request: HasProjectionThreadAssistantMessageInput,
    Result: ProjectionThreadMessageExistsDbRowSchema,
    execute: ({ threadId, turnId, streamingOnly }) =>
      sql`
        SELECT EXISTS (
          SELECT 1
          FROM projection_thread_messages
          WHERE thread_id = ${threadId}
            AND turn_id = ${turnId}
            AND role = 'assistant'
            AND (${streamingOnly ? 1 : 0} = 0 OR is_streaming = 1)
          LIMIT 1
        ) AS "exists"
      `,
  });

  const getLatestProjectionThreadAssistantMessageIdRow = SqlSchema.findOneOption({
    Request: GetLatestProjectionThreadAssistantMessageInput,
    Result: ProjectionThreadMessageIdDbRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT message_id AS "messageId"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
          AND role = 'assistant'
        ORDER BY created_at DESC, message_id DESC
        LIMIT 1
      `,
  });

  const listProjectionThreadMessageRows = SqlSchema.findAll({
    Request: ListProjectionThreadMessagesInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          input_origin AS "inputOrigin",
          generation_model_selection_json AS "generationModelSelectionJson",
          generation_cwd AS "generationCwd",
          speech_request_id AS "speechRequestId",
          speech_request_started_at AS "speechRequestStartedAt",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const getLatestUserMessageAtRow = SqlSchema.findOne({
    Request: ListProjectionThreadMessagesInput,
    Result: Schema.Struct({
      latestUserMessageAt: Schema.NullOr(ProjectionThreadMessage.fields.createdAt),
    }),
    execute: ({ threadId }) => sql`
      SELECT MAX(created_at) AS "latestUserMessageAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND role = 'user'
        AND message_id NOT GLOB 'import:*'
    `,
  });

  const deleteProjectionThreadMessageRows = SqlSchema.void({
    Request: DeleteProjectionThreadMessagesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `,
  });

  const copyProjectionThreadMessageRowsForFork = SqlSchema.void({
    Request: CopyProjectionThreadMessagesForForkInput,
    execute: ({ sourceThreadId, destinationThreadId }) =>
      sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          input_origin,
          generation_model_selection_json,
          generation_cwd,
          speech_request_id,
          speech_request_started_at,
          is_streaming,
          created_at,
          updated_at
        )
        SELECT
          'fork:' || ${destinationThreadId} || ':' || message_id,
          ${destinationThreadId},
          turn_id,
          role,
          text,
          NULL,
          input_origin,
          generation_model_selection_json,
          generation_cwd,
          NULL,
          NULL,
          0,
          created_at,
          updated_at
        FROM projection_thread_messages
        WHERE thread_id = ${sourceThreadId}
          AND role IN ('user', 'assistant')
          AND is_streaming = 0
        ON CONFLICT (message_id) DO NOTHING
      `,
  });

  const upsert: ProjectionThreadMessageRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadMessageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadMessageRepository.upsert:query")),
    );

  const appendStreaming: ProjectionThreadMessageRepositoryShape["appendStreaming"] = (row) =>
    appendStreamingProjectionThreadMessageRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.appendStreaming:query"),
      ),
    );

  const getByMessageId: ProjectionThreadMessageRepositoryShape["getByMessageId"] = (input) =>
    getProjectionThreadMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getByMessageId:query"),
      ),
      Effect.map(Option.map(toProjectionThreadMessage)),
    );

  const getSpeechByMessageId: ProjectionThreadMessageRepositoryShape["getSpeechByMessageId"] = (
    input,
  ) =>
    getProjectionMessageSpeechRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getSpeechByMessageId:query"),
      ),
    );

  const listPendingSpeechRequests: ProjectionThreadMessageRepositoryShape["listPendingSpeechRequests"] =
    listPendingProjectionMessageSpeechRequestRows().pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.listPendingSpeechRequests:query"),
      ),
    );

  const hasAssistantMessageForTurn: ProjectionThreadMessageRepositoryShape["hasAssistantMessageForTurn"] =
    (input) =>
      hasProjectionThreadAssistantMessageRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadMessageRepository.hasAssistantMessageForTurn:query",
          ),
        ),
        Effect.map((row) => row.exists === 1),
      );

  const getLatestAssistantMessageIdForTurn: ProjectionThreadMessageRepositoryShape["getLatestAssistantMessageIdForTurn"] =
    (input) =>
      getLatestProjectionThreadAssistantMessageIdRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadMessageRepository.getLatestAssistantMessageIdForTurn:query",
          ),
        ),
        Effect.map(Option.map((row) => row.messageId)),
      );

  const listByThreadId: ProjectionThreadMessageRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.listByThreadId:query"),
      ),
      Effect.map((rows) => rows.map(toProjectionThreadMessage)),
    );

  const getLatestUserMessageAt: ProjectionThreadMessageRepositoryShape["getLatestUserMessageAt"] = (
    input,
  ) =>
    getLatestUserMessageAtRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getLatestUserMessageAt:query"),
      ),
      Effect.map((row) => row.latestUserMessageAt),
    );

  const deleteByThreadId: ProjectionThreadMessageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.deleteByThreadId:query"),
      ),
    );

  const copyTextMessagesForFork: ProjectionThreadMessageRepositoryShape["copyTextMessagesForFork"] =
    (input) =>
      copyProjectionThreadMessageRowsForFork(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadMessageRepository.copyTextMessagesForFork:query"),
        ),
      );

  return {
    upsert,
    appendStreaming,
    getByMessageId,
    getSpeechByMessageId,
    listPendingSpeechRequests,
    hasAssistantMessageForTurn,
    getLatestAssistantMessageIdForTurn,
    listByThreadId,
    getLatestUserMessageAt,
    deleteByThreadId,
    copyTextMessagesForFork,
  } satisfies ProjectionThreadMessageRepositoryShape;
});

export const ProjectionThreadMessageRepositoryLive = Layer.effect(
  ProjectionThreadMessageRepository,
  makeProjectionThreadMessageRepository,
);
