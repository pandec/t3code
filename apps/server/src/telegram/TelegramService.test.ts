import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { VoiceTranscription } from "../voice/VoiceTranscription.ts";
import type { TelegramBotClient, TelegramUpdate } from "./TelegramBotApi.ts";
import { makeUpdateHandler } from "./TelegramService.ts";
import * as TelegramTopicStore from "./TelegramTopicStore.ts";

const OWNER = "1001";
const STRANGER = "2002";
const TOPIC = 55;
const threadId = ThreadId.make("thread-telegram");

/** A Bot API client that records every call and answers with fixed ids. */
const fakeClient = () => {
  const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  const record =
    <A>(method: string, result: A) =>
    (input: unknown) =>
      Effect.sync(() => {
        calls.push({ method, input });
        return result;
      });
  const client: TelegramBotClient = {
    getMe: Effect.succeed({ id: "9", username: "t3_bot" }),
    getUpdates: () => Effect.succeed([]),
    sendRichMessage: record("sendRichMessage", { messageId: 1 }),
    sendMessage: record("sendMessage", { messageId: 2 }),
    sendVoice: record("sendVoice", { durationSeconds: 3 }),
    sendDocument: record("sendDocument", undefined),
    createForumTopic: record("createForumTopic", { topicId: TOPIC, name: "x" }),
    editForumTopic: record("editForumTopic", undefined),
    setMessageReaction: record("setMessageReaction", undefined),
    answerCallbackQuery: record("answerCallbackQuery", undefined),
    editMessageButtons: record("editMessageButtons", undefined),
    downloadFile: record("downloadFile", new Uint8Array()),
  };
  return { client, calls };
};

const message = (chatId: string, fields: { text?: string; topicId?: number }) =>
  ({
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: Number(chatId), type: "private" },
      ...(fields.text === undefined ? {} : { text: fields.text }),
      ...(fields.topicId === undefined
        ? {}
        : { message_thread_id: fields.topicId, is_topic_message: true }),
    },
  }) satisfies TelegramUpdate;

const callback = (data: string) =>
  ({
    update_id: 2,
    callback_query: {
      id: "cb-1",
      data,
      message: { message_id: 20, message_thread_id: TOPIC, chat: { id: Number(OWNER) } },
    },
  }) satisfies TelegramUpdate;

const harness = (telegram: { readonly chatId?: string; readonly linkCode?: string }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-telegram-route-" });
    const store = yield* TelegramTopicStore.make(path.join(directory, "telegram.json"));
    yield* store.update((state) => ({
      ...TelegramTopicStore.withChat(state, OWNER),
      threads: { [threadId]: { topicId: TOPIC, name: "Thread" } },
    }));

    const commands: Array<{ readonly kind: string; readonly input: unknown }> = [];
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
      // The handler only needs to know the send succeeded.
      sendToThread: (input) =>
        Effect.sync(() => {
          commands.push({ kind: "send", input });
          return undefined as never;
        }),
      settleThread: (input) =>
        Effect.sync(() => {
          commands.push({ kind: "settle", input });
          return { sequence: 1 };
        }),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push({ kind: "dispatch", input: command });
          return { sequence: 2, storedEvents: [] };
        }),
    });
    const settingsLayer = ServerSettings.layerTest({
      telegram: {
        botToken: "token",
        chatId: telegram.chatId ?? "",
        linkCode: telegram.linkCode ?? "",
      },
    });
    const services = yield* Layer.build(
      Layer.mergeAll(
        threads,
        settingsLayer,
        Layer.succeed(TelegramTopicStore.TelegramTopicStore, store),
        Layer.succeed(VoiceTranscription, {
          available: false,
          transcribe: () => Effect.die("unused"),
        }),
      ),
    );
    const handle = yield* makeUpdateHandler.pipe(Effect.provide(services));
    const settings = yield* ServerSettings.ServerSettingsService.pipe(Effect.provide(services));
    return { handle, commands, settings };
  });

it.effect("links the chat for the matching /start code and ignores strangers", () =>
  Effect.gen(function* () {
    const { handle, settings } = yield* harness({ linkCode: "abc123" });
    const wrong = fakeClient();
    yield* handle(wrong.client, message(STRANGER, { text: "/start nope" }));
    assert.deepEqual(
      wrong.calls.map((call) => call.method),
      ["sendMessage"],
    );
    assert.equal((yield* settings.getSettings).telegram.chatId, "");

    const right = fakeClient();
    yield* handle(right.client, message(OWNER, { text: "/start abc123" }));
    const linked = (yield* settings.getSettings).telegram;
    assert.equal(linked.chatId, OWNER);
    assert.equal(linked.linkCode, "");
    assert.deepEqual(
      right.calls.map((call) => call.method),
      ["sendMessage"],
    );

    // Once linked, other chats are ignored without a reply.
    const stranger = fakeClient();
    yield* handle(stranger.client, message(STRANGER, { text: "hello", topicId: TOPIC }));
    assert.deepEqual(stranger.calls, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("forwards the owner's topic reply to its thread as a queued user message", () =>
  Effect.gen(function* () {
    const { handle, commands } = yield* harness({ chatId: OWNER });
    const fake = fakeClient();
    yield* handle(
      fake.client,
      message(OWNER, { text: "please also fix the tests", topicId: TOPIC }),
    );
    assert.deepEqual(fake.calls, [
      { method: "setMessageReaction", input: { chatId: OWNER, messageId: 10, emoji: "👀" } },
    ]);
    const send = commands.find((command) => command.kind === "send");
    assert.isDefined(send);
    assert.deepInclude(send!.input as object, {
      threadId,
      text: "please also fix the tests",
      mode: "queue",
      createdBy: "user",
      creationSource: "server",
      attachments: [],
    });

    // General (no topic) gets the help text instead.
    const general = fakeClient();
    yield* handle(general.client, message(OWNER, { text: "hi" }));
    assert.deepEqual(
      general.calls.map((call) => call.method),
      ["sendMessage"],
    );
    assert.equal(commands.filter((command) => command.kind === "send").length, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("settles from the Done button and offers Reopen", () =>
  Effect.gen(function* () {
    const { handle, commands } = yield* harness({ chatId: OWNER });
    const fake = fakeClient();
    yield* handle(fake.client, callback("settle"));
    const settle = commands.find((command) => command.kind === "settle");
    assert.deepInclude(settle!.input as object, { threadId, byOwnAgent: false });
    assert.deepEqual(fake.calls, [
      {
        method: "editMessageButtons",
        input: {
          chatId: OWNER,
          messageId: 20,
          buttons: [{ text: "↩️ Reopen", callbackData: "unsettle" }],
        },
      },
      { method: "answerCallbackQuery", input: { callbackQueryId: "cb-1", text: "Settled in T3" } },
    ]);

    const reopen = fakeClient();
    yield* handle(reopen.client, callback("unsettle"));
    assert.deepEqual(reopen.calls.at(-1), {
      method: "answerCallbackQuery",
      input: { callbackQueryId: "cb-1", text: "Reopened" },
    });
    const unsettle = commands.find((command) => command.kind === "dispatch");
    assert.deepInclude(unsettle!.input as object, {
      type: "thread.unsettle",
      threadId,
      reason: "user",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
