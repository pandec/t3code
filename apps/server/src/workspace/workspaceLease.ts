import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

/** Existing aliases must share the same removal/startup lock. */
export const canonicalWorkspacePath = Effect.fn("canonicalWorkspacePath")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
});

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

/** Coordinates checkout removal and startup across threads using the same resolved cwd. */
export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path> =>
  canonicalWorkspacePath(cwd).pipe(
    Effect.flatMap((key) =>
      Effect.suspend(() => {
        const lease = leases.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        leases.set(key, lease);
        lease.users++;
        return lease.semaphore.withPermit(effect).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              lease.users--;
              if (lease.users === 0) leases.delete(key);
            }),
          ),
        );
      }),
    ),
  );
