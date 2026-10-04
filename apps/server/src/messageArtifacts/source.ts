import type { MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";

/**
 * An assistant message as summaries and speech scripts see it: read from the
 * v2 projection (lazily imported legacy transcripts included once imported),
 * with the producing run attempt's model as generation provenance.
 */
export interface MessageArtifactSource {
  readonly messageId: string;
  readonly threadId: string;
  readonly role: string;
  readonly streaming: number;
  readonly text: string;
  /** JSON model selection the run had while the message's attempt ran, if any. */
  readonly runModelSelection: string | null;
  /** JSON model selection the thread uses now; a fallback for runless messages. */
  readonly threadModelSelection: string | null;
  readonly cwd: string | null;
}

export const isUsableArtifactSource = <
  Source extends Pick<MessageArtifactSource, "role" | "streaming" | "text">,
>(
  source: Source | undefined,
): source is Source =>
  source !== undefined &&
  source.role === "assistant" &&
  source.streaming === 0 &&
  source.text.trim().length > 0;

/**
 * Joins `message` (an `orchestration_v2_projection_messages` alias) to the
 * model its run used while the message's attempt ran, selected by
 * `producingRunModelSelection`. A steering restart replaces the run's model
 * and root node in place, so the run row only knows the latest attempt; the
 * thread's run events keep each attempt's model. Runs without events fall back
 * to the run row. `threadIds` (an `IN` list or subquery naming the messages'
 * threads) scopes the one pass over their events.
 */
export const producingRunModelJoin = (
  sql: SqlClient.SqlClient,
  threadIds: Statement.Fragment,
) => sql`
  LEFT JOIN orchestration_v2_projection_runs AS run
    ON run.run_id = message.run_id
  LEFT JOIN orchestration_v2_projection_nodes AS message_node
    ON message_node.node_id = message.node_id
  LEFT JOIN (
    SELECT
      json_extract(payload_json, '$.id') AS run_id,
      json_extract(payload_json, '$.rootNodeId') AS root_node_id,
      json_extract(payload_json, '$.modelSelection') AS model_selection,
      MAX(sequence) AS sequence
    FROM orchestration_events
    WHERE application_event_version = 2
      AND aggregate_kind = 'thread'
      AND stream_id IN ${threadIds}
      AND event_type IN ('run.created', 'run.updated')
    GROUP BY run_id, root_node_id
  ) AS attempt_run
    ON attempt_run.run_id = message.run_id
    AND attempt_run.root_node_id = COALESCE(message_node.root_node_id, message.node_id)
`;

export const producingRunModelSelection = (sql: SqlClient.SqlClient) => sql`
  COALESCE(attempt_run.model_selection, json_extract(run.payload_json, '$.modelSelection'))
`;

export const findMessageArtifactSource = (sql: SqlClient.SqlClient, messageId: MessageId) =>
  sql<MessageArtifactSource>`
      SELECT
        message.message_id AS "messageId",
        message.thread_id AS "threadId",
        message.role,
        message.streaming,
        COALESCE(json_extract(message.payload_json, '$.text'), '') AS text,
        ${producingRunModelSelection(sql)} AS "runModelSelection",
        json_extract(thread.payload_json, '$.modelSelection') AS "threadModelSelection",
        COALESCE(json_extract(thread.payload_json, '$.worktreePath'), project.workspace_root) AS cwd
      FROM orchestration_v2_projection_messages AS message
      INNER JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = message.thread_id
        AND thread.deleted_at IS NULL
      ${producingRunModelJoin(
        sql,
        sql`(SELECT thread_id FROM orchestration_v2_projection_messages WHERE message_id = ${messageId})`,
      )}
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
