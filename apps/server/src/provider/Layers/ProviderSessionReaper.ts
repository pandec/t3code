import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PENDING_EXTENSION_MS = 24 * 60 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  readonly maxPendingExtensionMs?: number;
}

export const providerSessionReaperOptionsFromConfig = (
  config: Pick<
    ServerConfig["Service"],
    | "providerSessionReaperInactivityThresholdMs"
    | "providerSessionReaperSweepIntervalMs"
    | "providerSessionReaperMaxPendingExtensionMs"
  >,
): ProviderSessionReaperLiveOptions => ({
  inactivityThresholdMs: config.providerSessionReaperInactivityThresholdMs,
  sweepIntervalMs: config.providerSessionReaperSweepIntervalMs,
  maxPendingExtensionMs: config.providerSessionReaperMaxPendingExtensionMs,
});

function bindingHasPendingWork(runtimePayload: unknown | null | undefined): boolean {
  return (
    runtimePayload !== null &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload) &&
    "hasPendingWork" in runtimePayload &&
    runtimePayload.hasPendingWork === true
  );
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const maxPendingExtensionMs = Math.max(
      1,
      options?.maxPendingExtensionMs ?? DEFAULT_MAX_PENDING_EXTENSION_MS,
    );

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        // The projection lookup yields, so a turn completion or replacement may
        // have refreshed the binding after the sweep snapshot was captured.
        // Re-read before stopping and evaluate only the same current owner.
        const currentBinding = Option.getOrUndefined(yield* directory.getBinding(binding.threadId));
        if (
          !currentBinding ||
          currentBinding.status === "stopped" ||
          currentBinding.provider !== binding.provider ||
          currentBinding.providerInstanceId !== binding.providerInstanceId
        ) {
          continue;
        }

        const currentLastSeenMs = Date.parse(currentBinding.lastSeenAt);
        if (Number.isNaN(currentLastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: currentBinding.threadId,
            provider: currentBinding.provider,
            lastSeenAt: currentBinding.lastSeenAt,
          });
          continue;
        }

        const currentIdleDurationMs = now - currentLastSeenMs;
        if (currentIdleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const hasPendingWork = bindingHasPendingWork(currentBinding.runtimePayload);
        if (hasPendingWork && currentIdleDurationMs < maxPendingExtensionMs) {
          yield* Effect.logDebug("provider.session.reaper.skipped-pending-work", {
            threadId: currentBinding.threadId,
            provider: currentBinding.provider,
            idleDurationMs: currentIdleDurationMs,
            maxPendingExtensionMs,
          });
          continue;
        }

        const reason = hasPendingWork ? "pending_work_expired" : "inactivity_threshold";

        const reaped = yield* providerService
          .stopSession({ threadId: currentBinding.threadId })
          .pipe(
            Effect.tap(() =>
              Effect.logInfo("provider.session.reaped", {
                threadId: currentBinding.threadId,
                provider: currentBinding.provider,
                idleDurationMs: currentIdleDurationMs,
                reason,
              }),
            ),
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.reaper.stop-failed", {
                threadId: currentBinding.threadId,
                provider: currentBinding.provider,
                idleDurationMs: currentIdleDurationMs,
                cause,
              }).pipe(Effect.as(false)),
            ),
          );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
          maxPendingExtensionMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = Layer.unwrap(
  Effect.map(ServerConfig, (config) =>
    makeProviderSessionReaperLive(providerSessionReaperOptionsFromConfig(config)),
  ),
);
