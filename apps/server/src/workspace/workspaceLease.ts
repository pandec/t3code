import * as Deferred from "effect/Deferred";
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
const workspaceReservations = new Map<string, { claims: number; removing: boolean }>();

/** Return false on conflict; successful reservations last until the current scope closes. */
export const reserveWorkspace = Effect.fn("reserveWorkspace")(function* (
  cwd: string,
  kind: "claim" | "removal",
) {
  const key = yield* canonicalWorkspacePath(cwd);
  const path = yield* Path.Path;
  return yield* Effect.acquireRelease(
    Effect.sync(() => {
      for (const [other, reservation] of workspaceReservations) {
        if (
          (kind === "removal" || reservation.removing) &&
          (contains(path, key, other) || contains(path, other, key))
        )
          return false;
      }
      const reservation = workspaceReservations.get(key) ?? { claims: 0, removing: false };
      if (kind === "claim") reservation.claims++;
      else reservation.removing = true;
      workspaceReservations.set(key, reservation);
      return true;
    }),
    (acquired) =>
      Effect.sync(() => {
        if (!acquired) return;
        const reservation = workspaceReservations.get(key)!;
        if (kind === "claim") reservation.claims--;
        else reservation.removing = false;
        if (reservation.claims === 0 && !reservation.removing) workspaceReservations.delete(key);
      }),
  );
});

// A restore rewrites files under its directory, so it must exclude provider
// startup in any overlapping workspace: symlink aliases, parents, and children.
// Kept apart from withWorkspaceLease because that lease is non-reentrant and
// restores call Git work that leases the project root.
interface Reservation {
  readonly cwd: string;
  readonly kind: "restore" | "turn-start";
}

const reservations = new Set<Reservation>();
let reservationReleased = Deferred.makeUnsafe<void>();

// path.relative folds win32 drive-letter case and treats a POSIX backslash as
// part of a name, unlike a raw prefix check.
const contains = (path: Path.Path, parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

const conflicts = (path: Path.Path, a: Reservation, b: Reservation) =>
  (a.kind === "restore" || b.kind === "restore") &&
  (contains(path, a.cwd, b.cwd) || contains(path, b.cwd, a.cwd));

const reserve = (path: Path.Path, reservation: Reservation): Effect.Effect<void> =>
  Effect.suspend(() => {
    for (const held of reservations) {
      if (conflicts(path, held, reservation)) {
        return Deferred.await(reservationReleased).pipe(Effect.andThen(reserve(path, reservation)));
      }
    }
    reservations.add(reservation);
    return Effect.void;
  });

const release = (reservation: Reservation) =>
  Effect.sync(() => {
    if (!reservations.delete(reservation)) return;
    const released = reservationReleased;
    reservationReleased = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(released, Effect.void);
  });

// A worktree removed by storage cleanup is recreated inside the reserved
// section, so resolve its nearest existing ancestor: a symlink alias above it
// must still canonicalize the same on both sides. Walks at most the path depth.
const canonicalize = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
): Effect.Effect<string> =>
  fileSystem.realPath(target).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => {
      const parent = path.dirname(target);
      return parent === target
        ? Effect.succeed(target)
        : canonicalize(fileSystem, path, parent).pipe(
            Effect.map((resolved) => path.join(resolved, path.basename(target))),
          );
    }),
    Effect.orElseSucceed(() => target),
  );

const withReservation =
  (kind: Reservation["kind"]) =>
  <A, E, R>(
    fileSystem: FileSystem.FileSystem,
    path: Path.Path,
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    canonicalize(fileSystem, path, cwd).pipe(
      Effect.flatMap((canonical) => {
        const reservation: Reservation = { cwd: canonical, kind };
        return reserve(path, reservation).pipe(
          Effect.andThen(effect),
          Effect.ensuring(release(reservation)),
        );
      }),
    );

/** Exclusive over every overlapping workspace while checkpoint files are restored. */
export const withCheckpointRestoreReservation = withReservation("restore");

/** Waits out overlapping restores; turn startups never wait on each other. */
export const withTurnStartReservation = withReservation("turn-start");
