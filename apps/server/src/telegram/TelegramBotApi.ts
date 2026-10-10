import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/http";

const TELEGRAM_API_ORIGIN = "https://api.telegram.org";
const REQUEST_TIMEOUT = Duration.seconds(30);
const UPLOAD_TIMEOUT = Duration.seconds(120);
/** Bots may download files up to 20 MB. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_RATE_LIMIT_RETRIES = 2;

/**
 * A failed Bot API call. The token is part of every request URL, so this never
 * carries the request, URL, or transport error: only Telegram's own
 * `description` (or a fixed transport message) and its numeric code.
 */
export class TelegramApiError extends Schema.TaggedError<TelegramApiError>()("TelegramApiError", {
  method: Schema.String,
  /** Telegram's `error_code` (400, 401, 403, 409, 429, ...); absent for transport failures. */
  errorCode: Schema.optional(Schema.Number),
  description: Schema.String,
  retryAfterSeconds: Schema.optional(Schema.Number),
}) {
  override get message(): string {
    return `Telegram ${this.method} failed: ${this.description}`;
  }
}

/** The stored forum topic was deleted in Telegram. */
export const isTopicMissing = (error: TelegramApiError) =>
  /message thread not found|topic_deleted|TOPIC_DELETED/i.test(error.description);

const Chat = Schema.Struct({ id: Schema.Number, type: Schema.optionalKey(Schema.String) });

const Message = Schema.Struct({
  message_id: Schema.Number,
  message_thread_id: Schema.optionalKey(Schema.Number),
  is_topic_message: Schema.optionalKey(Schema.Boolean),
  chat: Chat,
  text: Schema.optionalKey(Schema.String),
  voice: Schema.optionalKey(
    Schema.Struct({
      file_id: Schema.String,
      mime_type: Schema.optionalKey(Schema.String),
      duration: Schema.optionalKey(Schema.Number),
      file_size: Schema.optionalKey(Schema.Number),
    }),
  ),
});
export type TelegramMessage = typeof Message.Type;

const CallbackQuery = Schema.Struct({
  id: Schema.String,
  data: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(
    Schema.Struct({
      message_id: Schema.Number,
      message_thread_id: Schema.optionalKey(Schema.Number),
      chat: Chat,
    }),
  ),
});
export type TelegramCallbackQuery = typeof CallbackQuery.Type;

const Update = Schema.Struct({
  update_id: Schema.Number,
  message: Schema.optionalKey(Message),
  callback_query: Schema.optionalKey(CallbackQuery),
});
export type TelegramUpdate = typeof Update.Type;
const decodeUpdate = Schema.decodeUnknownOption(Update);

const Envelope = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optionalKey(Schema.Unknown),
  description: Schema.optionalKey(Schema.String),
  error_code: Schema.optionalKey(Schema.Number),
  parameters: Schema.optionalKey(Schema.Struct({ retry_after: Schema.optionalKey(Schema.Number) })),
});
const decodeEnvelope = Schema.decodeUnknownOption(Envelope);

const SentMessage = Schema.Struct({ message_id: Schema.Number });
const SentVoice = Schema.Struct({
  message_id: Schema.Number,
  voice: Schema.optionalKey(Schema.Struct({ duration: Schema.optionalKey(Schema.Number) })),
});
const BotUser = Schema.Struct({ id: Schema.Number, username: Schema.optionalKey(Schema.String) });
const ForumTopic = Schema.Struct({ message_thread_id: Schema.Number, name: Schema.String });
const TelegramFile = Schema.Struct({
  file_path: Schema.optionalKey(Schema.String),
  file_size: Schema.optionalKey(Schema.Number),
});

export interface InlineButton {
  readonly text: string;
  readonly callbackData: string;
}

export interface TelegramUpload {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly fileName: string;
}

type Call<I, A> = (input: I) => Effect.Effect<A, TelegramApiError>;

