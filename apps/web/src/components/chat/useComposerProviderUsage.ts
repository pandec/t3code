import { resolveProviderUsageMeter } from "@t3tools/client-runtime/state/provider-usage-meter";
import {
  shouldProbeProviderUsageThreadAccount,
  type ProviderUsageThreadAccountProbe,
  type ProviderUsageThreadAccountState,
} from "@t3tools/client-runtime/state/provider-usage-presentation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderUsageRefreshResult,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
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

function reportProviderUsageRefreshFailure(failure: AtomCommandResult<unknown, unknown>): void {
  if (failure._tag !== "Failure" || isAtomCommandInterrupted(failure)) return;
  const error = squashAtomCommandFailure(failure);
  toastManager.add({
    type: "error",
    title: "Could not refresh provider usage",
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

/**
 * The gateway refresh succeeds even when its probe failed; without this the
 * button would silently do nothing. Absent `refreshedInstanceIds` means a
 * server that cannot tell, which stays quiet.
 */
function warnIfGatewayUsageNotRefreshed(
  instanceId: ProviderInstanceId,
  result: ProviderUsageRefreshResult,
): void {
  const { refreshedInstanceIds, failures } = result;
  if (refreshedInstanceIds === undefined || refreshedInstanceIds.includes(instanceId)) return;
  // Prefer the server's own words: "check the account is signed in" points a
  // rejected management key at the wrong remedy.
  const reasons = [
    ...new Set(
      (failures ?? [])
        .filter((failure) => failure.instanceId === instanceId)
        .map((failure) => failure.reason),
    ),
  ];
  toastManager.add({
    type: "warning",
    title: "No new usage data",
    description:
      reasons.length > 0
        ? reasons.join(" ")
        : "The provider did not return usage for any account. Check the account is still signed in.",
  });
}

/**
 * Quota rings for the composer meter: the thread's account, its same-driver
 * siblings or gateway pool, the Fable ring, and the opt-in OpenRouter balance.
 */
export function useComposerProviderUsage(input: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly activeInstanceId: ProviderInstanceId | null;
  readonly activeModel: string;
  readonly threadId: ThreadId | undefined;
  /** The thread has a provider session, so a gateway binding may exist. */
  readonly hasProviderSession: boolean;
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
  // The pooled account the thread's session is bound to, read from the gateway
  // when the usage popover opens. Kept with the thread and model it was probed
  // for, so an answer landing after a switch cannot mislabel the new context,
  // and with the instance, whose pool its auth index belongs to.
  const [threadAccount, setThreadAccount] = useState<{
    readonly instanceId: ProviderInstanceId;
    readonly account: ProviderUsageThreadAccountState;
  } | null>(null);
  const meter = useMemo(
    () =>
      resolveProviderUsageMeter({
        providers: input.providers,
        snapshots: snapshots ?? [],
        activeInstanceId: input.activeInstanceId,
        activeModel: input.activeModel,
        isGatewayInstance,
        threadId: input.threadId,
        threadAccount:
          threadAccount !== null && threadAccount.instanceId === input.activeInstanceId
            ? threadAccount.account
            : null,
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
      threadAccount,
    ],
  );

  const readThreadAccount = useAtomCommand(serverEnvironment.readProviderUsageThreadAccount, {
    // Best-effort marker: a failed probe just leaves the badge off.
    reportFailure: false,
  });
  const lastThreadAccountProbeRef = useRef<ProviderUsageThreadAccountProbe>({
    key: "",
    askedAtMs: 0,
  });
  const activeDriver =
    input.providers.find((provider) => provider.instanceId === input.activeInstanceId)?.driver ??
    null;
  // Only a Claude session on a gateway-backed instance has a binding the
  // server can read. Throttles itself; `force` (the refresh button) outranks
  // the cadence cap but not the spam floor.
  const probeThreadAccount = useCallback(
    (options?: { readonly force?: boolean }) => {
      const threadId = input.threadId;
      if (
        threadId === undefined ||
        !input.hasProviderSession ||
        !meter.gateway ||
        activeDriver !== "claudeAgent"
      ) {
        return;
      }
      const model = input.activeModel;
      const instanceId = input.activeInstanceId;
      if (instanceId === null) return;
      const probeKey = `${environmentId}:${instanceId}:${threadId}:${model}`;
      const nowMs = Date.now();
      if (
        !shouldProbeProviderUsageThreadAccount(
          lastThreadAccountProbeRef.current,
          probeKey,
          nowMs,
          options?.force === true,
        )
      ) {
        return;
      }
      lastThreadAccountProbeRef.current = { key: probeKey, askedAtMs: nowMs };
      void (async () => {
        const result = await readThreadAccount({ environmentId, input: { threadId, model } });
        if (result._tag === "Failure") return;
        // A newer thread or model claimed the slot while this probe was in
        // flight; its answer must not be evicted by this stale one.
        if (lastThreadAccountProbeRef.current.key !== probeKey) return;
        const authIndex = result.value.authIndex;
        setThreadAccount(
          authIndex === null ? null : { instanceId, account: { threadId, model, authIndex } },
        );
      })();
    },
    [
      activeDriver,
      environmentId,
      input.activeInstanceId,
      input.activeModel,
      input.hasProviderSession,
      input.threadId,
      meter.gateway,
      readThreadAccount,
    ],
  );

  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    // Failures are reported with a user-visible toast below.
    reportFailure: false,
  });
  const refreshGatewayUsage = useAtomCommand(serverEnvironment.refreshProviderUsage, {
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
  // A gateway meter lists only the active instance's pool.
  const gatewayInstanceId = meter.gateway ? input.activeInstanceId : null;
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
      // A gateway pool is probed on demand through the gateway; direct
      // accounts re-probe through their provider snapshot.
      if (gatewayInstanceId !== null) {
        const result = await refreshGatewayUsage({
          environmentId,
          input: { instanceIds: [gatewayInstanceId] },
        });
        if (refreshTokenRef.current !== token) return;
        refreshProviderUsageSnapshots();
        if (result._tag === "Failure") {
          reportProviderUsageRefreshFailure(result);
          return;
        }
        warnIfGatewayUsageNotRefreshed(gatewayInstanceId, result.value);
        return;
      }
      const results = await Promise.all(
        directInstanceIds.map((instanceId) =>
          refreshProviders({ environmentId, input: { instanceId } }),
        ),
      );
      if (refreshTokenRef.current !== token) return;
      refreshProviderUsageSnapshots();
      const failure = results.find((result) => result._tag === "Failure");
      if (failure !== undefined && failure._tag === "Failure") {
        reportProviderUsageRefreshFailure(failure);
      }
    } finally {
      if (refreshTokenRef.current === token) setRefreshingEnvironmentId(null);
    }
  }, [
    directInstanceIds,
    environmentId,
    gatewayInstanceId,
    refreshGatewayUsage,
    refreshProviderUsageSnapshots,
    refreshProviders,
  ]);

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
    probeThreadAccount,
    // Fail closed while client settings hydrate: they start at defaults
    // (masking off), which would flash a masked address in full.
    settingsHydrated,
    openRouterCredits,
    refreshOpenRouterCredits: openRouterCreditsQuery.refresh,
    openRouterCreditsRefreshing: openRouterCreditsQuery.isPending,
  };
}
