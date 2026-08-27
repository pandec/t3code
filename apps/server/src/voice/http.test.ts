import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { validateAndDispatchMessageSpeechRequest } from "../orchestration/messageSpeechRequest.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type {
  ProjectionThreadMessage,
  ProjectionThreadMessageRepositoryShape,
} from "../persistence/Services/ProjectionThreadMessages.ts";
import { dispatchLegacyMessageSpeechRequest, subscribeToMessageSpeechCompletion } from "./http.ts";

const NOW = "2026-01-01T00:00:00.000Z";

it.effect("subscribes before returning to the projection reread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-1");
      const messageId = MessageId.make("message-1");
      const requestId = CommandId.make("request-1");
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const completion: OrchestrationEvent = {
        sequence: 1,
        eventId: EventId.make("event-1"),
        type: "thread.message-speech-completed",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: NOW,
        commandId: CommandId.make("completion-1"),
        causationEventId: null,
        correlationId: requestId,
        metadata: {},
        payload: {
          threadId,
          messageId,
          requestId,
          failureReason: "provider_failed",
        },
      };

      const completionFiber = yield* subscribeToMessageSpeechCompletion(
        PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
        threadId,
        messageId,
      );
      yield* PubSub.publish(events, completion);

      const received = Option.getOrUndefined(yield* Fiber.join(completionFiber));
      assert.equal(received?.eventId, completion.eventId);
    }),
  ),
);

it.effect("shares request dispatch locking with persistent clients", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-lock");
    const messageId = MessageId.make("message-lock");
    const legacyCommandId = CommandId.make("legacy-request");
    const persistentCommandId = CommandId.make("persistent-request");
    const projected = yield* Ref.make<ProjectionThreadMessage>({
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
    });
    const dispatched = yield* Ref.make<ReadonlyArray<CommandId>>([]);
    const legacyEntered = yield* Deferred.make<void>();
    const releaseLegacy = yield* Deferred.make<void>();
    const repository: ProjectionThreadMessageRepositoryShape = {
      upsert: () => Effect.void,
      getByMessageId: () => Ref.get(projected).pipe(Effect.map(Option.some)),
      getSpeechByMessageId: () => Effect.succeed(Option.none()),
      listPendingSpeechRequests: Effect.succeed([]),
      listByThreadId: () => Effect.succeed([]),
      deleteByThreadId: () => Effect.void,
      copyTextMessagesForFork: () => Effect.void,
    };
    const legacyCommand = {
      type: "thread.message.speech.request",
      commandId: legacyCommandId,
      threadId,
      messageId,
    } as const;
    const persistentCommand = {
      ...legacyCommand,
      commandId: persistentCommandId,
    };
    const legacyEngine: Pick<OrchestrationEngineShape, "dispatch"> = {
      dispatch: (command) =>
        Effect.gen(function* () {
          if (command.type !== "thread.message.speech.request") {
            return yield* Effect.die("unexpected command");
          }
          yield* Deferred.succeed(legacyEntered, undefined);
          yield* Deferred.await(releaseLegacy);
          yield* Ref.update(projected, (current) => ({
            ...current,
            speechRequestId: command.commandId,
          }));
          yield* Ref.update(dispatched, (current) => [...current, command.commandId]);
          return { sequence: 1 };
        }),
    };

    const legacyFiber = yield* dispatchLegacyMessageSpeechRequest(
      repository,
      legacyEngine,
      legacyCommand,
    ).pipe(Effect.forkChild);
    yield* Deferred.await(legacyEntered);

    const persistentFiber = yield* validateAndDispatchMessageSpeechRequest(
      repository,
      persistentCommand,
      Ref.update(dispatched, (current) => [...current, persistentCommandId]).pipe(
        Effect.andThen(
          Ref.update(projected, (current) => ({
            ...current,
            speechRequestId: persistentCommandId,
          })),
        ),
      ),
    ).pipe(Effect.result, Effect.forkChild);

    yield* Deferred.succeed(releaseLegacy, undefined);
    yield* Fiber.join(legacyFiber);
    const persistentResult = yield* Fiber.join(persistentFiber);

    assert.isTrue(Result.isFailure(persistentResult));
    if (Result.isFailure(persistentResult)) {
      assert.equal(persistentResult.failure._tag, "OrchestrationCommandInvariantError");
    }
    assert.deepEqual(yield* Ref.get(dispatched), [legacyCommandId]);
    assert.equal((yield* Ref.get(projected)).speechRequestId, legacyCommandId);
  }),
);
