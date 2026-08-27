import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { subscribeToMessageSpeechCompletion } from "./http.ts";

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
