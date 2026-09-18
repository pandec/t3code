import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

/** Existing aliases must share the same removal/startup lock. */
export const canonicalWorkspacePath = Effect.fn("canonicalWorkspacePath")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let candidate = path.resolve(cwd);
  const missing: string[] = [];
  // Bootstrap paths can be absent below a symlinked parent, including /var on macOS.
  while (true) {
    const resolved = yield* fs.realPath(candidate).pipe(Effect.orElseSucceed(() => null));
    if (resolved !== null) return path.join(resolved, ...missing);
    const parent = path.dirname(candidate);
    if (parent === candidate) return path.resolve(cwd);
    missing.unshift(path.basename(candidate));
    candidate = parent;
  }
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

// Claims cover command persistence, independently of the startup lease: a
// switch reactor can hold that lease while waiting for its engine command.
const reservations = new Map<string, { claims: number; removing: boolean }>();

/** Return false on conflict; successful reservations last until the current scope closes. */
export const reserveWorkspace = Effect.fn("reserveWorkspace")(function* (
  cwd: string,
  kind: "claim" | "removal",
) {
  const key = yield* canonicalWorkspacePath(cwd);
  const path = yield* Path.Path;
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  return yield* Effect.acquireRelease(
    Effect.sync(() => {
      for (const [other, reservation] of reservations) {
        if (
          (kind === "removal" || reservation.removing) &&
          (contains(key, other) || contains(other, key))
        )
          return false;
      }
      const reservation = reservations.get(key) ?? { claims: 0, removing: false };
      if (kind === "claim") reservation.claims++;
      else reservation.removing = true;
      reservations.set(key, reservation);
      return true;
    }),
    (acquired) =>
      Effect.sync(() => {
        if (!acquired) return;
        const reservation = reservations.get(key)!;
        if (kind === "claim") reservation.claims--;
        else reservation.removing = false;
        if (reservation.claims === 0 && !reservation.removing) reservations.delete(key);
      }),
  );
});
