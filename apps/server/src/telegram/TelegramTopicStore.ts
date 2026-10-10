import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerConfig from "../config.ts";

const TelegramTopic = Schema.Struct({ topicId: Schema.Number, name: Schema.String });
export type TelegramTopic = typeof TelegramTopic.Type;

const TelegramTopicState = Schema.Struct({
  /** The bot the update offset belongs to; update ids are per bot. */
  botId: Schema.String,
  chatId: Schema.String,
  lastUpdateId: Schema.Number,
  /** When the last update arrived (epoch ms); a week of silence lets Telegram restart update ids. */
  lastUpdateAt: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Keyed by T3 thread id. */
  threads: Schema.Record(Schema.String, TelegramTopic),
});
export type TelegramTopicState = typeof TelegramTopicState.Type;

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(TelegramTopicState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(TelegramTopicState));

export const EMPTY_TELEGRAM_TOPIC_STATE: TelegramTopicState = {
  botId: "",
  chatId: "",
  lastUpdateId: 0,
  lastUpdateAt: 0,
  threads: {},
};

/** Topics belong to one chat: linking another chat starts the mapping over. */
export const withChat = (state: TelegramTopicState, chatId: string): TelegramTopicState =>
  state.chatId === chatId ? state : { ...state, chatId, threads: {} };

/**
 * A new bot starts over: update ids are per bot, and topic ids belong to the
 * previous bot's chat, so keeping them could route replies to the wrong thread.
 */
export const withBot = (state: TelegramTopicState, botId: string): TelegramTopicState =>
  state.botId === botId
    ? state
    : { ...state, botId, lastUpdateId: 0, lastUpdateAt: 0, threads: {} };

export const threadForTopic = (
  state: TelegramTopicState,
  chatId: string,
  topicId: number,
): string | undefined =>
  state.chatId !== chatId
    ? undefined
    : Object.entries(state.threads).find(([, topic]) => topic.topicId === topicId)?.[0];

/**
 * Fork: which Telegram forum topic each T3 thread dispatches into, plus the
 * poller's update offset. A small JSON file in the state directory; it holds
 * no secrets, and losing it only means new topics get created.
 */
export class TelegramTopicStore extends Context.Service<
  TelegramTopicStore,
  {
    readonly read: Effect.Effect<TelegramTopicState>;
    /** Applies `f` and persists the result. A failed write is logged; memory keeps the change. */
    readonly update: (
      f: (state: TelegramTopicState) => TelegramTopicState,
    ) => Effect.Effect<TelegramTopicState>;
  }
>()("t3/telegram/TelegramTopicStore") {}

export const make = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const provideFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

    const load = fileSystem.readFileString(filePath).pipe(
      Effect.flatMap(decodeState),
      Effect.catch(() =>
        fileSystem.exists(filePath).pipe(
          Effect.orElseSucceed(() => false),
          Effect.flatMap((exists) =>
            exists
              ? Effect.logWarning("telegram topic store unreadable, starting empty", {
                  path: filePath,
                })
              : Effect.void,
          ),
          Effect.as(EMPTY_TELEGRAM_TOPIC_STATE),
        ),
      ),
    );
    const state = yield* SynchronizedRef.make<TelegramTopicState | undefined>(undefined);
    const current = (value: TelegramTopicState | undefined) =>
      value === undefined ? load : Effect.succeed(value);

    return TelegramTopicStore.of({
      read: SynchronizedRef.modifyEffect(state, (value) =>
        current(value).pipe(Effect.map((loaded) => [loaded, loaded] as const)),
      ),
      update: (f) =>
        SynchronizedRef.modifyEffect(state, (value) =>
          Effect.gen(function* () {
            const before = yield* current(value);
            const next = f(before);
            if (next !== before) {
              yield* encodeState(next).pipe(
                Effect.flatMap((contents) =>
                  provideFs(writeFileStringAtomically({ filePath, contents: `${contents}\n` })),
                ),
                Effect.catch(() =>
                  Effect.logWarning("failed to persist the telegram topic store", {
                    path: filePath,
                  }),
                ),
              );
            }
            return [next, next] as const;
          }),
        ),
    });
  });

export const layer = Layer.effect(
  TelegramTopicStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* make(path.join(config.stateDir, "telegram.json"));
  }),
);
