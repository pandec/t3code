import { type CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/reactivity";

import {
  groupThreadLifecycleIntents,
  threadLifecycleIntentKey,
  type ThreadLifecycleDispatchAction,
  type ThreadLifecycleIntent,
} from "./thread-lifecycle-outbox-model";

export interface ThreadLifecycleOutboxStorage {
  readonly load: () => Promise<ReadonlyArray<ThreadLifecycleIntent>>;
  readonly write: (intent: ThreadLifecycleIntent) => Promise<void>;
  readonly remove: (intent: ThreadLifecycleIntent) => Promise<void>;
}

export class ThreadLifecycleOutboxManagerError extends Schema.TaggedError<ThreadLifecycleOutboxManagerError>()(
  "ThreadLifecycleOutboxManagerError",
  {
    operation: Schema.Literals([
      "load",
      "enqueue",
      "mark-dispatch-attempted",
      "rotate-command-id",
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

export type ThreadLifecycleOutboxLoadState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly error: ThreadLifecycleOutboxManagerError };

export interface ThreadLifecycleOutboxManagerOptions {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly storage: ThreadLifecycleOutboxStorage;
  readonly atomLabel?: string;
  readonly warn?: (message: string, error: unknown) => void;
}

export type ThreadLifecycleOutboxManager = ReturnType<typeof createThreadLifecycleOutboxManager>;

/**
 * Durable per-thread lifecycle intents. Mutations are serialized; the atom
 * updates optimistically and rolls back when persistence fails.
 */
export function createThreadLifecycleOutboxManager(options: ThreadLifecycleOutboxManagerOptions) {
  const intentsByThreadKeyAtom = Atom.make<Readonly<Record<string, ThreadLifecycleIntent>>>(
    {},
  ).pipe(Atom.keepAlive, Atom.withLabel(options.atomLabel ?? "thread-lifecycle-outbox:intents"));
  const loadStateAtom = Atom.make<ThreadLifecycleOutboxLoadState>({ status: "idle" }).pipe(
    Atom.keepAlive,
    Atom.withLabel(`${options.atomLabel ?? "thread-lifecycle-outbox"}:load-state`),
  );
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
    options.registry.set(loadStateAtom, { status: "loading" });
    loadPromise = serialize(async () => {
      const persisted = groupThreadLifecycleIntents(await options.storage.load());
      setIntents({ ...persisted, ...currentIntents() });
      options.registry.set(loadStateAtom, { status: "ready" });
    }).catch((cause) => {
      const error = new ThreadLifecycleOutboxManagerError({
        operation: "load",
        environmentId: null,
        threadId: null,
        cause,
      });
      loadPromise = null;
      options.registry.set(loadStateAtom, { status: "failed", error });
      warn("[thread-lifecycle-outbox] failed to load persisted intents", error);
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

  const markDispatchAttempted = (
    intent: ThreadLifecycleIntent,
    action: ThreadLifecycleDispatchAction,
  ): Promise<ThreadLifecycleIntent | null> =>
    serialize(async () => {
      const key = threadLifecycleIntentKey(intent.environmentId, intent.threadId);
      const current = currentIntents()[key];
      if (current?.commandId !== intent.commandId) return null;
      if (current.dispatchAttempted && current.dispatchedAction !== null) return current;
      const attempted = { ...current, dispatchAttempted: true, dispatchedAction: action };
      try {
        await options.storage.write(attempted);
      } catch (cause) {
        throw new ThreadLifecycleOutboxManagerError({
          operation: "mark-dispatch-attempted",
          environmentId: intent.environmentId,
          threadId: intent.threadId,
          cause,
        });
      }
      if (currentIntents()[key]?.commandId !== intent.commandId) return null;
      setIntents({ ...currentIntents(), [key]: attempted });
      return attempted;
    });

  /**
   * Gives the current revision a never-used command id, so a different action
   * (or a retry after a rejection) is not answered by the old id's receipt.
   * The revision stays attempted: its earlier command may have run.
   */
  const rotateCommandId = (
    intent: ThreadLifecycleIntent,
    commandId: CommandId,
  ): Promise<ThreadLifecycleIntent | null> =>
    serialize(async () => {
      const key = threadLifecycleIntentKey(intent.environmentId, intent.threadId);
      const current = currentIntents()[key];
      if (current?.commandId !== intent.commandId) return null;
      const rotated: ThreadLifecycleIntent = {
        ...current,
        commandId,
        requiresDispatch: true,
        dispatchAttempted: true,
        dispatchedAction: null,
      };
      try {
        await options.storage.write(rotated);
      } catch (cause) {
        throw new ThreadLifecycleOutboxManagerError({
          operation: "rotate-command-id",
          environmentId: intent.environmentId,
          threadId: intent.threadId,
          cause,
        });
      }
      if (currentIntents()[key]?.commandId !== intent.commandId) return null;
      setIntents({ ...currentIntents(), [key]: rotated });
      return rotated;
    });

  const removeIfCurrent = (intent: ThreadLifecycleIntent): Promise<boolean> =>
    serialize(async () => {
      const key = threadLifecycleIntentKey(intent.environmentId, intent.threadId);
      const current = currentIntents()[key];
      if (current?.commandId !== intent.commandId) return false;

      const next = { ...currentIntents() };
      delete next[key];
      setIntents(next);
      try {
        await options.storage.remove(current);
      } catch (cause) {
        if (currentIntents()[key] === undefined) {
          setIntents({ ...currentIntents(), [key]: current });
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
      const removedCommandIdsByKey = new Map<string, ThreadLifecycleIntent["commandId"]>();
      await Promise.all(
        Object.entries(all)
          .filter(([, intent]) => intent.environmentId === environmentId)
          .map(async ([key, intent]) => {
            try {
              await options.storage.remove(intent);
              removedCommandIdsByKey.set(key, intent.commandId);
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
      const next = Object.fromEntries(
        Object.entries(all).filter(
          ([key, intent]) => removedCommandIdsByKey.get(key) !== intent.commandId,
        ),
      );
      for (const [key, current] of Object.entries(currentIntents())) {
        if (removedCommandIdsByKey.get(key) !== current.commandId) next[key] = current;
      }
      setIntents(next);
    });

  return {
    intentsByThreadKeyAtom,
    loadStateAtom,
    serialize,
    load,
    enqueue,
    confirmCurrent,
    markDispatchAttempted,
    rotateCommandId,
    removeIfCurrent,
    clearEnvironment,
  };
}
