import {
  EnvironmentId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  coalesceThreadStreamItems,
  isStructuralThreadStreamItem,
  ThreadEventCoalescing,
  threadEventCoalescingLayer,
} from "./threadEventCoalescing.ts";

const THREAD_ID = ThreadId.make("thread-1");
const THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
};
const OTHER_THREAD_REF = {
  environmentId: THREAD_REF.environmentId,
  threadId: ThreadId.make("thread-2"),
};

function messageDelta(
  text: string,
  sequence: number,
  messageId = MessageId.make("message-1"),
): OrchestrationThreadStreamItem {
  return {
    kind: "event",
    event: {
      eventId: EventId.make(`event-${sequence}`),
      sequence,
      occurredAt: `2026-04-01T00:00:0${sequence}.000Z`,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.message-sent",
      payload: {
        threadId: THREAD_ID,
        messageId,
        role: "assistant",
        text,
        turnId: TurnId.make("turn-1"),
        streaming: true,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: `2026-04-01T00:00:0${sequence}.000Z`,
      },
    },
  };
}

function sessionTransition(sequence: number): OrchestrationThreadStreamItem {
  return {
    kind: "event",
    event: {
      eventId: EventId.make(`session-${sequence}`),
      sequence,
      occurredAt: "2026-04-01T00:01:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.session-set",
      payload: {
        threadId: THREAD_ID,
        session: {
          threadId: THREAD_ID,
          status: "idle",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-04-01T00:01:00.000Z",
        },
      },
    },
  };
}

describe("thread event coalescing", () => {
  it("merges only consecutive streaming deltas for the same message", () => {
    const first = messageDelta("Hello", 1);
    const second = messageDelta(" world", 2);
    const structural = sessionTransition(3);
    const third = messageDelta("After", 4);

    const result = coalesceThreadStreamItems([first, second, structural, third]);

    expect(result).toHaveLength(3);
    expect(result[0]?.kind).toBe("event");
    if (result[0]?.kind !== "event" || result[0].event.type !== "thread.message-sent") return;
    expect(result[0].event.sequence).toBe(2);
    expect(result[0].event.payload.text).toBe("Hello world");
    expect(result[0].event.payload.updatedAt).toBe("2026-04-01T00:00:01.000Z");
    expect(result[1]).toBe(structural);
    expect(result[2]).toBe(third);
    expect(
      coalesceThreadStreamItems([first, messageDelta("other", 2, MessageId.make("message-2"))]),
    ).toHaveLength(2);
  });

  it("classifies structural transitions as immediate without delaying deltas", () => {
    expect(isStructuralThreadStreamItem(messageDelta("delta", 1))).toBe(false);
    expect(isStructuralThreadStreamItem(sessionTransition(2))).toBe(true);
    expect(isStructuralThreadStreamItem({ kind: "synchronized" })).toBe(true);
  });

  it.effect("uses configurable foreground and background tiers", () =>
    Effect.gen(function* () {
      const service = yield* ThreadEventCoalescing;
      expect(yield* service.priority(THREAD_REF)).toBe("background");
      expect(service.windowMs("foreground")).toBe(40);
      expect(service.windowMs("background")).toBe(800);

      yield* service.setPriority(THREAD_REF, "foreground");
      expect(yield* service.priority(THREAD_REF)).toBe("foreground");
      yield* service.setPriority(OTHER_THREAD_REF, "foreground");
      expect(yield* service.priority(THREAD_REF)).toBe("background");
      expect(yield* service.priority(OTHER_THREAD_REF)).toBe("foreground");
      yield* service.setPriority(OTHER_THREAD_REF, "background");
      expect(yield* service.priority(OTHER_THREAD_REF)).toBe("background");
      yield* service.setForeground(THREAD_REF);
      expect(yield* service.priority(THREAD_REF)).toBe("foreground");
    }).pipe(
      Effect.provide(
        threadEventCoalescingLayer({
          defaultPriority: "background",
          foregroundWindowMs: 40,
          backgroundWindowMs: 800,
        }),
      ),
    ),
  );
});
