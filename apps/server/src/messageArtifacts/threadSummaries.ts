import { ModelSelection, type MessageSummaryThreadEntry, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MESSAGE_SUMMARY_RECIPE_HASH, messageArtifactTextHash } from "./identity.ts";
import { type MessageArtifactSource, isUsableArtifactSource } from "./source.ts";

const decodeModelSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));

/**
 * The model a message's summary is generated with. The producing run is the
 * provenance; a runless (imported) message falls back to the model its stored
 * summary pinned, then to the thread model, so later thread model changes
 * neither invalidate nor reinterpret a stored summary. Null: no model at all.
 */
export const resolveSummaryProvenance = Effect.fn("resolveSummaryProvenance")(function* (
  source: Pick<MessageArtifactSource, "runModelSelection" | "threadModelSelection">,
  storedModelSelectionJson: string | null,
) {
  const provenanceJson =
    source.runModelSelection ?? storedModelSelectionJson ?? source.threadModelSelection;
  if (provenanceJson === null) return null;
  const modelSelection = yield* decodeModelSelection(provenanceJson);
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  const modelSelectionJson = JSON.stringify(modelSelection);
  return {
    modelSelection,
    modelSelectionJson,
    modelSelectionHash: messageArtifactTextHash(modelSelectionJson),
  };
});

/** Whether a stored summary still describes the message text under the current recipe and model. */
export const isStoredSummaryCurrent = (
  stored: {
    readonly sourceTextHash: string;
    readonly recipeHash: string;
    readonly modelSelectionHash: string;
  },
  current: { readonly sourceTextHash: string; readonly modelSelectionHash: string },
) =>
  stored.sourceTextHash === current.sourceTextHash &&
  stored.recipeHash === MESSAGE_SUMMARY_RECIPE_HASH &&
  stored.modelSelectionHash === current.modelSelectionHash;

interface ThreadSummaryRow extends Pick<
  MessageArtifactSource,
  "role" | "streaming" | "text" | "runModelSelection" | "threadModelSelection"
> {
  readonly messageId: string;
  readonly summary: string;
  readonly sourceTextHash: string;
  readonly recipeHash: string;
  readonly modelSelectionJson: string;
  readonly modelSelectionHash: string;
  readonly createdAt: string;
}

/**
 * The thread's stored summaries that the summarize request would serve from
 * its cache right now; stale ones (changed text, recipe or model) and those of
 * deleted threads are left out.
 */
export const readThreadSummaries = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<ThreadSummaryRow>`
    SELECT
      summary.message_id AS "messageId",
      summary.summary,
      summary.source_text_hash AS "sourceTextHash",
      summary.recipe_hash AS "recipeHash",
      summary.model_selection_json AS "modelSelectionJson",
      summary.model_selection_hash AS "modelSelectionHash",
      summary.created_at AS "createdAt",
      message.role,
      message.streaming,
      COALESCE(json_extract(message.payload_json, '$.text'), '') AS text,
      json_extract(run.payload_json, '$.modelSelection') AS "runModelSelection",
      json_extract(thread.payload_json, '$.modelSelection') AS "threadModelSelection"
    FROM fork_message_summaries AS summary
    INNER JOIN orchestration_v2_projection_messages AS message
      ON message.message_id = summary.message_id
    INNER JOIN orchestration_v2_projection_threads AS thread
      ON thread.thread_id = message.thread_id
      AND thread.deleted_at IS NULL
    LEFT JOIN orchestration_v2_projection_runs AS run
      ON run.run_id = message.run_id
    WHERE summary.thread_id = ${threadId}
    ORDER BY summary.created_at, summary.message_id
  `.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          if (!isUsableArtifactSource(row)) return undefined;
          const provenance = yield* resolveSummaryProvenance(row, row.modelSelectionJson).pipe(
            Effect.orElseSucceed(() => null),
          );
          const sourceTextHash = messageArtifactTextHash(row.text.trim());
          if (
            provenance === null ||
            !isStoredSummaryCurrent(row, {
              sourceTextHash,
              modelSelectionHash: provenance.modelSelectionHash,
            })
          ) {
            return undefined;
          }
          const entry: MessageSummaryThreadEntry = {
            messageId: row.messageId as MessageSummaryThreadEntry["messageId"],
            summary: row.summary as MessageSummaryThreadEntry["summary"],
            createdAt: row.createdAt as MessageSummaryThreadEntry["createdAt"],
            sourceTextHash: sourceTextHash as MessageSummaryThreadEntry["sourceTextHash"],
          };
          return entry;
        }),
      ),
    ),
    Effect.map((entries) =>
      entries.filter((entry): entry is MessageSummaryThreadEntry => entry !== undefined),
    ),
  );
