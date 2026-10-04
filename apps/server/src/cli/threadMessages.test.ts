import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  selectHistoryPageFromCursor,
  selectRecentTimelineWindow,
  type ThreadHistoryPagePolicy,
} from "../orchestration-v2/threadHistoryPaging.ts";
import { makeTestThreadShell } from "./liveServerTestKit.ts";
import {
  collectThreadMessages,
  parseThreadMessagesCursor,
  type ThreadMessagesFetchDeps,
  threadMessagesReport,
  type ThreadMessagesWindow,
  type ThreadTimelineSlice,
} from "./threadMessages.ts";

const threadId = ThreadId.make("thread-transcript");
const at = DateTime.makeUnsafe("2026-10-04T10:00:00.000Z");
// Two user turns per page keeps the fixture small while forcing several pages.
const policy: ThreadHistoryPagePolicy = {
  maxUserTurns: 2,
  maxItems: 75,
  maxEncodedBytes: 1_048_576,
};

const baseItem = (id: string, turn: number) => ({
  id: TurnItemId.make(id),
  threadId,
  runId: RunId.make(`run-${turn}`),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed" as const,
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
});

/** One turn: user message, reasoning, a tool call, assistant reply. */
const turnItems = (turn: number): ReadonlyArray<OrchestrationV2TurnItem> => [
  {
    ...baseItem(`user-${turn}`, turn),
    type: "user_message",
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make(`message-user-${turn}`),
    inputIntent: "turn_start",
    text: `question ${turn}`,
    attachments: [],
  },
  {
    ...baseItem(`reasoning-${turn}`, turn),
    type: "reasoning",
    text: `thinking ${turn}`,
    streaming: false,
  },
  { ...baseItem(`tool-${turn}`, turn), type: "command_execution", input: "ls" },
  {
    ...baseItem(`assistant-${turn}`, turn),
    type: "assistant_message",
    messageId: MessageId.make(`message-assistant-${turn}`),
    text: `answer ${turn}`,
    streaming: false,
  },
];

const timeline = (turns: number): ReadonlyArray<OrchestrationV2ProjectedTurnItem> =>
  Array.from({ length: turns }, (_, index) => turnItems(index + 1))
    .flat()
    .map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    }));

/** Serves slices with the server's own paging helpers, counting requests. */
const fakeServer = (items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) => {
  const requests: Array<string | null> = [];
  const slice = (page: {
    readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
    readonly nextCursor: string | null;
    readonly hasMoreHistory: boolean;
  }): ThreadTimelineSlice => ({
    rows: page.items,
    snapshotSequence: 7,
    olderCursor: page.hasMoreHistory ? page.nextCursor : null,
  });
  const deps: ThreadMessagesFetchDeps<never, never> = {
    fetchLatest: () =>
      Effect.sync(() => {
        requests.push(null);
        return slice(selectRecentTimelineWindow({ items, snapshotSequence: 7, policy }));
      }),
    fetchOlder: (_threadId, cursor) =>
      Effect.sync(() => {
        requests.push(cursor);
        return slice(selectHistoryPageFromCursor({ items, cursor, snapshotSequence: 7, policy }));
      }),
  };
  return { deps, requests };
};

const texts = (window: { readonly messages: ReadonlyArray<{ readonly text: string }> }) =>
  window.messages.map((message) => message.text);

describe("collectThreadMessages", () => {
  it.effect("reads the whole history across pages, oldest first, without tool rows", () =>
    Effect.gen(function* () {
      const server = fakeServer(timeline(5));
      const window = yield* collectThreadMessages(
        { threadId, before: null, limit: null },
        server.deps,
      );
      assert.deepStrictEqual(
        texts(window),
        [1, 2, 3, 4, 5].flatMap((turn) => [
          `question ${turn}`,
          `thinking ${turn}`,
          `answer ${turn}`,
        ]),
      );
      assert.deepStrictEqual(
        window.messages.slice(0, 3).map((message) => [message.id, message.role, message.turnId]),
        [
          ["message-user-1", "user", "run-1"],
          ["reasoning-1", "reasoning", "run-1"],
          ["message-assistant-1", "assistant", "run-1"],
        ],
      );
      assert.isFalse(window.hasMoreOlder);
      assert.isNull(window.nextBefore);
      assert.strictEqual(server.requests.length, 3);
    }),
  );

  it.effect("pages with a limit that cuts inside a server page without gaps or overlap", () =>
    Effect.gen(function* () {
      const server = fakeServer(timeline(5));
      const seen: Array<string> = [];
      let before: string | null = null;
      for (let call = 0; call < 10; call += 1) {
        const window: ThreadMessagesWindow = yield* collectThreadMessages(
          { threadId, before, limit: 4 },
          server.deps,
        );
        seen.unshift(...texts(window));
        if (!window.hasMoreOlder) break;
        assert.isNotNull(window.nextBefore);
        before = window.nextBefore;
      }
      assert.deepStrictEqual(
        seen,
        [1, 2, 3, 4, 5].flatMap((turn) => [
          `question ${turn}`,
          `thinking ${turn}`,
          `answer ${turn}`,
        ]),
      );
    }),
  );

  it.effect("fails instead of looping when the server repeats a cursor", () =>
    Effect.gen(function* () {
      const items = timeline(3);
      const latest = selectRecentTimelineWindow({ items, snapshotSequence: 7, policy });
      const stuck: ThreadTimelineSlice = {
        rows: latest.items,
        snapshotSequence: 7,
        olderCursor: latest.nextCursor,
      };
      const error = yield* collectThreadMessages(
        { threadId, before: null, limit: null },
        { fetchLatest: () => Effect.succeed(stuck), fetchOlder: () => Effect.succeed(stuck) },
      ).pipe(Effect.flip);
      assert.strictEqual(error.reason, "changed");
    }),
  );
});

describe("parseThreadMessagesCursor", () => {
  it.effect("rejects empty and foreign cursors before any server read", () =>
    Effect.gen(function* () {
      const empty = yield* parseThreadMessagesCursor(threadId, "  ").pipe(Effect.flip);
      assert.strictEqual(empty.reason, "empty");
      const foreign = yield* parseThreadMessagesCursor(threadId, "message-user-1").pipe(
        Effect.flip,
      );
      assert.strictEqual(foreign.reason, "not-found");
    }),
  );
});

describe("threadMessagesReport", () => {
  it.effect("shows user and assistant by default and reasoning only on request", () =>
    Effect.gen(function* () {
      const window = yield* collectThreadMessages(
        { threadId, before: null, limit: null },
        fakeServer(timeline(1)).deps,
      );
      const report = (role: "reasoning" | null, archived: boolean) =>
        threadMessagesReport({
          threadId,
          thread: archived ? null : makeTestThreadShell(threadId, { title: "Transcript" }),
          window,
          role,
          machine: {
            hostname: "host",
            environmentId: null,
            environmentLabel: null,
            platform: null,
          },
          attachmentsDir: "/tmp/attachments",
          attachmentFileExists: () => false,
        });
      const active = report(null, false);
      assert.deepStrictEqual(
        active.messages.map((message) => message.role),
        ["user", "assistant"],
      );
      assert.strictEqual(active.title, "Transcript");
      assert.isFalse(active.archived);
      const reasoning = report("reasoning", true);
      assert.deepStrictEqual(
        reasoning.messages.map((message) => message.text),
        ["thinking 1"],
      );
      assert.isTrue(reasoning.archived);
      assert.isNull(reasoning.title);
      assert.isNull(reasoning.state);
    }),
  );
});
