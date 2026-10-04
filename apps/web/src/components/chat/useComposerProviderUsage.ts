import { resolveProviderUsageMeter } from "@t3tools/client-runtime/state/provider-usage-meter";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettingsHydrated, useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import type { OpenRouterCreditsDisplay } from "./ContextWindowMeter";

/** Minimum gap between quota refreshes; a refresh can probe every listed account. */
const PROVIDER_USAGE_REFRESH_DEBOUNCE_MS = 5_000;

/**
 * Quota rings for the composer meter: the thread's account, its same-driver
 * siblings or gateway pool, the Fable ring, and the opt-in OpenRouter balance.
 */
export function useComposerProviderUsage(input: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly activeInstanceId: ProviderInstanceId | null;
  readonly activeModel: string;
  readonly threadId: string | undefined;
  readonly showOpenRouterCredits: boolean;
  readonly openRouterCreditsBudgetUsd: number | null;
}) {
  const { environmentId } = input;
  const settingsHydrated = useClientSettingsHydrated();
  const providerUsageQuery = useEnvironmentQuery(
    serverEnvironment.providerUsage({ environmentId, input: {} }),
  );
  // The settings envelope's `usageSource` marks gateway-backed instances even
  // before their first pool snapshot arrives.
  const providerInstanceSettings = useEnvironmentSettings(
    environmentId,
    (settings) => settings.providerInstances,
  );
  const isGatewayInstance = useCallback(
    (instanceId: ProviderInstanceId) =>
      providerInstanceSettings[instanceId]?.usageSource !== undefined,
    [providerInstanceSettings],
  );
  const nowMinute = useNowMinute();
  const snapshots = providerUsageQuery.data?.snapshots;
  const meter = useMemo(
    () =>
      resolveProviderUsageMeter({
        providers: input.providers,
        snapshots: snapshots ?? [],
        activeInstanceId: input.activeInstanceId,
        activeModel: input.activeModel,
        isGatewayInstance,
        threadId: input.threadId,
        // No thread-account probe yet; see `providerUsage.threadAccount`.
        threadAccount: null,
        // The minute clock re-evaluates staleness and passed resets.
        now: Date.parse(`${nowMinute}:00.000Z`),
      }),
    [
      input.activeInstanceId,
      input.activeModel,
      input.providers,
      input.threadId,
      isGatewayInstance,
      nowMinute,
      snapshots,
    ],
  );

  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    // Failures are reported with a user-visible toast below.
    reportFailure: false,
  });
  // Pending state and the debounce are per environment: the composer outlives
  // an environment switch, and the previous environment's refresh must neither
  // show as pending nor hold off a refresh here.
  const [refreshingEnvironmentId, setRefreshingEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const lastRefreshRef = useRef<{ readonly environmentId: EnvironmentId; readonly atMs: number }>(
    null,
  );
  // Identifies the in-flight refresh, so an older one finishing late cannot
  // clear a newer one's pending state.
  const refreshTokenRef = useRef(0);
  useEffect(
    // Unmount invalidates any in-flight token so its completion is a no-op.
    () => () => {
      refreshTokenRef.current += 1;
    },
    [],
  );
  const refreshProviderUsageSnapshots = providerUsageQuery.refresh;
  const directInstanceIds = meter.directInstanceIds;
  const refresh = useCallback(async () => {
    const refreshAt = Date.now();
    const lastRefreshAt =
      lastRefreshRef.current?.environmentId === environmentId ? lastRefreshRef.current.atMs : 0;
    if (refreshAt - lastRefreshAt < PROVIDER_USAGE_REFRESH_DEBOUNCE_MS) return;
    lastRefreshRef.current = { environmentId, atMs: refreshAt };
    refreshTokenRef.current += 1;
    const token = refreshTokenRef.current;
    setRefreshingEnvironmentId(environmentId);
    try {
      // Direct accounts re-probe through their provider snapshot. Gateway
      // pools are not probed yet: on-demand gateway probing is pending the
      // `providerUsage.refresh` RPC, so they only re-read the latest pool snapshot.
      const results = await Promise.all(
        directInstanceIds.map((instanceId) =>
          refreshProviders({ environmentId, input: { instanceId } }),
        ),
      );
      if (refreshTokenRef.current !== token) return;
      refreshProviderUsageSnapshots();
      const failure = results.find(
        (result) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
      );
      if (failure !== undefined && failure._tag === "Failure") {
        const error = squashAtomCommandFailure(failure);
        toastManager.add({
          type: "error",
          title: "Could not refresh provider usage",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    } finally {
      if (refreshTokenRef.current === token) setRefreshingEnvironmentId(null);
    }
  }, [directInstanceIds, environmentId, refreshProviderUsageSnapshots, refreshProviders]);

  // The OpenRouter balance is opt-in (Settings → Extras); while it is off no
  // query subscribes, so nothing is fetched.
  const showOpenRouterCredits = settingsHydrated && input.showOpenRouterCredits;
  const openRouterCreditsQuery = useEnvironmentQuery(
    showOpenRouterCredits
      ? serverEnvironment.openRouterCredits({ environmentId, input: {} })
      : null,
  );
  const openRouterCreditsData = openRouterCreditsQuery.data;
  const openRouterCreditsUnavailable = openRouterCreditsQuery.error !== null;
  const openRouterCredits = useMemo<OpenRouterCreditsDisplay | null>(() => {
    if (!showOpenRouterCredits || openRouterCreditsData === null) return null;
    return {
      configured: openRouterCreditsData.configured,
      balanceUsd:
        openRouterCreditsData.snapshot === null
          ? null
          : openRouterCreditsData.snapshot.totalCreditsUsd -
            openRouterCreditsData.snapshot.totalUsageUsd,
      budgetUsd: input.openRouterCreditsBudgetUsd,
      observedAt: openRouterCreditsData.snapshot?.observedAt ?? null,
      error: openRouterCreditsData.error ?? null,
      // A failed refresh keeps the previous success, so the transport error
      // travels with it rather than presenting an old balance as current.
      unavailable: openRouterCreditsUnavailable,
    };
  }, [
    input.openRouterCreditsBudgetUsd,
    openRouterCreditsData,
    openRouterCreditsUnavailable,
    showOpenRouterCredits,
  ]);

  return {
    meter,
    refreshing: refreshingEnvironmentId === environmentId,
    unavailable: providerUsageQuery.error !== null,
    refresh,
    // Fail closed while client settings hydrate: they start at defaults
    // (masking off), which would flash a masked address in full.
    settingsHydrated,
    openRouterCredits,
    refreshOpenRouterCredits: openRouterCreditsQuery.refresh,
    openRouterCreditsRefreshing: openRouterCreditsQuery.isPending,
  };
}
