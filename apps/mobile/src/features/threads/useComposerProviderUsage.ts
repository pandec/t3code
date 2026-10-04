import {
  primaryProviderUsageWindow,
  providerUsageRingStatus,
} from "@t3tools/client-runtime/state/provider-usage";
import { resolveProviderUsageMeter } from "@t3tools/client-runtime/state/provider-usage-meter";
import { oldestProviderUsageObservedAt } from "@t3tools/client-runtime/state/provider-usage-presentation";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { canStartProviderUsageRefresh } from "../../lib/providerUsagePill";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

function useMinuteClockMs(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return nowMs;
}

/**
 * Quota for the composer's usage pill and sheet: the thread's account, its
 * same-driver siblings or gateway pool, and the Fable account. Shares its
 * model with the web meter through `resolveProviderUsageMeter`.
 */
export function useComposerProviderUsage(input: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeModel: string;
  readonly threadId: string;
}) {
  const { environmentId } = input;
  const providerUsageQuery = useEnvironmentQuery(
    serverEnvironment.providerUsage({ environmentId, input: {} }),
  );
  const nowMs = useMinuteClockMs();
  const snapshots = providerUsageQuery.data?.snapshots;
  // Mobile has no settings mirror, so gateway-ness comes from the pool
  // snapshot itself.
  const meter = useMemo(
    () =>
      resolveProviderUsageMeter({
        providers: input.providers,
        snapshots: snapshots ?? [],
        activeInstanceId: input.activeInstanceId,
        activeModel: input.activeModel,
        threadId: input.threadId,
        // No thread-account probe yet; see `providerUsage.threadAccount`.
        threadAccount: null,
        now: nowMs,
      }),
    [input.activeInstanceId, input.activeModel, input.providers, input.threadId, nowMs, snapshots],
  );

  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
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
  const lastRefreshAtMs = useCallback(
    () =>
      lastRefreshRef.current?.environmentId === environmentId ? lastRefreshRef.current.atMs : 0,
    [environmentId],
  );
  // `providerUsageQuery` is a fresh object every render; its atom-keyed
  // `refresh` is stable. Depending on the object would churn the sheet session
  // and re-present it from above the navigator on every render.
  const refreshSnapshots = providerUsageQuery.refresh;
  const directInstanceIds = meter.directInstanceIds;
  const refresh = useCallback(() => {
    const nowMs = Date.now();
    if (!canStartProviderUsageRefresh(lastRefreshAtMs(), nowMs)) return;
    lastRefreshRef.current = { environmentId, atMs: nowMs };
    refreshTokenRef.current += 1;
    const token = refreshTokenRef.current;
    setRefreshingEnvironmentId(environmentId);
    void (async () => {
      try {
        // Direct accounts re-probe through their provider snapshot; gateway
        // pools re-read the server's latest pool snapshot.
        await Promise.all(
          directInstanceIds.map((instanceId) =>
            refreshProviders({ environmentId, input: { instanceId } }),
          ),
        );
        if (refreshTokenRef.current !== token) return;
        refreshSnapshots();
      } finally {
        if (refreshTokenRef.current === token) setRefreshingEnvironmentId(null);
      }
    })();
  }, [directInstanceIds, environmentId, lastRefreshAtMs, refreshProviders, refreshSnapshots]);

  const panelObservedAt = useMemo(
    () => oldestProviderUsageObservedAt(meter.accounts),
    [meter.accounts],
  );
  return {
    meter,
    nowMs,
    refreshing: refreshingEnvironmentId === environmentId,
    refresh,
    lastRefreshAtMs,
    panelObservedAt,
    unavailable: providerUsageQuery.error !== null,
    primaryWindow: meter.activeUsage ? primaryProviderUsageWindow(meter.activeUsage) : null,
    // Fable has its own row, so it must not repaint the primary dot.
    ringStatus: providerUsageRingStatus(meter.activeUsage, meter.fable?.window.id ?? null),
  };
}
