import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import {
  flattenQueuedThreadMessages,
  groupQueuedThreadMessages,
  type QueuedThreadMessage,
} from "./threadOutboxModel.ts";
import type { ThreadOutboxStorage } from "./threadOutboxStorage.ts";

export class ThreadOutboxManagerError extends Schema.TaggedErrorClass<ThreadOutboxManagerError>()(
  "ThreadOutboxManagerError",
  {
    operation: Schema.Literals([
      "load",
      "enqueue",
      "update",
      "remove",
      "clear-environment-load",
      "clear-environment-remove",
    ]),
    environmentId: Schema.NullOr(EnvironmentId),
    threadId: Schema.NullOr(ThreadId),
    messageId: Schema.NullOr(MessageId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread outbox operation ${this.operation} failed for environment ${this.environmentId ?? "unknown"}, thread ${this.threadId ?? "unknown"}, message ${this.messageId ?? "unknown"}.`;
  }
}

export type ThreadOutboxLoadState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly error: ThreadOutboxManagerError };

export interface ThreadOutboxManagerOptions {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly storage: ThreadOutboxStorage;
  readonly atomLabel?: string;
  readonly warn?: (message: string, error: unknown) => void;
}

export type ThreadOutboxManager = ReturnType<typeof createThreadOutboxManager>;

export function createThreadOutboxManager(options: ThreadOutboxManagerOptions) {
  const atomLabel = options.atomLabel ?? "thread-outbox:queued-messages";
  const queuedMessagesByThreadKeyAtom = Atom.make<
    Record<string, ReadonlyArray<QueuedThreadMessage>>
  >({}).pipe(Atom.keepAlive, Atom.withLabel(atomLabel));
  const loadStateAtom = Atom.make<ThreadOutboxLoadState>({ status: "idle" }).pipe(
    Atom.keepAlive,
    Atom.withLabel(`${atomLabel}:load-state`),
  );
  const warn = options.warn ?? (() => undefined);
  let loadPromise: Promise<boolean> | null = null;
  let mutationQueue: Promise<void> = Promise.resolve();
  // Monotonic per-message write counter. Every accepted write (enqueue publish
  // or update) bumps it, so a writer that captured a revision before slow work
  // is rejected before its stale payload reaches disk.
  const revisions = new Map<MessageId, number>();
  const bumpRevision = (messageId: MessageId): void => {
    revisions.set(messageId, (revisions.get(messageId) ?? 0) + 1);
  };

  const serialize = <A>(mutation: () => Promise<A>): Promise<A> => {
    const result = mutationQueue.then(mutation, mutation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const currentMessages = (): ReadonlyArray<QueuedThreadMessage> =>
    flattenQueuedThreadMessages(options.registry.get(queuedMessagesByThreadKeyAtom));

  const setMessages = (messages: ReadonlyArray<QueuedThreadMessage>): void => {
    options.registry.set(queuedMessagesByThreadKeyAtom, groupQueuedThreadMessages(messages));
  };

  // Readable messages can be used after a partial load. Only a complete load
  // returns true, so cleanup cannot delete files owned by unreadable records.
  // A later call retries failed reads without replacing live message objects.
  const load = (): Promise<boolean> => {
    if (loadPromise !== null) return loadPromise;
    options.registry.set(loadStateAtom, { status: "loading" });
    loadPromise = serialize(async () => {
      const result = await options.storage.load();
      const current = currentMessages();
      const currentIds = new Set(current.map((message) => message.messageId));
      const recovered = result.messages.filter(
        (message) => !currentIds.has(message.messageId) && !revisions.has(message.messageId),
      );
      // Accepted edits and removals win over a later disk read. Retaining
      // current objects also keeps retries from restarting the drain.
      if (recovered.length > 0) setMessages([...recovered, ...current]);
      if (result.errors.length > 0) {
        throw new AggregateError(result.errors, "Some queued messages could not be read.");
      }
      options.registry.set(loadStateAtom, { status: "ready" });
      return true;
    }).catch((cause) => {
      const error = new ThreadOutboxManagerError({
        operation: "load",
        environmentId: null,
        threadId: null,
        messageId: null,
        cause,
      });
      loadPromise = null;
      options.registry.set(loadStateAtom, { status: "failed", error });
      warn("[thread-outbox] failed to load persisted messages", error);
      return false;
    });
    return loadPromise;
  };

  // Publish synchronously so composers can respond on the initiating frame.
  // The durable write follows through the serialized queue; if it fails, roll
  // back only this exact enqueue attempt.
  const enqueue = (message: QueuedThreadMessage): Promise<void> => {
    bumpRevision(message.messageId);
    setMessages([
      ...currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
      message,
    ]);
    return serialize(async () => {
      try {
        await options.storage.write(message);
      } catch (cause) {
        setMessages(currentMessages().filter((candidate) => candidate !== message));
        // A concurrent stale writer can have compensation-written this payload.
        // Remove it when no same-id winner survives, or restart resurrects it.
        if (!currentMessages().some((candidate) => candidate.messageId === message.messageId)) {
          try {
            await options.storage.remove(message);
          } catch {
            // Best effort: bootstrap reconciles the queue against storage.
          }
        }
        throw new ThreadOutboxManagerError({
          operation: "enqueue",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        });
      }
    });
  };

  // Wait for pending mutations, then confirm that this exact enqueue attempt
  // survived. Drains use this to avoid delivering a row whose write failed.
  const confirmQueued = (message: QueuedThreadMessage): Promise<boolean> =>
    serialize(async () => currentMessages().some((candidate) => candidate === message));

  // Rewrites an already-queued message. `expectedRevision` makes this a
  // compare-and-set around slow attachment work. A same-id enqueue can publish
  // while the durable write is in flight, so the revision is checked again
  // after the write and a stale persisted payload is repaired immediately.
  const update = (message: QueuedThreadMessage, expectedRevision?: number): Promise<boolean> =>
    serialize(async () => {
      const staleOrMissing = (): boolean =>
        !currentMessages().some((candidate) => candidate.messageId === message.messageId) ||
        (expectedRevision !== undefined &&
          (revisions.get(message.messageId) ?? 0) !== expectedRevision);
      if (staleOrMissing()) return false;
      try {
        await options.storage.write(message);
      } catch (cause) {
        throw new ThreadOutboxManagerError({
          operation: "update",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        });
      }
      if (staleOrMissing()) {
        const winner = currentMessages().find(
          (candidate) => candidate.messageId === message.messageId,
        );
        if (winner !== undefined) {
          try {
            await options.storage.write(winner);
          } catch {
            // The winner's serialized write owns failure handling.
          }
        }
        return false;
      }
      bumpRevision(message.messageId);
      setMessages([
        ...currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
        message,
      ]);
      return true;
    });

  // `expectedRevision` protects against an accepted edit after the caller made
  // its decision. `canRemove` adds a live ownership check for an open editor.
  // The removed payload is returned so cleanup sees attachments added by a
  // concurrent accepted update rather than only the caller's old snapshot.
  const remove = (
    message: QueuedThreadMessage,
    expectedRevision?: number,
    canRemove?: () => boolean,
  ): Promise<QueuedThreadMessage | null> =>
    serialize(async () => {
      const removalCanceled = (): boolean =>
        (expectedRevision !== undefined &&
          (revisions.get(message.messageId) ?? 0) !== expectedRevision) ||
        canRemove?.() === false;
      if (removalCanceled()) return null;
      const removed = currentMessages().find(
        (candidate) => candidate.messageId === message.messageId,
      );
      if (removed === undefined) return null;
      try {
        await options.storage.remove(removed);
      } catch (cause) {
        throw new ThreadOutboxManagerError({
          operation: "remove",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        });
      }
      if (removalCanceled()) {
        const winner = currentMessages().find(
          (candidate) => candidate.messageId === message.messageId,
        );
        if (winner !== undefined) {
          try {
            await options.storage.write(winner);
          } catch (cause) {
            throw new ThreadOutboxManagerError({
              operation: "remove",
              environmentId: message.environmentId,
              threadId: message.threadId,
              messageId: message.messageId,
              cause,
            });
          }
        }
        return null;
      }
      setMessages(
        currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
      );
      // Tombstone rather than delete the revision to prevent ABA with a same-id
      // retry that restarts at revision one.
      bumpRevision(message.messageId);
      return removed;
    });

  const clearEnvironment = (
    environmentId: EnvironmentId,
  ): Promise<ReadonlyArray<QueuedThreadMessage>> => {
    // Enqueues publish before their serialized writes. Capture revisions now,
    // then wait for earlier mutations before deciding which rows belong to this
    // request; any message changed after the request must survive.
    const revisionsAtRequest = new Map(revisions);
    return serialize(async () => {
      const persisted = await options.storage
        .load()
        .then((result) => {
          if (result.errors.length > 0) {
            throw new AggregateError(result.errors, "Some queued messages could not be read.");
          }
          return result.messages;
        })
        .catch((cause) => {
          throw new ThreadOutboxManagerError({
            operation: "clear-environment-load",
            environmentId,
            threadId: null,
            messageId: null,
            cause,
          });
        });
      const allMessages = flattenQueuedThreadMessages(
        groupQueuedThreadMessages([...persisted, ...currentMessages()]),
      );
      const candidates = allMessages.filter(
        (message) =>
          message.environmentId === environmentId &&
          (revisions.get(message.messageId) ?? 0) ===
            (revisionsAtRequest.get(message.messageId) ?? 0),
      );
      const candidateRevisions = new Map(
        candidates.map(
          (message) => [message.messageId, revisions.get(message.messageId) ?? 0] as const,
        ),
      );
      const removedFromStorage = new Set<MessageId>();

      await Promise.all(
        candidates.map(async (message) => {
          try {
            await options.storage.remove(message);
            removedFromStorage.add(message.messageId);
          } catch (cause) {
            warn(
              "[thread-outbox] failed to clear persisted message",
              new ThreadOutboxManagerError({
                operation: "clear-environment-remove",
                environmentId: message.environmentId,
                threadId: message.threadId,
                messageId: message.messageId,
                cause,
              }),
            );
          }
        }),
      );

      // A same-id enqueue can publish while storage removal waits. Restore its
      // payload before the later serialized enqueue write gets its turn.
      await Promise.all(
        candidates.map(async (message) => {
          if (
            !removedFromStorage.has(message.messageId) ||
            (revisions.get(message.messageId) ?? 0) === candidateRevisions.get(message.messageId)
          ) {
            return;
          }
          const retained = currentMessages().find(
            (candidate) => candidate.messageId === message.messageId,
          );
          if (retained === undefined) return;
          try {
            await options.storage.write(retained);
          } catch (cause) {
            warn(
              "[thread-outbox] failed to restore message retained during environment clear",
              new ThreadOutboxManagerError({
                operation: "clear-environment-remove",
                environmentId: retained.environmentId,
                threadId: retained.threadId,
                messageId: retained.messageId,
                cause,
              }),
            );
          }
        }),
      );

      const removed = candidates.filter(
        (message) =>
          removedFromStorage.has(message.messageId) &&
          (revisions.get(message.messageId) ?? 0) === candidateRevisions.get(message.messageId),
      );
      const removedMessageIds = new Set(removed.map((message) => message.messageId));
      const reconciledMessages = flattenQueuedThreadMessages(
        groupQueuedThreadMessages([...allMessages, ...currentMessages()]),
      ).filter((message) => !removedMessageIds.has(message.messageId));
      for (const message of removed) bumpRevision(message.messageId);
      setMessages(reconciledMessages);
      return removed;
    });
  };

  return {
    queuedMessagesByThreadKeyAtom,
    loadStateAtom,
    serialize,
    load,
    enqueue,
    confirmQueued,
    revisionOf: (messageId: MessageId): number => revisions.get(messageId) ?? 0,
    update,
    remove,
    clearEnvironment,
  };
}
