import {
  CommandId,
  MessageId,
  type ServerSettings,
  TELEGRAM_TOPIC_TITLE_MAX_CHARS,
  type TelegramDispatchInput,
  TelegramDispatchError,
  type TelegramDispatchResult,
  ThreadId,
  VOICE_TRANSCRIPTION_MAX_BYTES,
  VOICE_TRANSCRIPTION_MAX_DURATION_MS,
  VOICE_TRANSCRIPTION_MIN_DURATION_MS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerActivation from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { getTtsCharacterLimit, resolveAgentReplyTtsProfile } from "../voice/ttsProfile.ts";
import { TtsService } from "../voice/TtsService.ts";
import { MP3_MIME_TYPE } from "../voice/ttsTypes.ts";
import { VoiceTranscription } from "../voice/VoiceTranscription.ts";
import { splitTelegramReport } from "./reportSplit.ts";
import {
  type InlineButton,
  isTopicMissing,
  type TelegramApiError,
  TelegramBotApi,
  type TelegramBotClient,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
} from "./TelegramBotApi.ts";
import { TelegramTopicStore, threadForTopic, withBot, withChat } from "./TelegramTopicStore.ts";

const DONE_BUTTON: InlineButton = { text: "✅ Done", callbackData: "settle" };
const REOPEN_BUTTON: InlineButton = { text: "↩️ Reopen", callbackData: "unsettle" };

const POLL_TIMEOUT_SECONDS = 50;
const POLL_BACKOFF_MIN_SECONDS = 5;
const POLL_BACKOFF_MAX_SECONDS = 60;
const POLL_CONFLICT_BACKOFF_SECONDS = 30;

const WELCOME_TEXT =
  "Linked to T3 Code. Ask an agent to send you a summary to Telegram; each T3 thread gets its own topic here. Reply inside a topic to follow up.";
const HELP_TEXT =
  "Reply inside a thread's topic to follow up with its agent. Topics appear when an agent sends you a summary to Telegram.";
const UNSUPPORTED_TEXT = "Only text and voice replies are forwarded.";

export interface TelegramDispatchRequest extends TelegramDispatchInput {
  readonly threadId: ThreadId;
}

export interface TelegramServiceShape {
  /**
   * Delivers a summary (with a Done button), the optional report, and the
   * optional voice note into the thread's own topic, creating it on first use.
   */
  readonly dispatch: (
    input: TelegramDispatchRequest,
  ) => Effect.Effect<TelegramDispatchResult, TelegramDispatchError>;
}

/**
 * Fork: Telegram dispatches. Agents send summaries to the owner's private chat
 * with their bot, one forum topic per T3 thread; a long-polling loop routes
 * the owner's replies and Done/Reopen buttons back into those threads.
 */
export class TelegramService extends Context.Service<TelegramService, TelegramServiceShape>()(
  "t3/telegram/TelegramService",
) {}

export const truncateTopicName = (name: string) => {
  const trimmed = name.trim() || "T3 thread";
  return trimmed.length <= TELEGRAM_TOPIC_TITLE_MAX_CHARS
    ? trimmed
    : `${trimmed.slice(0, TELEGRAM_TOPIC_TITLE_MAX_CHARS - 1)}…`;
};

/** Cuts a script to `limit` characters, at a sentence end when one is near. */
export const clipSpeechScript = (script: string, limit: number) => {
  if (script.length <= limit) return script;
  const head = script.slice(0, limit);
  const sentenceEnd = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
  );
  if (sentenceEnd >= limit * 0.6) return head.slice(0, sentenceEnd + 1);
  const space = head.lastIndexOf(" ");
  return space > 0 ? head.slice(0, space) : head;
};

const telegramFailed = (error: TelegramApiError, delivered: boolean) =>
  new TelegramDispatchError({
    reason: "telegram_failed",
    detail: delivered ? `${error.description} The text parts were delivered.` : error.description,
  });

/**
 * The poller's per-update handler: links the owner's chat, routes Done/Reopen
 * buttons, and forwards topic replies into their threads. Exported for tests.
 */
