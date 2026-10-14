/**
 * Fork: notes a thread's next provider turn carries without showing them in the
 * transcript. ProviderTurnStartService prepends pending notes to the provider
 * text (beside the restart notices) and acknowledges them once the provider
 * accepts the turn, so each note is delivered once. Persisted so a note
 * survives a server restart between being queued and the next user message.
 */
import type { ThreadId } from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlError from "effect/sql/SqlError";
import * as SqlClient from "effect/sql/SqlClient";

interface ThreadHiddenNote {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
}

/** Notes nobody consumed (a launch that never started a turn) expire after this. */
const NOTE_RETENTION_DAYS = 14;

export class ThreadHiddenNotes extends Context.Service<
  ThreadHiddenNotes,
  {
    /** Queues a note; a pending note of the same kind for the thread is replaced. */
    readonly put: (input: {
      readonly threadId: ThreadId;
      readonly kind: string;
      readonly text: string;
    }) => Effect.Effect<void, SqlError.SqlError>;
    /** Drops a pending note of `kind`, e.g. a failure the thread no longer needs to hear about. */
    readonly remove: (input: {
      readonly threadId: ThreadId;
      readonly kind: string;
    }) => Effect.Effect<void, SqlError.SqlError>;
    /** Pending notes, oldest first. A failed read delivers nothing rather than failing the turn. */
    readonly pending: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<ThreadHiddenNote>>;
    /** Marks notes delivered. A note replaced since it was read stays pending. */
    readonly acknowledge: (ids: ReadonlyArray<string>) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadHiddenNotes") {}

/** The text block a provider turn carries for `notes`; empty when there are none. */
export const renderThreadHiddenNotes = (notes: ReadonlyArray<ThreadHiddenNote>): string =>
  notes.length === 0
    ? ""
    : ["<system-reminder>", ...notes.map((note) => note.text), "</system-reminder>"].join("\n");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return ThreadHiddenNotes.of({
    put: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const noteId = yield* randomUuidV4;
        const cutoff = DateTime.formatIso(DateTime.subtract(now, { days: NOTE_RETENTION_DAYS }));
        yield* sql`DELETE FROM fork_thread_hidden_notes WHERE created_at < ${cutoff}`;
        yield* sql`
          INSERT INTO fork_thread_hidden_notes (note_id, thread_id, kind, text, created_at)
          VALUES (${noteId}, ${input.threadId}, ${input.kind}, ${input.text}, ${DateTime.formatIso(now)})
          ON CONFLICT (thread_id, kind) DO UPDATE SET
            note_id = excluded.note_id,
            text = excluded.text,
            created_at = excluded.created_at
        `;
      }),
    remove: (input) =>
      sql`
        DELETE FROM fork_thread_hidden_notes
        WHERE thread_id = ${input.threadId} AND kind = ${input.kind}
      `.pipe(Effect.asVoid),
    pending: (threadId) =>
      sql<{ readonly note_id: string; readonly kind: string; readonly text: string }>`
        SELECT note_id, kind, text FROM fork_thread_hidden_notes
        WHERE thread_id = ${threadId}
        ORDER BY created_at, note_id
      `.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({ id: row.note_id, kind: row.kind, text: row.text })),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read hidden thread notes", { threadId, cause }).pipe(
            Effect.as([]),
          ),
        ),
      ),
    acknowledge: (ids) =>
      ids.length === 0
        ? Effect.void
        : sql`DELETE FROM fork_thread_hidden_notes WHERE note_id IN ${sql.in(ids)}`.pipe(
            Effect.asVoid,
            Effect.catch((cause) =>
              Effect.logWarning("Failed to acknowledge hidden thread notes", { cause }),
            ),
          ),
  });
});

export const layer = Layer.effect(ThreadHiddenNotes, make);
