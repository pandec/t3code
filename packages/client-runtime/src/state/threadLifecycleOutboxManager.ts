import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import {
  groupThreadLifecycleIntents,
  threadLifecycleIntentKey,
  type ThreadLifecycleIntent,
} from "./threadLifecycleOutboxModel.ts";
import type { ThreadLifecycleOutboxStorage } from "./threadLifecycleOutboxStorage.ts";

export class ThreadLifecycleOutboxManagerError extends Schema.TaggedErrorClass<ThreadLifecycleOutboxManagerError>()(
  "ThreadLifecycleOutboxManagerError",
  {
    operation: Schema.Literals([
      "load",
      "enqueue",
      "remove",
      "clear-environment-load",
      "clear-environment-remove",
    ]),
    environmentId: Schema.NullOr(EnvironmentId),
    threadId: Schema.NullOr(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread lifecycle outbox operation ${this.operation} failed for environment ${this.environmentId ?? "unknown"}, thread ${this.threadId ?? "unknown"}.`;
  }
}

export interface ThreadLifecycleOutboxManagerOptions {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly storage: ThreadLifecycleOutboxStorage;
  readonly atomLabel?: string;
  readonly warn?: (message: string, error: unknown) => void;
}

export type ThreadLifecycleOutboxManager = ReturnType<typeof createThreadLifecycleOutboxManager>;

export function createThreadLifecycleOutboxManager(options: ThreadLifecycleOutboxManagerOptions) {
  const intentsByThreadKeyAtom = Atom.make<Readonly<Record<string, ThreadLifecycleIntent>>>(
    {},
  ).pipe(Atom.keepAlive, Atom.withLabel(options.atomLabel ?? "thread-lifecycle-outbox:intents"));
  const warn = options.warn ?? (() => undefined);
  let loadPromise: Promise<void> | null = null;
  let mutationQueue: Promise<void> = Promise.resolve();

  const serialize = <A>(mutation: () => Promise<A>): Promise<A> => {
    const result = mutationQueue.then(mutation, mutation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const currentIntents = (): Readonly<Record<string, ThreadLifecycleIntent>> =>
    options.registry.get(intentsByThreadKeyAtom);

  const setIntents = (intents: Readonly<Record<string, ThreadLifecycleIntent>>): void => {
    options.registry.set(intentsByThreadKeyAtom, intents);
  };

  const load = (): Promise<void> => {
    if (loadPromise !== null) return loadPromise;
    loadPromise = serialize(async () => {
      const persisted = groupThreadLifecycleIntents(await options.storage.load());
      setIntents({ ...persisted, ...currentIntents() });
    }).catch((cause) => {
      loadPromise = null;
      warn(
        "[thread-lifecycle-outbox] failed to load persisted intents",
        new ThreadLifecycleOutboxManagerError({
          operation: "load",
          environmentId: null,
          threadId: null,
          cause,
        }),
      );
    });
    return loadPromise;
  };

  const enqueue = (intent: ThreadLifecycleIntent): Promise<void> => {
    const key = threadLifecycleIntentKey(intent.environmentId, intent.threadId);
    const previous = currentIntents()[key];
    setIntents({ ...currentIntents(), [key]: intent });
    return serialize(async () => {
      try {
        await options.storage.write(intent);
      } catch (cause) {
        if (currentIntents()[key] === intent) {
          const next = { ...currentIntents() };
          if (previous === undefined) delete next[key];
          else next[key] = previous;
          setIntents(next);
        }
        throw new ThreadLifecycleOutboxManagerError({
          operation: "enqueue",
          environmentId: intent.environmentId,
          threadId: intent.threadId,
          cause,
        });
      }
    });
  };

  const confirmCurrent = (intent: ThreadLifecycleIntent): Promise<boolean> =>
    serialize(async () =>
      Object.is(
        currentIntents()[threadLifecycleIntentKey(intent.environmentId, intent.threadId)],
        intent,
      ),
    );

  const removeIfCurrent = (intent: ThreadLifecycleIntent): Promise<boolean> =>
    serialize(async () => {
      const key = threadLifecycleIntentKey(intent.environmentId, intent.threadId);
      const current = currentIntents()[key];
      if (current?.commandId !== intent.commandId) return false;

      const next = { ...currentIntents() };
      delete next[key];
      setIntents(next);
      try {
        await options.storage.remove(intent);
      } catch (cause) {
        if (currentIntents()[key] === undefined) {
          setIntents({ ...currentIntents(), [key]: intent });
        }
        throw new ThreadLifecycleOutboxManagerError({
          operation: "remove",
          environmentId: intent.environmentId,
          threadId: intent.threadId,
          cause,
        });
      }
      return true;
    });

  const clearEnvironment = (environmentId: EnvironmentId): Promise<void> =>
    serialize(async () => {
      const persisted = await options.storage.load().catch((cause) => {
        warn(
          "[thread-lifecycle-outbox] failed to load intents while clearing environment",
          new ThreadLifecycleOutboxManagerError({
            operation: "clear-environment-load",
            environmentId,
            threadId: null,
            cause,
          }),
        );
        return [];
      });
      const all = groupThreadLifecycleIntents([...persisted, ...Object.values(currentIntents())]);
      const removedKeys = new Set<string>();
      await Promise.all(
        Object.entries(all)
          .filter(([, intent]) => intent.environmentId === environmentId)
          .map(async ([key, intent]) => {
            try {
              await options.storage.remove(intent);
              removedKeys.add(key);
            } catch (cause) {
              warn(
                "[thread-lifecycle-outbox] failed to clear persisted intent",
                new ThreadLifecycleOutboxManagerError({
                  operation: "clear-environment-remove",
                  environmentId: intent.environmentId,
                  threadId: intent.threadId,
                  cause,
                }),
              );
            }
          }),
      );
      setIntents(Object.fromEntries(Object.entries(all).filter(([key]) => !removedKeys.has(key))));
    });

  return {
    intentsByThreadKeyAtom,
    serialize,
    load,
    enqueue,
    confirmCurrent,
    removeIfCurrent,
    clearEnvironment,
  };
}
