import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as TelegramTopicStore from "./TelegramTopicStore.ts";

it.effect("persists topics and the update offset, and starts over for another chat", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-telegram-store-" });
    const filePath = path.join(directory, "telegram.json");

    const store = yield* TelegramTopicStore.make(filePath);
    yield* store.update((state) => ({
      ...TelegramTopicStore.withChat(state, "42"),
      lastUpdateId: 7,
      threads: { "thread-a": { topicId: 100, name: "Alpha" } },
    }));

    const reloaded = yield* (yield* TelegramTopicStore.make(filePath)).read;
    assert.deepEqual(reloaded, {
      botId: "",
      chatId: "42",
      lastUpdateId: 7,
      threads: { "thread-a": { topicId: 100, name: "Alpha" } },
    });
    assert.equal(TelegramTopicStore.threadForTopic(reloaded, "42", 100), "thread-a");
    assert.isUndefined(TelegramTopicStore.threadForTopic(reloaded, "43", 100));

    const relinked = TelegramTopicStore.withChat(reloaded, "43");
    assert.deepEqual(relinked.threads, {});
    assert.equal(relinked.lastUpdateId, 7);
    // A new bot's update ids and topics start over.
    const rebotted = TelegramTopicStore.withBot(reloaded, "bot-2");
    assert.equal(rebotted.lastUpdateId, 0);
    assert.deepEqual(rebotted.threads, {});
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
