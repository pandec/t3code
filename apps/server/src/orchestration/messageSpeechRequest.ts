import { MESSAGE_SPEECH_MAX_SOURCE_CHARS, type OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionThreadMessageRepositoryShape } from "../persistence/Services/ProjectionThreadMessages.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

type MessageSpeechRequestCommand = Extract<
  OrchestrationCommand,
  { type: "thread.message.speech.request" }
>;

export const validateMessageSpeechRequest = Effect.fn("validateMessageSpeechRequest")(function* (
  repository: ProjectionThreadMessageRepositoryShape,
  command: MessageSpeechRequestCommand,
) {
  const message = yield* repository.getByMessageId({ messageId: command.messageId });
  const projected = Option.getOrUndefined(message);
  if (projected === undefined || projected.threadId !== command.threadId) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Message '${command.messageId}' does not exist in thread '${command.threadId}'.`,
    });
  }
  if (projected.role !== "assistant") {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Message '${command.messageId}' is not an assistant message.`,
    });
  }
  if (projected.isStreaming) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Message '${command.messageId}' is still streaming.`,
    });
  }
  const sourceText = projected.text.trim();
  if (sourceText.length === 0) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Message '${command.messageId}' has no text to synthesize.`,
    });
  }
  if (sourceText.length > MESSAGE_SPEECH_MAX_SOURCE_CHARS) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Message '${command.messageId}' is too long to synthesize.`,
    });
  }
  if (
    projected.speechRequestId !== null &&
    projected.speechRequestId !== undefined &&
    projected.speechRequestId !== command.commandId
  ) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Message '${command.messageId}' already has a pending speech request.`,
    });
  }
});