/** One bot's view of the Bot API. Chat ids are kept as strings (64-bit safe). */
export interface TelegramBotClient {
  readonly getMe: Effect.Effect<
    { readonly id: string; readonly username: string },
    TelegramApiError
  >;
  /** Long poll. Updates that fail to decode come back with only their id, to advance the offset. */
  readonly getUpdates: Call<
    { readonly offset: number; readonly timeoutSeconds: number },
    ReadonlyArray<TelegramUpdate>
  >;
  readonly sendRichMessage: Call<
    {
      readonly chatId: string;
      readonly topicId: number;
      readonly markdown: string;
      readonly buttons?: ReadonlyArray<InlineButton>;
    },
    { readonly messageId: number }
  >;
  readonly sendMessage: Call<
    {
      readonly chatId: string;
      readonly topicId?: number | undefined;
      readonly text: string;
      readonly replyToMessageId?: number | undefined;
    },
    { readonly messageId: number }
  >;
  readonly sendVoice: Call<
    {
      readonly chatId: string;
      readonly topicId: number;
      readonly voice: TelegramUpload;
      readonly caption?: string | undefined;
    },
    { readonly durationSeconds: number | null }
  >;
  readonly sendDocument: Call<
    {
      readonly chatId: string;
      readonly topicId: number;
      readonly document: TelegramUpload;
      readonly caption?: string | undefined;
    },
    void
  >;
  readonly createForumTopic: Call<
    { readonly chatId: string; readonly name: string },
    { readonly topicId: number; readonly name: string }
  >;
  readonly editForumTopic: Call<
    { readonly chatId: string; readonly topicId: number; readonly name: string },
    void
  >;
  readonly setMessageReaction: Call<
    { readonly chatId: string; readonly messageId: number; readonly emoji: string },
    void
  >;
  readonly answerCallbackQuery: Call<
    { readonly callbackQueryId: string; readonly text: string },
    void
  >;
  readonly editMessageButtons: Call<
    {
      readonly chatId: string;
      readonly messageId: number;
      readonly buttons: ReadonlyArray<InlineButton>;
    },
    void
  >;
  /** getFile, then the file download (at most 20 MB). */
  readonly downloadFile: Call<string, Uint8Array>;
}

export interface TelegramBotApiShape {
  readonly client: (token: string) => TelegramBotClient;
}

/** Fork: Telegram Bot API access for `TelegramService`, replaced by a fake in tests. */
export class TelegramBotApi extends Context.Service<TelegramBotApi, TelegramBotApiShape>()(
  "t3/telegram/TelegramBotApi",
) {}

const inlineKeyboard = (buttons: ReadonlyArray<InlineButton>) => ({
  inline_keyboard: [
    buttons.map((button) => ({ text: button.text, callback_data: button.callbackData })),
  ],
});

const withTopic = (topicId: number | undefined) =>
  topicId === undefined ? {} : { message_thread_id: topicId };

const uploadForm = (
  fields: Record<string, string | number | undefined>,
  fileField: string,
  upload: TelegramUpload,
) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(key, String(value));
  }
  form.append(fileField, new Blob([upload.bytes], { type: upload.mimeType }), upload.fileName);
  return HttpBody.formData(form);
};

