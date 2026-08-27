import { type OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { makeMessageArtifactLockCoordinator } from "../messageArtifacts/lock.ts";
import type { ProjectionThreadMessageRepositoryShape } from "../persistence/Services/ProjectionThreadMessages.ts";
import { getMessageSpeechSourceFailureReason } from "../voice/MessageSpeech.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

type MessageSpeechRequestCommand = Extract<
  OrchestrationCommand,
  { type: "thread.message.speech.request" }
>;

const requestDispatchLocks = Effect.runSync(makeMessageArtifactLockCoordinator());

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

  const sourceFailureReason = getMessageSpeechSourceFailureReason({
    role: projected.role,
    isStreaming: projected.isStreaming,
    text: projected.text,
  });
  if (sourceFailureReason !== null) {
    const detail =
      projected.role !== "assistant"
        ? `Message '${command.messageId}' is not an assistant message.`
        : projected.isStreaming
          ? `Message '${command.messageId}' is still streaming.`
          : projected.text.trim().length === 0
            ? `Message '${command.messageId}' has no text to synthesize.`
            : `Message '${command.messageId}' is too long to synthesize.`;
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail,
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

export const validateAndDispatchMessageSpeechRequest = <A, E, R>(
  repository: ProjectionThreadMessageRepositoryShape,
  command: MessageSpeechRequestCommand,
  dispatch: Effect.Effect<A, E, R>,
) =>
  requestDispatchLocks.withMessageLock(
    command.messageId,
    validateMessageSpeechRequest(repository, command).pipe(Effect.andThen(dispatch)),
  );
