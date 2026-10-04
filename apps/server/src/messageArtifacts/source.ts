import type { MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * An assistant message as summaries and speech scripts see it: read from the
 * v2 projection (lazily imported legacy transcripts included once imported),
 * with the run's model as generation provenance.
 */
export interface MessageArtifactSource {
  readonly messageId: string;
  readonly threadId: string;
  readonly role: string;
  readonly streaming: number;
  readonly text: string;
  /** JSON model selection of the run that produced the message, if any. */
  readonly runModelSelection: string | null;
  /** JSON model selection the thread uses now; a fallback for runless messages. */
  readonly threadModelSelection: string | null;
  readonly cwd: string | null;
}

export const isUsableArtifactSource = (
  source: MessageArtifactSource | undefined,
): source is MessageArtifactSource =>
  source !== undefined &&
  source.role === "assistant" &&
  source.streaming === 0 &&
  source.text.trim().length > 0;

export const findMessageArtifactSource = (sql: SqlClient.SqlClient, messageId: MessageId) =>
  sql<MessageArtifactSource>`
      SELECT
        message.message_id AS "messageId",
        message.thread_id AS "threadId",
        message.role,
        message.streaming,
        COALESCE(json_extract(message.payload_json, '$.text'), '') AS text,
        json_extract(run.payload_json, '$.modelSelection') AS "runModelSelection",
        json_extract(thread.payload_json, '$.modelSelection') AS "threadModelSelection",
        COALESCE(json_extract(thread.payload_json, '$.worktreePath'), project.workspace_root) AS cwd
      FROM orchestration_v2_projection_messages AS message
      INNER JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = message.thread_id
        AND thread.deleted_at IS NULL
      LEFT JOIN orchestration_v2_projection_runs AS run
        ON run.run_id = message.run_id
      LEFT JOIN projection_projects AS project
        ON project.project_id = thread.project_id
        AND project.deleted_at IS NULL
      WHERE message.message_id = ${messageId}
      LIMIT 1
    `.pipe(Effect.map((rows) => rows[0]));

/**
 * SQL condition that holds only while the message still has exactly the text
 * an artifact was generated from. Writes use it so an edit, deletion, or new
 * streaming pass that landed during generation never stores a stale artifact.
 */
export const currentArtifactSourceCondition = (
  sql: SqlClient.SqlClient,
  source: Pick<MessageArtifactSource, "messageId" | "threadId" | "text">,
) => sql`
  EXISTS (
    SELECT 1
    FROM orchestration_v2_projection_messages AS message
    INNER JOIN orchestration_v2_projection_threads AS thread
      ON thread.thread_id = message.thread_id
      AND thread.deleted_at IS NULL
    WHERE message.message_id = ${source.messageId}
      AND message.thread_id = ${source.threadId}
      AND message.role = 'assistant'
      AND message.streaming = 0
      AND json_extract(message.payload_json, '$.text') = ${source.text}
  )
`;