export const makeClient = (httpClient: HttpClient.HttpClient, token: string): TelegramBotClient => {
  const transportError = (method: string) =>
    new TelegramApiError({ method, description: "Could not reach Telegram." });

  const callOnce = <A>(
    method: string,
    body: HttpBody.HttpBody,
    result: Schema.Decoder<A>,
    timeout: Duration.Duration,
  ): Effect.Effect<A, TelegramApiError> =>
    httpClient.post(`${TELEGRAM_API_ORIGIN}/bot${token}/${method}`, { body }).pipe(
      Effect.flatMap((response) => response.json),
      Effect.timeout(timeout),
      // Spans would record the URL, and with it the token.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.mapError(() => transportError(method)),
      Effect.flatMap((json) => {
        const envelope = decodeEnvelope(json);
        if (Option.isNone(envelope)) return Effect.fail(transportError(method));
        if (!envelope.value.ok) {
          const retryAfter = envelope.value.parameters?.retry_after;
          return Effect.fail(
            new TelegramApiError({
              method,
              description: envelope.value.description ?? "Unknown error.",
              ...(envelope.value.error_code === undefined
                ? {}
                : { errorCode: envelope.value.error_code }),
              ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
            }),
          );
        }
        return Effect.fromOption(Schema.decodeUnknownOption(result)(envelope.value.result)).pipe(
          Effect.mapError(
            () =>
              new TelegramApiError({ method, description: "Unexpected response from Telegram." }),
          ),
        );
      }),
    );

  // 429 carries `retry_after`; honor it a couple of times before giving up.
  const call = <A>(
    method: string,
    body: HttpBody.HttpBody,
    result: Schema.Decoder<A>,
    timeout: Duration.Duration = REQUEST_TIMEOUT,
    attempt = 0,
  ): Effect.Effect<A, TelegramApiError> =>
    callOnce(method, body, result, timeout).pipe(
      Effect.catchIf(
        (error) => error.retryAfterSeconds !== undefined && attempt < MAX_RATE_LIMIT_RETRIES,
        (error) =>
          Effect.sleep(Duration.seconds(Math.min(error.retryAfterSeconds ?? 1, 60))).pipe(
            Effect.andThen(call(method, body, result, timeout, attempt + 1)),
          ),
      ),
    );

  const json = (body: Record<string, unknown>) => HttpBody.jsonUnsafe(body);

  return {
    getMe: call("getMe", json({}), BotUser).pipe(
      Effect.map((user) => ({ id: String(user.id), username: user.username ?? "" })),
    ),
    getUpdates: ({ offset, timeoutSeconds }) =>
      callOnce(
        "getUpdates",
        json({ offset, timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] }),
        Schema.Array(Schema.Unknown),
        Duration.seconds(timeoutSeconds + 15),
      ).pipe(
        Effect.map((raw) =>
          raw.flatMap((entry): ReadonlyArray<TelegramUpdate> => {
            const decoded = decodeUpdate(entry);
            if (Option.isSome(decoded)) return [decoded.value];
            const id =
              typeof entry === "object" && entry !== null && "update_id" in entry
                ? entry.update_id
                : undefined;
            return typeof id === "number" ? [{ update_id: id }] : [];
          }),
        ),
      ),
    sendRichMessage: ({ chatId, topicId, markdown, buttons }) =>
      call(
        "sendRichMessage",
        json({
          chat_id: chatId,
          message_thread_id: topicId,
          rich_message: JSON.stringify({ markdown }),
          ...(buttons && buttons.length > 0 ? { reply_markup: inlineKeyboard(buttons) } : {}),
        }),
        SentMessage,
      ).pipe(Effect.map((sent) => ({ messageId: sent.message_id }))),
    sendMessage: ({ chatId, topicId, text, replyToMessageId }) =>
      call(
        "sendMessage",
        json({
          chat_id: chatId,
          ...withTopic(topicId),
          text,
          ...(replyToMessageId === undefined
            ? {}
            : { reply_parameters: { message_id: replyToMessageId } }),
        }),
        SentMessage,
      ).pipe(Effect.map((sent) => ({ messageId: sent.message_id }))),
    sendVoice: ({ chatId, topicId, voice, caption }) =>
      call(
        "sendVoice",
        uploadForm({ chat_id: chatId, message_thread_id: topicId, caption }, "voice", voice),
        SentVoice,
        UPLOAD_TIMEOUT,
      ).pipe(Effect.map((sent) => ({ durationSeconds: sent.voice?.duration ?? null }))),
    sendDocument: ({ chatId, topicId, document, caption }) =>
      call(
        "sendDocument",
        uploadForm({ chat_id: chatId, message_thread_id: topicId, caption }, "document", document),
        SentMessage,
        UPLOAD_TIMEOUT,
      ).pipe(Effect.asVoid),
    createForumTopic: ({ chatId, name }) =>
      call("createForumTopic", json({ chat_id: chatId, name }), ForumTopic).pipe(
        Effect.map((topic) => ({ topicId: topic.message_thread_id, name: topic.name })),
      ),
    editForumTopic: ({ chatId, topicId, name }) =>
      call(
        "editForumTopic",
        json({ chat_id: chatId, message_thread_id: topicId, name }),
        Schema.Unknown,
      ).pipe(Effect.asVoid),
    setMessageReaction: ({ chatId, messageId, emoji }) =>
      call(
        "setMessageReaction",
        json({ chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji }] }),
        Schema.Unknown,
      ).pipe(Effect.asVoid),
    answerCallbackQuery: ({ callbackQueryId, text }) =>
      call(
        "answerCallbackQuery",
        json({ callback_query_id: callbackQueryId, text }),
        Schema.Unknown,
      ).pipe(Effect.asVoid),
    editMessageButtons: ({ chatId, messageId, buttons }) =>
      call(
        "editMessageReplyMarkup",
        json({ chat_id: chatId, message_id: messageId, reply_markup: inlineKeyboard(buttons) }),
        Schema.Unknown,
      ).pipe(Effect.asVoid),
    downloadFile: (fileId) =>
      Effect.gen(function* () {
        const file = yield* call("getFile", json({ file_id: fileId }), TelegramFile);
        if (file.file_path === undefined || (file.file_size ?? 0) > MAX_DOWNLOAD_BYTES) {
          return yield* new TelegramApiError({
            method: "getFile",
            description: "The file is too large to download.",
          });
        }
        const buffer = yield* httpClient
          .get(`${TELEGRAM_API_ORIGIN}/file/bot${token}/${file.file_path}`)
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap((response) => response.arrayBuffer),
            Effect.timeout(UPLOAD_TIMEOUT),
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            Effect.mapError(() => transportError("downloadFile")),
          );
        return new Uint8Array(buffer);
      }),
  };
};

export const layer = Layer.effect(
  TelegramBotApi,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return TelegramBotApi.of({ client: (token) => makeClient(httpClient, token) });
  }),
);
