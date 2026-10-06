import type {
  ChatAttachment,
  OrchestrationMessageContext,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import {
  decodeThreadHistoryCursor,
  encodeThreadHistoryCursor,
} from "../orchestration-v2/threadHistoryPaging.ts";
import { threadCliState } from "./threadState.ts";

export class ThreadCliMessageCursorError extends Schema.TaggedError<ThreadCliMessageCursorError>()(
  "ThreadCliMessageCursorError",
  {
    operation: Schema.Literal("fetchThreadMessages"),
    threadId: Schema.String,
    cursor: Schema.String,
    reason: Schema.Literals(["empty", "not-found", "changed"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "empty":
        return "The --before cursor must not be empty.";
      case "not-found":
        return `'${this.cursor}' is not a transcript cursor. Pass the nextBefore value of an earlier \`t3 thread messages ${this.threadId}\` call, or rerun without --before.`;
      case "changed":
        return `The history of thread '${this.threadId}' changed while reading it. Rerun the command.`;
    }
  }
}

/** Validates a user-supplied `--before` cursor before it reaches the server. */
export const parseThreadMessagesCursor = (
  threadId: string,
  raw: string,
): Effect.Effect<string, ThreadCliMessageCursorError> => {
  const cursor = raw.trim();
  if (cursor.length === 0) {
    return Effect.fail(
      new ThreadCliMessageCursorError({
        operation: "fetchThreadMessages",
        threadId,
        cursor: raw,
        reason: "empty",
      }),
    );
  }
  try {
    decodeThreadHistoryCursor(cursor);
    return Effect.succeed(cursor);
  } catch {
    return Effect.fail(
      new ThreadCliMessageCursorError({
        operation: "fetchThreadMessages",
        threadId,
        cursor,
        reason: "not-found",
      }),
    );
  }
};

/**
 * Whether a `--before` cursor can belong to `threadId`: its anchor row comes
 * from the thread itself or from a thread it was forked from (inherited
 * history). True when the fork chain leaves `threads`, since lineage beyond
 * the known threads cannot be judged.
 */
export const threadMessagesCursorMayBelongTo = (
  cursor: string,
  threadId: string,
  threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id" | "forkedFrom">>,
): boolean => {
  const source = decodeThreadHistoryCursor(cursor).st;
  const byId = new Map(threads.map((thread) => [String(thread.id), thread]));
  const visited = new Set<string>();
  let current = threadId;
  for (;;) {
    if (current === source) return true;
    const thread = byId.get(current);
    if (thread === undefined) return true;
    const fork = thread.forkedFrom;
    if (fork === null) return false;
    if (fork.type !== "run") return true;
    visited.add(current);
    current = fork.threadId;
    if (visited.has(current)) return false;
  }
};

export const THREAD_MESSAGE_ROLES = ["user", "assistant", "system", "reasoning"] as const;
export type ThreadMessageRole = (typeof THREAD_MESSAGE_ROLES)[number];

export interface ThreadTranscriptMessage {
  readonly id: string;
  readonly role: ThreadMessageRole;
  readonly text: string;
  readonly context: OrchestrationMessageContext | undefined;
  readonly createdAt: string;
  readonly turnId: string | null;
  readonly streaming: boolean;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

/** The transcript entry for one timeline row; tool, plan and control rows
    have none. Reasoning is a native v2 item, so it is always present and
    only filtered at report time. */
export const transcriptMessageFromRow = (
  row: OrchestrationV2ProjectedTurnItem,
): ThreadTranscriptMessage | null => {
  const item = row.item;
  const base = {
    createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
    turnId: item.runId,
  };
  switch (item.type) {
    case "user_message":
      return {
        ...base,
        id: item.messageId,
        role: "user",
        text: item.text,
        context: item.context,
        streaming: false,
        attachments: item.attachments,
      };
    case "assistant_message":
      return {
        ...base,
        id: item.messageId,
        role: "assistant",
        text: item.text,
        context: undefined,
        streaming: item.streaming,
        attachments: item.attachments ?? [],
      };
    case "reasoning":
      return {
        ...base,
        id: item.id,
        role: "reasoning",
        text: item.text,
        context: undefined,
        streaming: item.streaming,
        attachments: [],
      };
    case "system_notice":
      return {
        ...base,
        id: item.id,
        role: "system",
        text: item.message,
        context: undefined,
        streaming: false,
        attachments: [],
      };
    default:
      return null;
  }
};

/** One chronological slice of a thread timeline plus the cursor to the rows
    before it (the bounded snapshot window or a history page). */
export interface ThreadTimelineSlice {
  readonly rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly snapshotSequence: number;
  readonly olderCursor: string | null;
}

export interface ThreadMessagesFetchDeps<E, R> {
  readonly fetchLatest: (threadId: ThreadId) => Effect.Effect<ThreadTimelineSlice, E, R>;
  readonly fetchOlder: (
    threadId: ThreadId,
    cursor: string,
  ) => Effect.Effect<ThreadTimelineSlice, E, R>;
}

export interface ThreadMessagesWindow {
  readonly messages: ReadonlyArray<ThreadTranscriptMessage>;
  readonly hasMoreOlder: boolean;
  /** Cursor for `--before` that continues right before `messages[0]`. */
  readonly nextBefore: string | null;
}

/**
 * Reads the newest `limit` transcript messages (all when null) older than
 * `before`, paging back through v2 history. `limit` counts every transcript
 * role, before report-time role filtering, as the fork did.
 */
export const collectThreadMessages = Effect.fn("collectThreadMessages")(function* <E, R>(
  input: {
    readonly threadId: ThreadId;
    readonly before: string | null;
    readonly limit: number | null;
  },
  deps: ThreadMessagesFetchDeps<E, R>,
) {
  // Slices arrive newest first, each internally chronological.
  const slicesNewestFirst: Array<ReadonlyArray<ThreadTranscriptMessage>> = [];
  const finish = (hasMoreOlder: boolean, nextBefore: string | null): ThreadMessagesWindow => ({
    messages: slicesNewestFirst.toReversed().flat(),
    hasMoreOlder,
    nextBefore,
  });
  const requestedCursors = new Set<string>();
  if (input.before !== null) requestedCursors.add(input.before);
  let collected = 0;
  let slice =
    input.before === null
      ? yield* deps.fetchLatest(input.threadId)
      : yield* deps.fetchOlder(input.threadId, input.before);
  for (;;) {
    const entries = slice.rows.flatMap((row) => {
      const message = transcriptMessageFromRow(row);
      return message === null ? [] : [{ row, message }];
    });
    const remaining = input.limit === null ? null : input.limit - collected;
    if (remaining !== null && entries.length > remaining) {
      // The limit cuts inside this slice: continue from the oldest kept row.
      const kept = entries.slice(entries.length - remaining);
      slicesNewestFirst.push(kept.map((entry) => entry.message));
      const oldest = kept[0]!.row;
      // Slice rows are renumbered from 0; the server's cursors carry the
      // absolute timeline position, which the slice's own older cursor holds
      // for its first row.
      const base = slice.olderCursor === null ? 0 : decodeThreadHistoryCursor(slice.olderCursor).p;
      return finish(
        true,
        encodeThreadHistoryCursor({
          snapshotSequence: slice.snapshotSequence,
          sourceThreadId: oldest.sourceThreadId,
          sourceItemId: oldest.sourceItemId,
          position: base + oldest.position,
        }),
      );
    }
    slicesNewestFirst.push(entries.map((entry) => entry.message));
    collected += entries.length;
    const cursor = slice.olderCursor;
    if (cursor === null) return finish(false, null);
    if (input.limit !== null && collected >= input.limit) return finish(true, cursor);
    // A cursor that repeats means the timeline moved under the read; looping
    // on it would never end.
    if (requestedCursors.has(cursor)) {
      return yield* new ThreadCliMessageCursorError({
        operation: "fetchThreadMessages",
        threadId: input.threadId,
        cursor,
        reason: "changed",
      });
    }
    requestedCursors.add(cursor);
    slice = yield* deps.fetchOlder(input.threadId, cursor);
  }
});

export interface ThreadMessagesMachine {
  readonly hostname: string;
  readonly environmentId: string | null;
  readonly environmentLabel: string | null;
  readonly platform: string | null;
}

/** The fork's `thread messages` JSON document. */
export const threadMessagesReport = (input: {
  readonly threadId: string;
  // Null when the thread is not in the active shell: the history read still
  // served it, so it exists but is archived.
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly window: ThreadMessagesWindow;
  readonly role: ThreadMessageRole | null;
  readonly machine: ThreadMessagesMachine;
  readonly attachmentsDir: string;
  readonly attachmentFileExists: (path: string) => boolean;
}) => {
  const visible = input.window.messages.filter((message) =>
    input.role === null
      ? message.role === "user" || message.role === "assistant"
      : message.role === input.role,
  );
  return {
    threadId: input.threadId,
    title: input.thread?.title ?? null,
    state: input.thread === null ? null : threadCliState(input.thread),
    archived: input.thread === null,
    machine: input.machine,
    messages: visible.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      ...(message.context !== undefined ? { context: message.context } : {}),
      createdAt: message.createdAt,
      turnId: message.turnId,
      ...(message.streaming ? { streaming: true } : {}),
      attachments: message.attachments.map((attachment) => {
        const path = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
        return {
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          path,
          exists: path !== null && input.attachmentFileExists(path),
        };
      }),
    })),
    hasMoreOlder: input.window.hasMoreOlder,
    nextBefore: input.window.nextBefore,
  };
};

