import type { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

// Fork (DECISIONS 5.8): SessionWorkspaceFollow.ts consumes these observations.

export interface ProviderSessionCwdObservation {
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  /** Tells this process apart from a later one that reuses the session id. */
  readonly providerSessionCreatedAt: DateTime.Utc;
  /** The directory the live session now runs in, as the provider reported it. */
  readonly cwd: string;
}

/**
 * Adapters offer an observation when a live session changes its own working
 * directory. The default reference drops them, keeping adapter construction
 * dependency-free in tests; the live layer must be the same layer reference the
 * runtime provides to `workerLive` so they share one queue.
 */
export class ProviderSessionCwdObservations extends Context.Reference<{
  readonly offer: (observation: ProviderSessionCwdObservation) => Effect.Effect<void>;
  readonly take: Effect.Effect<ProviderSessionCwdObservation>;
}>("t3/orchestration-v2/SessionWorkspaceFollow/ProviderSessionCwdObservations", {
  defaultValue: () => ({ offer: () => Effect.void, take: Effect.never }),
}) {}

export const layer = Layer.effect(
  ProviderSessionCwdObservations,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderSessionCwdObservation>();
    return {
      offer: (observation: ProviderSessionCwdObservation) =>
        Queue.offer(queue, observation).pipe(Effect.asVoid),
      take: Queue.take(queue),
    };
  }),
);
