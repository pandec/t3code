import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEventType,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  coalesceThreadStreamItems,
  filterAppliedThreadStreamItems,
  isStructuralThreadStreamItem,
  ThreadEventCoalescing,
  threadEventCoalescingLayer,
} from "./threadEventCoalescing.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";

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

const STRUCTURAL_EVENT_TYPES = {
  "project.created": false,
  "project.meta-updated": false,
  "project.deleted": false,
  "thread.created": true,
  "thread.fork-requested": false,
  "thread.history-imported": true,
  "thread.deleted": true,
  "thread.archived": true,
  "thread.unarchived": true,
  "thread.settled": true,
  "thread.unsettled": true,
  "thread.snoozed": true,
  "thread.unsnoozed": true,
  "thread.moved-to-top": true,
  "thread.pinned": true,
  "thread.unpinned": true,
  "thread.pin-reordered": true,
  "thread.meta-updated": true,
  "thread.runtime-mode-set": true,
  "thread.interaction-mode-set": true,
  "thread.message-sent": true,
  "thread.message-speech-requested": true,
  "thread.message-speech-completed": true,
  "thread.turn-start-requested": true,
  "thread.turn-interrupt-requested": true,
  "thread.approval-response-requested": false,
  "thread.user-input-response-requested": false,
  "thread.checkpoint-revert-requested": false,
  "thread.reverted": true,
  "thread.session-stop-requested": true,
  "thread.session-set": true,
  "thread.proposed-plan-upserted": true,
  "thread.turn-diff-completed": false,
  "thread.activity-appended": false,
} satisfies Record<OrchestrationEventType, boolean>;

function eventItemForClassification(type: OrchestrationEventType): OrchestrationThreadStreamItem {
  return {
    kind: "event",
    event: {
      eventId: EventId.make(`classification-${type}`),
      sequence: 1,
      occurredAt: "2026-04-01T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type,
      payload:
        type === "thread.message-sent"
          ? {
              threadId: THREAD_ID,
              messageId: MessageId.make("message-classification"),
              role: "assistant",
              text: "complete",
              turnId: TurnId.make("turn-classification"),
              streaming: false,
              createdAt: "2026-04-01T00:00:00.000Z",
              updatedAt: "2026-04-01T00:00:00.000Z",
            }
          : {},
    },
  } as OrchestrationThreadStreamItem;
}

const BASE_THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  movedToTopAt: null,
  deletedAt: null,
  messages: [],
  completedTurnAssistantMessageIds: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

function eventOf(item: OrchestrationThreadStreamItem) {
  if (item.kind !== "event") throw new Error("expected an event item");
  return item.event;
}

describe("filterAppliedThreadStreamItems", () => {
  it("drops a replayed event but keeps a fresh event in the same batch", () => {
    // Cursor is already at sequence 10 (applied in a prior batch). A replay
    // batch redelivers seq10 alongside a genuinely new seq11 delta.
    const replay = messageDelta("Hello", 10);
    const fresh = messageDelta(" world", 11);

    const result = filterAppliedThreadStreamItems([replay, fresh], 10);

    expect(result).toHaveLength(1);
    expect(eventOf(result[0]!).sequence).toBe(11);
  });

  it("drops duplicate same-sequence deltas within a single batch", () => {
    const first = messageDelta("Hello", 11);
    const duplicate = messageDelta("Hello", 11);
    const next = messageDelta(" world", 12);

    const result = filterAppliedThreadStreamItems([first, duplicate, next], 10);

    expect(result).toHaveLength(2);
    expect(eventOf(result[0]!).sequence).toBe(11);
    expect(eventOf(result[1]!).sequence).toBe(12);
  });

  it("drops everything at-or-below the cursor and keeps synchronized/snapshot markers", () => {
    const result = filterAppliedThreadStreamItems(
      [messageDelta("stale", 5), { kind: "synchronized" }, messageDelta("stale-again", 3)],
      10,
    );

    expect(result).toEqual([{ kind: "synchronized" }]);
  });
});

describe("thread event coalescing", () => {
  it("filters replayed events before merging so stale text never joins a fresh chunk", () => {
    // Without filtering first, merging would concatenate the replayed
    // seq10 text into the seq11 delta even though seq10 was already
    // applied and should be dropped entirely.
    const replay = messageDelta("Hello", 10);
    const fresh = messageDelta(" world", 11);

    const filtered = filterAppliedThreadStreamItems([replay, fresh], 10);
    const coalesced = coalesceThreadStreamItems(filtered);

    expect(coalesced).toHaveLength(1);
    const event = eventOf(coalesced[0]!);
    if (event.type !== "thread.message-sent") throw new Error("expected message-sent");
    expect(event.payload.text).toBe(" world");
    expect(event.sequence).toBe(11);
  });

  it("produces byte-identical thread state whether deltas are merged or applied one at a time", () => {
    const first = messageDelta("Hello", 11);
    const second = messageDelta(" world", 12);

    const coalesced = coalesceThreadStreamItems(
      filterAppliedThreadStreamItems([first, second], 10),
    );
    expect(coalesced).toHaveLength(1);
    const mergedResult = applyThreadDetailEvent(BASE_THREAD, eventOf(coalesced[0]!));
    if (mergedResult.kind !== "updated") throw new Error("expected updated thread");

    const afterFirst = applyThreadDetailEvent(BASE_THREAD, eventOf(first));
    if (afterFirst.kind !== "updated") throw new Error("expected updated thread");
    const afterSecond = applyThreadDetailEvent(afterFirst.thread, eventOf(second));
    if (afterSecond.kind !== "updated") throw new Error("expected updated thread");

    expect(JSON.stringify(mergedResult.thread)).toBe(JSON.stringify(afterSecond.thread));
  });

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

  it("classifies every orchestration event type exhaustively", () => {
    for (const [type, structural] of Object.entries(STRUCTURAL_EVENT_TYPES)) {
      expect(
        isStructuralThreadStreamItem(eventItemForClassification(type as OrchestrationEventType)),
        type,
      ).toBe(structural);
    }
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