export const makeUpdateHandler = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const topicStore = yield* TelegramTopicStore;
  const transcription = yield* VoiceTranscription;

  /**
   * Ids derived from the bot and the update, so an update replayed after a
   * crash or restart (before its offset was saved) dedupes in the orchestrator
   * instead of starting a second turn.
   */
  type UpdateIds = (kind: "command" | "message") => string;

  const reply = (client: TelegramBotClient, message: TelegramMessage, text: string) =>
    client
      .sendMessage({
        chatId: String(message.chat.id),
        topicId: message.message_thread_id,
        text,
        replyToMessageId: message.message_id,
      })
      .pipe(Effect.asVoid);

  const handleCallback = Effect.fn("TelegramService.handleCallback")(function* (
    client: TelegramBotClient,
    owner: string,
    query: TelegramCallbackQuery,
    ids: UpdateIds,
  ) {
    const answer = (text: string) =>
      client.answerCallbackQuery({ callbackQueryId: query.id, text });
    const message = query.message;
    if (message === undefined || owner === "" || String(message.chat.id) !== owner) {
      return yield* answer("This bot is private.");
    }
    const state = yield* topicStore.read;
    const threadId =
      message.message_thread_id === undefined
        ? undefined
        : threadForTopic(state, owner, message.message_thread_id);
    if (threadId === undefined) {
      return yield* answer("This topic is no longer linked to a T3 thread.");
    }
    const commandId = CommandId.make(ids("command"));
    const setButtons = (button: InlineButton) =>
      client
        .editMessageButtons({ chatId: owner, messageId: message.message_id, buttons: [button] })
        .pipe(Effect.ignore);
    switch (query.data) {
      case "settle": {
        const settled = yield* threads
          .settleThread({ threadId: ThreadId.make(threadId), commandId, byOwnAgent: false })
          .pipe(Effect.result);
        if (settled._tag === "Failure") {
          return yield* answer(`Could not settle: ${settled.failure.message}`);
        }
        yield* setButtons(REOPEN_BUTTON);
        return yield* answer("Settled in T3");
      }
      case "unsettle": {
        const reopened = yield* threads
          .dispatch({
            type: "thread.unsettle",
            commandId,
            threadId: ThreadId.make(threadId),
            reason: "user",
          })
          .pipe(Effect.result);
        if (reopened._tag === "Failure") {
          return yield* answer(`Could not reopen: ${reopened.failure.message}`);
        }
        yield* setButtons(DONE_BUTTON);
        return yield* answer("Reopened");
      }
      default:
        return yield* answer("");
    }
  });

  const forward = Effect.fn("TelegramService.forward")(function* (
    client: TelegramBotClient,
    message: TelegramMessage,
    threadId: ThreadId,
    text: string,
    ids: UpdateIds,
  ) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell === null) {
      return yield* reply(client, message, "That T3 thread no longer exists.");
    }
    const sent = yield* threads
      .sendToThread({
        projectId: shell.projectId,
        commandId: CommandId.make(ids("command")),
        threadId,
        messageId: MessageId.make(ids("message")),
        text,
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.result);
    if (sent._tag === "Failure") {
      return yield* reply(client, message, `Could not send to T3: ${sent.failure.message}`);
    }
    yield* client
      .setMessageReaction({
        chatId: String(message.chat.id),
        messageId: message.message_id,
        emoji: "👀",
      })
      .pipe(Effect.ignore);
  });

  const transcribe = Effect.fn("TelegramService.transcribe")(function* (
    client: TelegramBotClient,
    voice: NonNullable<TelegramMessage["voice"]>,
  ) {
    if (!transcription.available) {
      return Option.none<string>();
    }
    const durationMs = Math.max(
      Math.round((voice.duration ?? 0) * 1_000),
      VOICE_TRANSCRIPTION_MIN_DURATION_MS,
    );
    if (durationMs > VOICE_TRANSCRIPTION_MAX_DURATION_MS) return Option.none<string>();
    // A failed download reads as an untranscribable note, so the owner is told instead of the reply vanishing.
    const bytes = yield* client
      .downloadFile(voice.file_id)
      .pipe(Effect.orElseSucceed(() => new Uint8Array()));
    if (bytes.byteLength === 0 || bytes.byteLength > VOICE_TRANSCRIPTION_MAX_BYTES) {
      return Option.none<string>();
    }
    return yield* transcription
      .transcribe({
        mimeType: "audio/ogg",
        dataUrl: `data:audio/ogg;base64,${Buffer.from(bytes).toString("base64")}`,
        durationMs,
        sizeBytes: bytes.byteLength,
      })
      .pipe(
        Effect.map((result) => Option.some(result.text)),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
  });

  const handleMessage = Effect.fn("TelegramService.handleMessage")(function* (
    client: TelegramBotClient,
    settings: ServerSettings,
    message: TelegramMessage,
    ids: UpdateIds,
  ) {
    const chatId = String(message.chat.id);
    const owner = settings.telegram.chatId;
    const text = message.text?.trim();
    const isStart = text !== undefined && /^\/start(?:@\S+)?(?:\s|$)/.test(text);

    if (isStart && message.chat.type === "private") {
      const code = text.replace(/^\/start(?:@\S+)?/, "").trim();
      const linkCode = settings.telegram.linkCode;
      if (linkCode !== "" && code === linkCode) {
        const linked = yield* serverSettings
          .updateSettings({ telegram: { chatId, linkCode: "" } })
          .pipe(Effect.result);
        if (linked._tag === "Failure") {
          yield* Effect.logWarning("failed to save the linked Telegram chat");
          return yield* reply(client, message, "Could not save the link in T3. Try again.");
        }
        yield* client.sendMessage({ chatId, text: WELCOME_TEXT });
        return;
      }
    }
    if (owner === "" || chatId !== owner) {
      if (isStart) yield* reply(client, message, "This bot is private.");
      return;
    }

    const topicId = message.message_thread_id;
    const state = yield* topicStore.read;
    const threadId = topicId === undefined ? undefined : threadForTopic(state, owner, topicId);
    if (threadId === undefined) {
      return yield* reply(client, message, HELP_TEXT);
    }
    if (text !== undefined && text.length > 0) {
      return yield* forward(client, message, ThreadId.make(threadId), text, ids);
    }
    if (message.voice !== undefined) {
      const transcript = yield* transcribe(client, message.voice);
      if (Option.isNone(transcript)) {
        return yield* reply(
          client,
          message,
          transcription.available
            ? "Could not transcribe that voice note (up to 3 minutes). Send it as text instead."
            : "Voice replies need speech-to-text (ELEVENLABS_API_KEY) on the T3 server. Send text instead.",
        );
      }
      yield* reply(client, message, `🎙️ ${transcript.value}`);
      return yield* forward(client, message, ThreadId.make(threadId), transcript.value, ids);
    }
    return yield* reply(client, message, UNSUPPORTED_TEXT);
  });

  return Effect.fn("TelegramService.handleUpdate")(function* (
    client: TelegramBotClient,
    update: TelegramUpdate,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.option);
    if (Option.isNone(settings)) return;
    const { botId } = yield* topicStore.read;
    const ids: UpdateIds = (kind) => `telegram:${botId}:${update.update_id}:${kind}`;
    if (update.callback_query !== undefined) {
      return yield* handleCallback(
        client,
        settings.value.telegram.chatId,
        update.callback_query,
        ids,
      );
    }
    if (update.message !== undefined) {
      return yield* handleMessage(client, settings.value, update.message, ids);
    }
  });
});

