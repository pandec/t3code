import type { EnvironmentId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import type { EnvironmentCacheStore } from "./persistence.ts";

const cacheMutationLocks = new WeakMap<
  EnvironmentCacheStore["Service"],
  Map<EnvironmentId, Semaphore.Semaphore>
>();

/**
 * Serializes cache mutation for one environment across state-stream finalizers
 * and registry removal. The cache service is the shared identity between those
 * otherwise independent scopes.
 */
export function withEnvironmentCacheMutationLock<A, E, R>(
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  let environmentLocks = cacheMutationLocks.get(cache);
  if (environmentLocks === undefined) {
    environmentLocks = new Map();
    cacheMutationLocks.set(cache, environmentLocks);
  }
  let lock = environmentLocks.get(environmentId);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    environmentLocks.set(environmentId, lock);
  }
  return lock.withPermits(1)(effect);
}
