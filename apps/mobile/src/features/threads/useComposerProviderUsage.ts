import {
  primaryProviderUsageWindow,
  providerUsageRingStatus,
} from "@t3tools/client-runtime/state/provider-usage";
import { resolveProviderUsageMeter } from "@t3tools/client-runtime/state/provider-usage-meter";
import {
  oldestProviderUsageObservedAt,
  shouldProbeProviderUsageThreadAccount,
  type ProviderUsageThreadAccountProbe,
  type ProviderUsageThreadAccountState,
} from "@t3tools/client-runtime/state/provider-usage-presentation";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
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
  readonly threadId: ThreadId;
  /** The thread has a provider session, so a gateway binding may exist. */
  readonly hasProviderSession: boolean;
}) {
  const { environmentId } = input;
  const providerUsageQuery = useEnvironmentQuery(
    serverEnvironment.providerUsage({ environmentId, input: {} }),
  );
  const nowMs = useMinuteClockMs();
  const snapshots = providerUsageQuery.data?.snapshots;
  // The pooled account the thread's session is bound to, read from the gateway
  // when the usage sheet opens. Kept with the thread and model it was probed
  // for, so an answer landing after a switch cannot mislabel the new context.
  const [threadAccount, setThreadAccount] = useState<ProviderUsageThreadAccountState | null>(null);
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
        threadAccount,
        now: nowMs,
      }),
    [
      input.activeInstanceId,
      input.activeModel,
      input.providers,
      input.threadId,
      nowMs,
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
  // Only a Claude session has a binding the server can read. Mobile has no
  // settings mirror to tell a gateway instance from a direct one before its
  // first pool snapshot, so a direct-instance thread costs one RPC the server
  // answers null. Throttles itself; `force` (the refresh button) outranks the
  // cadence cap but not the spam floor.
  const probeThreadAccount = useCallback(
    (options?: { readonly force?: boolean }) => {
      const threadId = input.threadId;
      if (!input.hasProviderSession || activeDriver !== "claudeAgent") return;
      const model = input.activeModel;
      const probeKey = `${environmentId}:${threadId}:${model}`;
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
        setThreadAccount(authIndex === null ? null : { threadId, model, authIndex });
      })();
    },
    [
      activeDriver,
      environmentId,
      input.activeModel,
      input.hasProviderSession,
      input.threadId,
      readThreadAccount,
    ],
  );

  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const refreshGatewayUsage = useAtomCommand(serverEnvironment.refreshProviderUsage, {
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
  // A gateway meter lists only the active instance's pool.
  const gatewayInstanceId = meter.gateway ? input.activeInstanceId : null;
  const refresh = useCallback(() => {
    // An explicit refresh re-reads the binding past its cadence cap.
    probeThreadAccount({ force: true });
    const nowMs = Date.now();
    if (!canStartProviderUsageRefresh(lastRefreshAtMs(), nowMs)) return;
    lastRefreshRef.current = { environmentId, atMs: nowMs };
    refreshTokenRef.current += 1;
    const token = refreshTokenRef.current;
    setRefreshingEnvironmentId(environmentId);
    void (async () => {
      try {
        // A gateway pool is probed on demand through the gateway; direct
        // accounts re-probe through their provider snapshot. Fail-soft: a
        // failed probe keeps the previous reading.
        await (gatewayInstanceId !== null
          ? refreshGatewayUsage({ environmentId, input: { instanceIds: [gatewayInstanceId] } })
          : Promise.all(
              directInstanceIds.map((instanceId) =>
                refreshProviders({ environmentId, input: { instanceId } }),
              ),
            ));
        if (refreshTokenRef.current !== token) return;
        refreshSnapshots();
      } finally {
        if (refreshTokenRef.current === token) setRefreshingEnvironmentId(null);
      }
    })();
  }, [
    directInstanceIds,
    environmentId,
    gatewayInstanceId,
    lastRefreshAtMs,
    probeThreadAccount,
    refreshGatewayUsage,
    refreshProviders,
    refreshSnapshots,
  ]);

  const panelObservedAt = useMemo(
    () => oldestProviderUsageObservedAt(meter.accounts),
    [meter.accounts],
  );
  return {
    meter,
    nowMs,
    refreshing: refreshingEnvironmentId === environmentId,
    refresh,
    probeThreadAccount,
    lastRefreshAtMs,
    panelObservedAt,
    unavailable: providerUsageQuery.error !== null,
    primaryWindow: meter.activeUsage ? primaryProviderUsageWindow(meter.activeUsage) : null,
    // Fable has its own row, so it must not repaint the primary dot.
    ringStatus: providerUsageRingStatus(meter.activeUsage, meter.fable?.window.id ?? null),
  };
}