export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const topicStore = yield* TelegramTopicStore;
  const botApi = yield* TelegramBotApi;
  const tts = yield* TtsService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const handleUpdate = yield* makeUpdateHandler;

  /** Telegram plays MP3 and OGG/Opus as voice notes, not WAV; ffmpeg converts. */
  const transcodeToOgg = (wav: Uint8Array) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-telegram-" });
        const input = path.join(directory, "speech.wav");
        const output = path.join(directory, "speech.ogg");
        yield* fileSystem.writeFile(input, wav);
        const result = yield* processRunner.run({
          command: "ffmpeg",
          args: ["-hide_banner", "-loglevel", "error", "-y", "-i", input].concat([
            "-c:a",
            "libopus",
            "-b:a",
            "32k",
            "-ac",
            "1",
            output,
          ]),
          timeout: Duration.minutes(2),
        });
        if (result.code !== 0) return Option.none<Uint8Array>();
        return Option.some(yield* fileSystem.readFile(output));
      }),
    ).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));

  // Serializes topic lookup and creation so concurrent dispatches for one
  // thread share a topic instead of each creating one.
  const topicLock = yield* Semaphore.make(1);

  const ensureTopic = (
    client: TelegramBotClient,
    chatId: string,
    threadId: ThreadId,
    name: string,
    recreate: boolean,
    staleTopicId?: number,
  ) =>
    Effect.gen(function* () {
      const state = yield* topicStore.update((current) => withChat(current, chatId));
      const existing = state.threads[threadId];
      // A concurrent dispatch may already have replaced the missing topic.
      if (existing !== undefined && recreate && existing.topicId !== staleTopicId) {
        return existing.topicId;
      }
      if (existing !== undefined && !recreate) {
        if (existing.name !== name) {
          // A failed rename keeps the old name stored, so the next dispatch retries it.
          yield* client.editForumTopic({ chatId, topicId: existing.topicId, name }).pipe(
            Effect.andThen(
              topicStore.update((current) =>
                current.threads[threadId]?.topicId !== existing.topicId
                  ? current
                  : {
                      ...current,
                      threads: {
                        ...current.threads,
                        [threadId]: { topicId: existing.topicId, name },
                      },
                    },
              ),
            ),
            Effect.ignore,
          );
        }
        return existing.topicId;
      }
      const created = yield* client.createForumTopic({ chatId, name });
      // The owner may have linked another chat, or switched bots, meanwhile; the new mapping must stay clean.
      yield* topicStore.update((current) =>
        current.chatId !== chatId || current.botId !== state.botId
          ? current
          : {
              ...current,
              threads: { ...current.threads, [threadId]: { topicId: created.topicId, name } },
            },
      );
      return created.topicId;
    }).pipe(topicLock.withPermits(1));

  const sendVoiceNote = Effect.fn("TelegramService.sendVoiceNote")(function* (input: {
    readonly client: TelegramBotClient;
    readonly settings: ServerSettings;
    readonly chatId: string;
    readonly topicId: number;
    readonly topicName: string;
    readonly script: string;
  }) {
    const speechFailed = (detail: string) =>
      new TelegramDispatchError({
        reason: "speech_failed",
        detail: `${detail} The text parts were delivered.`,
      });
    const profile = resolveAgentReplyTtsProfile(input.settings.voice, tts.environmentDefaults);
    if (!(yield* tts.isConfigured(profile.provider).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* speechFailed("No speech provider is configured on the T3 server.");
    }
    const speech = yield* tts
      .synthesize({ profile, text: clipSpeechScript(input.script, getTtsCharacterLimit(profile)) })
      .pipe(Effect.mapError((error) => speechFailed(error.detail)));
    const caption = `🎧 ${input.topicName}`;
    const target = { chatId: input.chatId, topicId: input.topicId };
    if (speech.mimeType === MP3_MIME_TYPE) {
      const sent = yield* input.client.sendVoice({
        ...target,
        caption,
        voice: { bytes: speech.bytes, mimeType: MP3_MIME_TYPE, fileName: "speech.mp3" },
      });
      return sent.durationSeconds;
    }
    const ogg = yield* transcodeToOgg(speech.bytes);
    if (Option.isSome(ogg)) {
      const sent = yield* input.client.sendVoice({
        ...target,
        caption,
        voice: { bytes: ogg.value, mimeType: "audio/ogg", fileName: "speech.ogg" },
      });
      return sent.durationSeconds;
    }
    yield* input.client.sendDocument({
      ...target,
      caption: `${caption}\nInstall ffmpeg on the T3 server to get voice notes instead of files.`,
      document: { bytes: speech.bytes, mimeType: speech.mimeType, fileName: "speech.wav" },
    });
    return null;
  });

  const dispatch: TelegramServiceShape["dispatch"] = Effect.fn("TelegramService.dispatch")(
    function* (input) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          () =>
            new TelegramDispatchError({
              reason: "telegram_failed",
              detail: "Could not read the server settings.",
            }),
        ),
      );
      const { botToken, chatId } = settings.telegram;
      if (botToken === "") {
        return yield* new TelegramDispatchError({ reason: "not_configured", detail: "" });
      }
      if (chatId === "") {
        return yield* new TelegramDispatchError({ reason: "not_linked", detail: "" });
      }
      const client = botApi.client(botToken);
      const shell = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      const topicName = truncateTopicName(input.title ?? shell?.title ?? "");

      let topicId = yield* ensureTopic(client, chatId, input.threadId, topicName, false).pipe(
        Effect.mapError((error) => telegramFailed(error, false)),
      );
      let recreated = false;
      // A topic deleted in Telegram is recreated once, then the send is retried.
      const inTopic = <A>(
        send: (topicId: number) => Effect.Effect<A, TelegramApiError>,
      ): Effect.Effect<A, TelegramApiError> =>
        Effect.suspend(() => send(topicId)).pipe(
          Effect.catch((error) => {
            if (recreated || !isTopicMissing(error)) return Effect.fail(error);
            recreated = true;
            return ensureTopic(client, chatId, input.threadId, topicName, true, topicId).pipe(
              Effect.tap((next) =>
                Effect.sync(() => {
                  topicId = next;
                }),
              ),
              Effect.flatMap(send),
            );
          }),
        );

      yield* inTopic((topic) =>
        client.sendRichMessage({
          chatId,
          topicId: topic,
          markdown: input.summary,
          buttons: [DONE_BUTTON],
        }),
      ).pipe(Effect.mapError((error) => telegramFailed(error, false)));

      const reportParts = input.report === undefined ? [] : splitTelegramReport(input.report);
      for (const part of reportParts) {
        yield* inTopic((topic) =>
          client.sendRichMessage({ chatId, topicId: topic, markdown: part }),
        ).pipe(Effect.mapError((error) => telegramFailed(error, true)));
      }

      const audioSeconds =
        input.audioScript === undefined
          ? null
          : yield* sendVoiceNote({
              client,
              settings,
              chatId,
              topicId,
              topicName,
              script: input.audioScript,
            }).pipe(
              Effect.mapError((error) =>
                error._tag === "TelegramApiError" ? telegramFailed(error, true) : error,
              ),
            );

      return { topic: topicName, reportParts: reportParts.length, audioSeconds };
    },
  );

  const runPoller = (token: string) =>
    Effect.gen(function* () {
      const client = botApi.client(token);
      let started = false;
      let backoffSeconds = POLL_BACKOFF_MIN_SECONDS;
      let conflictWarned = false;

      const start = Effect.gen(function* () {
        const me = yield* client.getMe;
        yield* topicStore.update((state) => withBot(state, me.id));
        const settings = yield* serverSettings.getSettings.pipe(Effect.option);
        if (Option.isSome(settings) && settings.value.telegram.botUsername !== me.username) {
          yield* serverSettings
            .updateSettings({ telegram: { botUsername: me.username } })
            .pipe(Effect.ignore);
        }
        started = true;
      });

      const step = Effect.gen(function* () {
        if (!started) yield* start;
        const state = yield* topicStore.read;
        const updates = yield* client.getUpdates({
          offset: state.lastUpdateId + 1,
          timeoutSeconds: POLL_TIMEOUT_SECONDS,
        });
        if (updates.length === 0) return;
        for (const update of updates) {
          // One bad update must not stall the queue; errors here are already sanitized.
          yield* handleUpdate(client, update).pipe(
            Effect.catch((error) =>
              Effect.logWarning("telegram update handling failed", {
                updateId: update.update_id,
                error: error.message,
              }),
            ),
          );
        }
        const lastUpdateId = Math.max(...updates.map((update) => update.update_id));
        yield* topicStore.update((current) => ({
          ...current,
          lastUpdateId: Math.max(current.lastUpdateId, lastUpdateId),
        }));
      });

      while (true) {
        const failure = yield* step.pipe(
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(error)),
        );
        if (failure === undefined) {
          backoffSeconds = POLL_BACKOFF_MIN_SECONDS;
          continue;
        }
        if (failure.errorCode === 401 || failure.errorCode === 404) {
          yield* Effect.logWarning(
            "telegram rejected the bot token; polling stops until the token changes",
          );
          return;
        }
        if (failure.errorCode === 409) {
          if (!conflictWarned) {
            conflictWarned = true;
            yield* Effect.logWarning(
              "another client is polling this Telegram bot; retrying until it stops",
            );
          }
          yield* Effect.sleep(Duration.seconds(POLL_CONFLICT_BACKOFF_SECONDS));
          continue;
        }
        yield* Effect.logWarning("telegram polling failed", { error: failure.message });
        yield* Effect.sleep(Duration.seconds(backoffSeconds));
        backoffSeconds = Math.min(backoffSeconds * 2, POLL_BACKOFF_MAX_SECONDS);
      }
    });

  // Polls while a bot token is set; a new token restarts the loop.
  yield* ServerActivation.forkParked(
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* serverSettings.subscribeChanges;
        const initial = yield* serverSettings.getSettings.pipe(Effect.option);
        const initialToken = Option.match(initial, {
          onNone: () => "",
          onSome: (settings) => settings.telegram.botToken,
        });
        yield* Stream.concat(
          Stream.make(initialToken),
          changes.pipe(Stream.map((settings) => settings.telegram.botToken)),
        ).pipe(
          Stream.changes,
          Stream.switchMap((token) =>
            token === "" ? Stream.empty : Stream.fromEffect(runPoller(token)),
          ),
          Stream.runDrain,
        );
      }),
    ),
  );

  return TelegramService.of({ dispatch });
});

export const layer = Layer.effect(TelegramService, make);
