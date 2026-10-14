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
    /**
     * Queues a note; a pending note of the same kind for the thread is replaced. With
     * `worktreePath`, only a turn running in that worktree hears it; a turn elsewhere drops it.
     */
    readonly put: (input: {
      readonly threadId: ThreadId;
      readonly kind: string;
      readonly text: string;
      readonly worktreePath?: string;
    }) => Effect.Effect<void, SqlError.SqlError>;
    /** Drops a pending note of `kind`, e.g. a failure the thread no longer needs to hear about. */
    readonly remove: (input: {
      readonly threadId: ThreadId;
      readonly kind: string;
    }) => Effect.Effect<void, SqlError.SqlError>;
    /**
     * The notes a message to the thread should carry, oldest first. `turn` is where it runs;
     * notes bound to another worktree are dropped. Null (a steer, whose worktree is not read)
     * leaves worktree-bound notes for the next turn. A failed read delivers nothing rather than
     * failing the message.
     */
    readonly pending: (
      threadId: ThreadId,
      turn: { readonly worktreePath: string | null } | null,
    ) => Effect.Effect<ReadonlyArray<ThreadHiddenNote>>;
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
          INSERT INTO fork_thread_hidden_notes
            (note_id, thread_id, kind, text, worktree_path, created_at)
          VALUES (
            ${noteId}, ${input.threadId}, ${input.kind}, ${input.text},
            ${input.worktreePath ?? null}, ${DateTime.formatIso(now)}
          )
          ON CONFLICT (thread_id, kind) DO UPDATE SET
            note_id = excluded.note_id,
            text = excluded.text,
            worktree_path = excluded.worktree_path,
            created_at = excluded.created_at
        `;
      }),
    remove: (input) =>
      sql`
        DELETE FROM fork_thread_hidden_notes
        WHERE thread_id = ${input.threadId} AND kind = ${input.kind}
      `.pipe(Effect.asVoid),
    pending: (threadId, turn) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly note_id: string;
          readonly kind: string;
          readonly text: string;
          readonly worktree_path: string | null;
        }>`
          SELECT note_id, kind, text, worktree_path FROM fork_thread_hidden_notes
          WHERE thread_id = ${threadId}
          ORDER BY created_at, note_id
        `;
        const misplaced =
          turn === null
            ? []
            : rows.filter(
                (row) => row.worktree_path !== null && row.worktree_path !== turn.worktreePath,
              );
        if (misplaced.length > 0) {
          yield* sql`DELETE FROM fork_thread_hidden_notes WHERE note_id IN ${sql.in(
            misplaced.map((row) => row.note_id),
          )}`;
        }
        return rows
          .filter((row) => row.worktree_path === null || row.worktree_path === turn?.worktreePath)
          .map((row) => ({ id: row.note_id, kind: row.kind, text: row.text }));
      }).pipe(
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
