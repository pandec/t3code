import { useAtomValue } from "@effect/atom-react";
import type { ConnectionTargetKind } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Network from "expo-network";
import * as Updates from "expo-updates";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";

import { environmentCatalog } from "../connection/catalog";
import { useEnvironmentConnectionState } from "../state/environments";
import { connectionDiagnosticDetails } from "./events";
import { flushHeaderDiagnosticMetrics } from "./headerMetrics";
import {
  flushMobileDiagnostics,
  mobileDiagnosticsEnabled,
  recordMobileDiagnostic,
} from "./journal";
import {
  eventLoopStallBucket,
  eventLoopStallDuration,
  MOBILE_DIAGNOSTIC_STALL_DURABLE_MS,
  MOBILE_DIAGNOSTIC_STALL_INTERVAL_MS,
  MOBILE_DIAGNOSTIC_STALL_THRESHOLD_MS,
} from "./stallProbe";

const FLUSH_INTERVAL_MS = 30_000;

function recordNetworkState(state: Network.NetworkState): void {
  recordMobileDiagnostic("network", {
    type: state.type ?? "UNKNOWN",
    connected: state.isConnected ?? null,
    internetReachable: state.isInternetReachable ?? null,
  });
}

function EnvironmentConnectionDiagnostics(props: {
  readonly environmentId: EnvironmentId;
  readonly targetKind: ConnectionTargetKind;
}) {
  const connection = useEnvironmentConnectionState(props.environmentId).data;

  useEffect(() => {
    if (!connection) return;
    recordMobileDiagnostic(
      "connection",
      connectionDiagnosticDetails(props.environmentId, props.targetKind, connection, Date.now()),
    );
  }, [connection, props.environmentId, props.targetKind]);

  return null;
}

function EnabledMobileDiagnosticsCoordinator() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const runtimeNetworkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);

  useEffect(() => {
    if (!mobileDiagnosticsEnabled) return;

    recordMobileDiagnostic("meta", {
      schema: 2,
      appVersion: Constants.expoConfig?.version ?? null,
      nativeBuild: Constants.platform?.ios?.buildNumber ?? null,
      appVariant:
        typeof Constants.expoConfig?.extra?.appVariant === "string"
          ? Constants.expoConfig.extra.appVariant
          : null,
      commit: process.env.EXPO_PUBLIC_MOBILE_DIAGNOSTIC_COMMIT ?? null,
      updateId: Updates.updateId ?? null,
      runtimeVersion: Updates.runtimeVersion ?? null,
      channel: Updates.channel ?? null,
      embedded: Updates.isEmbeddedLaunch,
      platform: Platform.OS,
      osVersion: String(Platform.Version),
      sessionId: Constants.sessionId,
    });

    let currentAppState = AppState.currentState;
    let expectedStallProbeAt =
      (globalThis.performance?.now?.() ?? Date.now()) + MOBILE_DIAGNOSTIC_STALL_INTERVAL_MS;
    recordMobileDiagnostic("app", { state: currentAppState });
    void Network.getNetworkStateAsync().then(recordNetworkState, () => undefined);

    const appStateSubscription = AppState.addEventListener("change", (state) => {
      currentAppState = state;
      expectedStallProbeAt =
        (globalThis.performance?.now?.() ?? Date.now()) + MOBILE_DIAGNOSTIC_STALL_INTERVAL_MS;
      recordMobileDiagnostic("app", { state });
      if (state !== "active") {
        flushHeaderDiagnosticMetrics();
        void flushMobileDiagnostics();
      }
    });
    const memoryWarningSubscription = AppState.addEventListener("memoryWarning", () => {
      recordMobileDiagnostic("memory-warning");
      flushHeaderDiagnosticMetrics();
      void flushMobileDiagnostics();
    });
    const networkSubscription = Network.addNetworkStateListener(recordNetworkState);

    const stallTimer = setInterval(() => {
      const observedAt = globalThis.performance?.now?.() ?? Date.now();
      const durationMs = eventLoopStallDuration(expectedStallProbeAt, observedAt);
      expectedStallProbeAt = observedAt + MOBILE_DIAGNOSTIC_STALL_INTERVAL_MS;
      if (currentAppState === "active" && durationMs >= MOBILE_DIAGNOSTIC_STALL_THRESHOLD_MS) {
        recordMobileDiagnostic("js-stall", {
          durationMs: Number(durationMs.toFixed(1)),
          bucket: eventLoopStallBucket(durationMs),
        });
        // The stall has already ended by the time the late timer runs, so this
        // appends after the blockage rather than extending it.
        if (durationMs >= MOBILE_DIAGNOSTIC_STALL_DURABLE_MS) void flushMobileDiagnostics();
      }
    }, MOBILE_DIAGNOSTIC_STALL_INTERVAL_MS);

    const flushTimer = setInterval(() => {
      flushHeaderDiagnosticMetrics();
      void flushMobileDiagnostics();
    }, FLUSH_INTERVAL_MS);

    void flushMobileDiagnostics();
    return () => {
      appStateSubscription.remove();
      memoryWarningSubscription.remove();
      networkSubscription.remove();
      clearInterval(stallTimer);
      clearInterval(flushTimer);
      flushHeaderDiagnosticMetrics();
      void flushMobileDiagnostics();
    };
  }, []);

  useEffect(() => {
    if (mobileDiagnosticsEnabled) {
      recordMobileDiagnostic("runtime-network", { status: runtimeNetworkStatus });
    }
  }, [runtimeNetworkStatus]);

  return [...catalog.entries.values()].map((entry) => (
    <EnvironmentConnectionDiagnostics
      environmentId={entry.target.environmentId}
      key={entry.target.environmentId}
      targetKind={entry.target._tag}
    />
  ));
}

export function MobileDiagnosticsCoordinator() {
  return mobileDiagnosticsEnabled ? <EnabledMobileDiagnosticsCoordinator /> : null;
}
