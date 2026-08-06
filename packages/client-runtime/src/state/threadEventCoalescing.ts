import { type OrchestrationThreadStreamItem, type ScopedThreadRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { threadKey } from "./entities.ts";

export type ThreadEventPriority = "foreground" | "background";

export const THREAD_EVENT_FOREGROUND_WINDOW_MS = 50;
export const THREAD_EVENT_BACKGROUND_WINDOW_MS = 750;

export interface ThreadEventPriorityChange {
  readonly threadRef: ScopedThreadRef;
  readonly priority: ThreadEventPriority;
}

export interface ThreadEventCoalescingOptions {
  readonly defaultPriority?: ThreadEventPriority;
  readonly foregroundWindowMs?: number;
  readonly backgroundWindowMs?: number;
}

interface ThreadEventPriorityState {
  readonly priorities: ReadonlyMap<string, ThreadEventPriority>;
  readonly foreground: ScopedThreadRef | null;
}

export class ThreadEventCoalescing extends Context.Service<
  ThreadEventCoalescing,
  {
    readonly changes: Stream.Stream<ThreadEventPriorityChange>;
    readonly priority: (threadRef: ScopedThreadRef) => Effect.Effect<ThreadEventPriority>;
    readonly windowMs: (priority: ThreadEventPriority) => number;
    readonly setPriority: (
      threadRef: ScopedThreadRef,
      priority: ThreadEventPriority,
    ) => Effect.Effect<void>;
    readonly setForeground: (threadRef: ScopedThreadRef | null) => Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/state/threadEventCoalescing") {}

function sameThread(left: ScopedThreadRef | null, right: ScopedThreadRef | null): boolean {
  if (left === null || right === null) return left === right;
  return threadKey(left) === threadKey(right);
}

export function threadEventCoalescingLayer(
  options: ThreadEventCoalescingOptions = {},
): Layer.Layer<ThreadEventCoalescing> {
  const defaultPriority = options.defaultPriority ?? "foreground";
  const foregroundWindowMs = options.foregroundWindowMs ?? THREAD_EVENT_FOREGROUND_WINDOW_MS;
  const backgroundWindowMs = options.backgroundWindowMs ?? THREAD_EVENT_BACKGROUND_WINDOW_MS;

  return Layer.effect(
    ThreadEventCoalescing,
    Effect.gen(function* () {
      const state = yield* Ref.make<ThreadEventPriorityState>({
        priorities: new Map(),
        foreground: null,
      });
      const changes = yield* PubSub.unbounded<ThreadEventPriorityChange>();

      const publish = (updates: ReadonlyArray<ThreadEventPriorityChange>) =>
        Effect.forEach(updates, (update) => PubSub.publish(changes, update), {
          discard: true,
        });

      return ThreadEventCoalescing.of({
        changes: Stream.fromPubSub(changes),
        priority: (threadRef) =>
          Ref.get(state).pipe(
            Effect.map(
              (current) => current.priorities.get(threadKey(threadRef)) ?? defaultPriority,
            ),
          ),
        windowMs: (priority) =>
          priority === "foreground" ? foregroundWindowMs : backgroundWindowMs,
        setPriority: (threadRef, priority) =>
          Ref.modify(state, (current): readonly [boolean, ThreadEventPriorityState] => {
            const key = threadKey(threadRef);
            if ((current.priorities.get(key) ?? defaultPriority) === priority) {
              return [false, current];
            }
            const priorities = new Map(current.priorities);
            priorities.set(key, priority);
            return [true, { ...current, priorities }];
          }).pipe(
            Effect.flatMap((changed) =>
              changed
                ? PubSub.publish(changes, { threadRef, priority }).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
        setForeground: (threadRef) =>
          Ref.modify(
            state,
            (
              current,
            ): readonly [ReadonlyArray<ThreadEventPriorityChange>, ThreadEventPriorityState] => {
              if (sameThread(current.foreground, threadRef)) return [[], current];

              const priorities = new Map(current.priorities);
              const updates: Array<ThreadEventPriorityChange> = [];
              if (current.foreground !== null) {
                priorities.set(threadKey(current.foreground), "background");
                updates.push({ threadRef: current.foreground, priority: "background" });
              }
              if (threadRef !== null) {
                priorities.set(threadKey(threadRef), "foreground");
                updates.push({ threadRef, priority: "foreground" });
              }
              return [updates, { priorities, foreground: threadRef }];
            },
          ).pipe(Effect.flatMap(publish)),
      });
    }),
  );
}

export const disabledThreadEventCoalescingLayer = threadEventCoalescingLayer({
  foregroundWindowMs: 0,
  backgroundWindowMs: 0,
});

export function setThreadEventPriority(
  threadRef: ScopedThreadRef,
  priority: ThreadEventPriority,
): Effect.Effect<void, never, ThreadEventCoalescing> {
  return ThreadEventCoalescing.pipe(
    Effect.flatMap((coalescing) => coalescing.setPriority(threadRef, priority)),
  );
}

export function setForegroundThreadEventPriority(
  threadRef: ScopedThreadRef | null,
): Effect.Effect<void, never, ThreadEventCoalescing> {
  return ThreadEventCoalescing.pipe(
    Effect.flatMap((coalescing) => coalescing.setForeground(threadRef)),
  );
}

function canMergeMessageDeltas(
  left: OrchestrationThreadStreamItem,
  right: OrchestrationThreadStreamItem,
): boolean {
  return (
    left.kind === "event" &&
    right.kind === "event" &&
    left.event.type === "thread.message-sent" &&
    right.event.type === "thread.message-sent" &&
    left.event.payload.streaming &&
    right.event.payload.streaming &&
    left.event.payload.threadId === right.event.payload.threadId &&
    left.event.payload.messageId === right.event.payload.messageId
  );
}

export function coalesceThreadStreamItems(
  items: ReadonlyArray<OrchestrationThreadStreamItem>,
): ReadonlyArray<OrchestrationThreadStreamItem> {
  const coalesced: Array<OrchestrationThreadStreamItem> = [];
  for (let index = 0; index < items.length; index += 1) {
    const first = items[index]!;
    if (
      first.kind !== "event" ||
      first.event.type !== "thread.message-sent" ||
      !first.event.payload.streaming
    ) {
      coalesced.push(first);
      continue;
    }

    const chunks = [first.event.payload.text];
    let lastEvent = first.event;
    while (index + 1 < items.length && canMergeMessageDeltas(first, items[index + 1]!)) {
      index += 1;
      const next = items[index]!;
      if (next.kind !== "event" || next.event.type !== "thread.message-sent") break;
      chunks.push(next.event.payload.text);
      lastEvent = next.event;
    }
    coalesced.push(
      lastEvent === first.event
        ? first
        : {
            kind: "event",
            event: {
              ...lastEvent,
              payload: {
                ...lastEvent.payload,
                text: chunks.join(""),
                createdAt: first.event.payload.createdAt,
              },
            },
          },
    );
  }
  return coalesced;
}

export function isStructuralThreadStreamItem(item: OrchestrationThreadStreamItem): boolean {
  if (item.kind !== "event") return true;

  switch (item.event.type) {
    case "thread.created":
    case "thread.history-imported":
    case "thread.deleted":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.moved-to-top":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.turn-start-requested":
    case "thread.turn-interrupt-requested":
    case "thread.reverted":
    case "thread.session-stop-requested":
    case "thread.session-set":
    case "thread.meta-updated":
    case "thread.runtime-mode-set":
    case "thread.interaction-mode-set":
    case "thread.proposed-plan-upserted":
      return true;
    case "thread.message-sent":
      return !item.event.payload.streaming;
    case "project.created":
    case "project.meta-updated":
    case "project.deleted":
    case "thread.fork-requested":
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.checkpoint-revert-requested":
    case "thread.turn-diff-completed":
    case "thread.activity-appended":
      return false;
  }
}
