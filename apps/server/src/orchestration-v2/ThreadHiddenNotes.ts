/**
 * Fork: notes a thread's next provider message carries without showing them in
 * the transcript. Acknowledged only once the provider accepts the message, so
 * each note is delivered once; persisted so it survives a restart before then.
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
const DELIVERED_MARKER_RETENTION_DAYS = 365;

export class ThreadHiddenNotes extends Context.Service<
  ThreadHiddenNotes,
  {
    /**
     * Queues a note; a note of the same kind for the thread is replaced and becomes pending
     * again. With `once`, an existing note of that kind, pending or delivered, is kept
     * instead. With `worktreePath`, only a turn running in that worktree hears it; a turn
     * elsewhere drops it.
     */
    readonly put: (input: {
      readonly threadId: ThreadId;
      readonly kind: string;
      readonly text: string;
      readonly worktreePath?: string;
      readonly once?: boolean;
    }) => Effect.Effect<void, SqlError.SqlError>;
    /** Forgets the note of `kind`, e.g. a failure the thread no longer needs to hear about. */
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
  // Delivered rows stay as markers until retention removes them.
  const markDelivered = (ids: ReadonlyArray<string>) =>
    ids.length === 0
      ? Effect.void
      : Effect.flatMap(DateTime.now, (now) =>
          sql`
            UPDATE fork_thread_hidden_notes SET delivered_at = ${DateTime.formatIso(now)}
            WHERE note_id IN ${sql.in(ids)}
          `.pipe(Effect.asVoid),
        );
  return ThreadHiddenNotes.of({
    put: Effect.fn("ThreadHiddenNotes.put")(function* (input) {
      const now = yield* DateTime.now;
      const noteId = yield* randomUuidV4;
      // Undelivered notes go stale; delivered markers back once-only notes for as long as their
      // owner (e.g. a lab lease) lives, so they are kept far longer and cleared by that owner.
      const cutoff = DateTime.formatIso(DateTime.subtract(now, { days: NOTE_RETENTION_DAYS }));
      const markerCutoff = DateTime.formatIso(
        DateTime.subtract(now, { days: DELIVERED_MARKER_RETENTION_DAYS }),
      );
      yield* sql`
          DELETE FROM fork_thread_hidden_notes
          WHERE (delivered_at IS NULL AND created_at < ${cutoff})
            OR (delivered_at IS NOT NULL AND created_at < ${markerCutoff})
        `;
      const createdAt = DateTime.formatIso(now);
      const worktreePath = input.worktreePath ?? null;
      yield* input.once === true
        ? sql`
              INSERT INTO fork_thread_hidden_notes
                (note_id, thread_id, kind, text, worktree_path, created_at)
              VALUES (${noteId}, ${input.threadId}, ${input.kind}, ${input.text}, ${worktreePath}, ${createdAt})
              ON CONFLICT (thread_id, kind) DO NOTHING
            `
        : sql`
              INSERT INTO fork_thread_hidden_notes
                (note_id, thread_id, kind, text, worktree_path, created_at)
              VALUES (${noteId}, ${input.threadId}, ${input.kind}, ${input.text}, ${worktreePath}, ${createdAt})
              ON CONFLICT (thread_id, kind) DO UPDATE SET
                note_id = excluded.note_id,
                text = excluded.text,
                worktree_path = excluded.worktree_path,
                created_at = excluded.created_at,
                delivered_at = NULL
        `;
    }),
    remove: (input) =>
      sql`
        DELETE FROM fork_thread_hidden_notes
        WHERE thread_id = ${input.threadId} AND kind = ${input.kind}
      `.pipe(Effect.asVoid),
    pending: Effect.fn("ThreadHiddenNotes.pending")(
      function* (threadId, turn) {
        const rows = yield* sql<{
          readonly note_id: string;
          readonly kind: string;
          readonly text: string;
          readonly worktree_path: string | null;
        }>`
          SELECT note_id, kind, text, worktree_path FROM fork_thread_hidden_notes
          WHERE thread_id = ${threadId} AND delivered_at IS NULL
          ORDER BY created_at, note_id
        `;
        const misplaced =
          turn === null
            ? []
            : rows.filter(
                (row) => row.worktree_path !== null && row.worktree_path !== turn.worktreePath,
              );
        // Settled like a delivered note, so a note queued once is not queued again.
        yield* markDelivered(misplaced.map((row) => row.note_id));
        return rows
          .filter((row) => row.worktree_path === null || row.worktree_path === turn?.worktreePath)
          .map((row) => ({ id: row.note_id, kind: row.kind, text: row.text }));
      },
      (effect, threadId) =>
        effect.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to read hidden thread notes", { threadId, cause }).pipe(
              Effect.as([]),
            ),
          ),
        ),
    ),
    acknowledge: (ids) =>
      markDelivered(ids).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to acknowledge hidden thread notes", { cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(ThreadHiddenNotes, make);
