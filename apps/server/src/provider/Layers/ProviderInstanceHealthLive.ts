import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  ProviderInstanceHealth,
  type ProviderInstanceHealthShape,
  type ProviderInstanceUsageSnapshot,
  type UsageObservationToken,
  type UsageSourceKind,
} from "../Services/ProviderInstanceHealth.ts";

const makeProviderInstanceHealth = Effect.gen(function* () {
  const nextUsageObservationToken = yield* Ref.make(0);
  const initialUsageObservationToken = 0 as UsageObservationToken;
  // One entry per instance holds both the active source and the whole-payload
  // LWW tombstone. A source transition (kind or key) drops the snapshot but
  // retains its token, so an older observation from a source that later
  // returns cannot replay; reports from any other source are rejected.
  const usageSnapshots = yield* Ref.make<
    ReadonlyMap<
      ProviderInstanceId,
      {
        readonly activeSourceKind: UsageSourceKind;
        readonly activeSourceKey: string;
        readonly sourceObservationToken: UsageObservationToken;
        readonly snapshot: ProviderInstanceUsageSnapshot | undefined;
        readonly snapshotObservationToken: UsageObservationToken;
      }
    >
  >(new Map());

  const beginUsageObservation: ProviderInstanceHealthShape["beginUsageObservation"] = () =>
    Ref.updateAndGet(nextUsageObservationToken, (current) => current + 1).pipe(
      Effect.map((token) => token as UsageObservationToken),
    );

  const setUsageSource: ProviderInstanceHealthShape["setUsageSource"] = Effect.fn(
    "ProviderInstanceHealth.setUsageSource",
  )(function* (instanceId, sourceKind, observationToken, sourceKey: string = sourceKind) {
    yield* Ref.update(usageSnapshots, (snapshots) => {
      const current = snapshots.get(instanceId);
      if (current !== undefined && current.sourceObservationToken >= observationToken) {
        return snapshots;
      }
      const activeSourceKind = current?.activeSourceKind ?? "driver";
      const activeSourceKey = current?.activeSourceKey ?? activeSourceKind;
      return new Map(snapshots).set(instanceId, {
        activeSourceKind: sourceKind,
        activeSourceKey: sourceKey,
        sourceObservationToken: observationToken,
        snapshot:
          activeSourceKind === sourceKind && activeSourceKey === sourceKey
            ? current?.snapshot
            : undefined,
        snapshotObservationToken: current?.snapshotObservationToken ?? initialUsageObservationToken,
      });
    });
  });

  const reportUsageSnapshot: ProviderInstanceHealthShape["reportUsageSnapshot"] = Effect.fn(
    "ProviderInstanceHealth.reportUsageSnapshot",
  )(function* (
    instanceId,
    payload,
    observedAt,
    observationToken,
    sourceKind,
    sourceKey: string = sourceKind,
  ) {
    return yield* Ref.modify(usageSnapshots, (snapshots) => {
      const current = snapshots.get(instanceId);
      const activeSourceKind = current?.activeSourceKind ?? "driver";
      const activeSourceKey = current?.activeSourceKey ?? activeSourceKind;
      const snapshotObservationToken =
        current?.snapshotObservationToken ?? initialUsageObservationToken;
      if (
        activeSourceKind !== sourceKind ||
        activeSourceKey !== sourceKey ||
        snapshotObservationToken >= observationToken
      ) {
        return [false, snapshots] as const;
      }
      return [
        true,
        new Map(snapshots).set(instanceId, {
          activeSourceKind,
          activeSourceKey,
          sourceObservationToken: current?.sourceObservationToken ?? initialUsageObservationToken,
          snapshot: {
            instanceId,
            payload,
            observedAt,
          },
          snapshotObservationToken: observationToken,
        }),
      ] as const;
    });
  });

  const listUsageSnapshots: ProviderInstanceHealthShape["listUsageSnapshots"] = () =>
    Ref.get(usageSnapshots).pipe(
      Effect.map((snapshots) =>
        Array.from(snapshots.values(), ({ snapshot }) => snapshot).filter(
          (snapshot) => snapshot !== undefined,
        ),
      ),
    );

  return {
    beginUsageObservation,
    setUsageSource,
    reportUsageSnapshot,
    listUsageSnapshots,
  } satisfies ProviderInstanceHealthShape;
});

export const ProviderInstanceHealthLive = Layer.effect(
  ProviderInstanceHealth,
  makeProviderInstanceHealth,
);

// Exposed for tests that assemble the service without the layer graph.
export { makeProviderInstanceHealth };