export type ThreadMessagesReport = ReturnType<typeof threadMessagesReport>;

// Transcript text carries untrusted content (assistant output, titles,
// attachment names) straight to a terminal, so strip control characters that
// could smuggle escape sequences; newlines and tabs stay. JSON mode needs no
// such pass because JSON.stringify escapes them.
export const stripTerminalControlCharacters = (text: string): string =>
  // eslint-disable-next-line no-control-regex -- stripping terminal control characters is the point.
  text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");

export const renderThreadMessagesText = (report: ThreadMessagesReport): string => {
  const lines: Array<string> = [
    `Thread: ${
      report.title === null ? report.threadId : `${report.title} (${report.threadId})`
    }${report.archived ? " (archived)" : ""}`,
    `Machine: ${report.machine.hostname}${
      report.machine.environmentLabel === null ? "" : ` (${report.machine.environmentLabel})`
    }`,
  ];
  for (const message of report.messages) {
    lines.push(
      "",
      `[${message.role}${message.streaming ? ", streaming" : ""}] ${message.createdAt}`,
    );
    if (message.text.length > 0) lines.push(message.text);
    for (const attachment of message.attachments) {
      const marker =
        attachment.path === null
          ? " [path could not be resolved]"
          : attachment.exists
            ? ""
            : " [not found on this machine]";
      lines.push(
        `  attachment: ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes) -> ${
          attachment.path ?? "unresolved"
        }${marker}`,
      );
    }
  }
  if (report.messages.length === 0) lines.push("", "No messages.");
  if (report.messages.some((message) => message.attachments.length > 0)) {
    lines.push(
      "",
      `Attachment paths are local to ${report.machine.hostname}. When reading this thread from another machine, fetch them over SSH.`,
    );
  }
  if (report.hasMoreOlder && report.nextBefore !== null) {
    lines.push(
      "",
      `Older messages exist. Rerun with --before ${report.nextBefore} to page further back.`,
    );
  }
  return stripTerminalControlCharacters(lines.join("\n"));
};
