import {
  CommandId,
  MESSAGE_SPEECH_MAX_SOURCE_CHARS,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  type ProjectionThreadMessage,
  type ProjectionThreadMessageRepositoryShape,
} from "../persistence/Services/ProjectionThreadMessages.ts";
import { validateMessageSpeechRequest } from "./messageSpeechRequest.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const messageId = MessageId.make("message-1");
const commandId = CommandId.make("command-1");
const command = {
  type: "thread.message.speech.request",
  commandId,
  threadId,
  messageId,
} as const;

const message = (overrides: Partial<ProjectionThreadMessage> = {}): ProjectionThreadMessage => ({
  messageId,
  threadId,
  turnId: null,
  role: "assistant",
  text: "Ready to listen",
  speechRequestId: null,
  speechRequestStartedAt: null,
  isStreaming: false,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const repository = (
  projected: Option.Option<ProjectionThreadMessage>,
): ProjectionThreadMessageRepositoryShape => ({
  upsert: () => Effect.void,
  getByMessageId: () => Effect.succeed(projected),
  getSpeechByMessageId: () => Effect.succeed(Option.none()),
  listPendingSpeechRequests: Effect.succeed([]),
  listByThreadId: () => Effect.succeed([]),
  deleteByThreadId: () => Effect.void,
  copyTextMessagesForFork: () => Effect.void,
});

const expectInvariant = Effect.fn("expectMessageSpeechRequestInvariant")(function* (
  projected: Option.Option<ProjectionThreadMessage>,
  detail: string,
) {
  const error = yield* validateMessageSpeechRequest(repository(projected), command).pipe(
    Effect.flip,
  );
  assert.equal(error._tag, "OrchestrationCommandInvariantError");
  if (error._tag === "OrchestrationCommandInvariantError") {
    assert.include(error.detail, detail);
  }
});

it.effect("rejects missing and wrong-thread messages", () =>
  Effect.gen(function* () {
    yield* expectInvariant(Option.none(), "does not exist");
    yield* expectInvariant(
      Option.some(message({ threadId: ThreadId.make("thread-2") })),
      "does not exist",
    );
  }),
);

it.effect("rejects ineligible assistant-message state", () =>
  Effect.gen(function* () {
    yield* expectInvariant(Option.some(message({ role: "user" })), "not an assistant");
    yield* expectInvariant(Option.some(message({ isStreaming: true })), "still streaming");
    yield* expectInvariant(Option.some(message({ text: "   " })), "no text");
    yield* expectInvariant(
      Option.some(message({ text: "x".repeat(MESSAGE_SPEECH_MAX_SOURCE_CHARS + 1) })),
      "too long",
    );
  }),
);

it.effect("rejects a different pending request", () =>
  expectInvariant(
    Option.some(message({ speechRequestId: CommandId.make("command-2") })),
    "already has a pending speech request",
  ),
);

it.effect("allows a retry with the same command id", () =>
  validateMessageSpeechRequest(
    repository(Option.some(message({ speechRequestId: commandId }))),
    command,
  ),
);
