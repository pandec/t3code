import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

interface MessageArtifactLockEntry {
  readonly lock: Semaphore.Semaphore;
  readonly users: number;
}

export const makeMessageArtifactLockCoordinator = Effect.fn("MessageArtifacts.makeLockCoordinator")(
  function* () {
    const locksRef = yield* Ref.make<ReadonlyMap<string, MessageArtifactLockEntry>>(new Map());

    const acquire = Effect.fn("MessageArtifacts.acquireLock")(function* (messageId: string) {
      const created = yield* Semaphore.make(1);
      return yield* Ref.modify(locksRef, (locks) => {
        const existing = locks.get(messageId);
        const lock = existing?.lock ?? created;
        const next = new Map(locks);
        next.set(messageId, { lock, users: (existing?.users ?? 0) + 1 });
        return [lock, next] as const;
      });
    });

    const release = (messageId: string, lock: Semaphore.Semaphore) =>
      Ref.update(locksRef, (locks) => {
        const current = locks.get(messageId);
        if (!current || current.lock !== lock) return locks;
        const next = new Map(locks);
        if (current.users <= 1) next.delete(messageId);
        else next.set(messageId, { lock, users: current.users - 1 });
        return next;
      });

    return {
      withMessageLock: <A, E, R>(messageId: string, effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          acquire(messageId),
          (lock) => lock.withPermit(effect),
          (lock) => release(messageId, lock),
        ),
      activeLockCount: Ref.get(locksRef).pipe(Effect.map((locks) => locks.size)),
    };
  },
);
