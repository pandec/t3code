import type {
  ProviderInstanceId,
  ProviderInstanceUsageSnapshot,
  ServerProvider,
} from "@t3tools/contracts";

import {
  deriveProviderUsageAccountsFromServerSnapshot,
  deriveProviderUsageSnapshotFromServerSnapshot,
  deriveProviderUsageSnapshotFromUsageLimits,
  featuredProviderUsageAccount,
  listProviderUsageAccountsForDisplay,
  presentProviderUsageAccount,
  providerUsageLabelForDriver,
  resolveProviderUsageFableRing,
  resolveProviderUsageUpstreamProvider,
  type ProviderUsageSnapshot,
  type ProviderUsageThresholds,
  type ProviderUsageWindow,
} from "./providerUsage.ts";
import {
  resolveProviderUsageBoundAuthIndex,
  type ProviderUsageThreadAccountState,
} from "./providerUsagePresentation.ts";

/**
 * The composer quota meter (web ring popover, mobile usage sheet) as one pure
 * model, so both clients list the same accounts with the same badges.
 *
 * Direct accounts read upstream's typed `usageLimits` from their provider
 * snapshot. Gateway-backed instances (CLIProxyAPI) instead meter their pool of
 * upstream accounts from the server's gateway usage snapshot; their own typed
 * limits describe the proxy login, not the accounts that serve turns, so they
 * are ignored.
 */

export interface ProviderUsageMeterAccount {
  readonly instanceId: ProviderInstanceId;
  /**
   * Distinguishes pooled gateway accounts that share one instance id; rows
   * for regular instances omit it and key on the instance id alone.
   */
  readonly accountKey?: string;
  readonly displayName: string;
  readonly email: string | undefined;
  /**
   * Whether this account serves the active thread. For a direct instance that
   * is the instance the thread runs on; for a pooled gateway account it is set
   * only once the gateway confirmed the session's sticky binding.
   */
  readonly isCurrent: boolean;
  /** Gateway pools only: the account a *new* session would bind to. */
  readonly isNext?: boolean;
  readonly usage: ProviderUsageSnapshot | null;
  /** Unix milliseconds of the read behind `usage`, or null when never read. */
  readonly observedAt: number | null;
  /** Secondary metadata, e.g. a gateway account's tier and cooldown. */
  readonly detail?: string | null;
  /** Why this account has no usage; rendered on its own line when present. */
  readonly error?: string | null;
}

export interface ProviderUsageMeter {
  /** Usage of the account the active thread spends, for the compact ring/pill. */
  readonly activeUsage: ProviderUsageSnapshot | null;
  readonly fable: { readonly accountName: string; readonly window: ProviderUsageWindow } | null;
  readonly accounts: ReadonlyArray<ProviderUsageMeterAccount>;
  /** Accounts header: the driver ("Claude"), or the gateway instance's name. */
  readonly label: string | null;
  /** The active instance is gateway-backed. */
  readonly gateway: boolean;
  /** Direct instances listed in `accounts`, which a refresh re-probes. */
  readonly directInstanceIds: ReadonlyArray<ProviderInstanceId>;
}

export const EMPTY_PROVIDER_USAGE_METER: ProviderUsageMeter = {
  activeUsage: null,
  fable: null,
  accounts: [],
  label: null,
  gateway: false,
  directInstanceIds: [],
};

export function resolveProviderUsageMeter(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Gateway pool snapshots from `providerUsage.read`. */
  readonly snapshots: ReadonlyArray<ProviderInstanceUsageSnapshot>;
  /** The instance the thread's session runs on, else the composer's selection. */
  readonly activeInstanceId: ProviderInstanceId | null;
  /** The model the thread's session last ran, else the composer's selection. */
  readonly activeModel: string;
  /**
   * Marks gateway-backed instances before their first pool snapshot arrives
   * (web reads the settings envelope's `usageSource`). A pool snapshot marks
   * an instance gateway-backed either way.
   */
  readonly isGatewayInstance?: (instanceId: ProviderInstanceId) => boolean;
  readonly threadId: string | undefined;
  /** The gateway account the thread's session is bound to, when probed. */
  readonly threadAccount: ProviderUsageThreadAccountState | null;
  readonly now: number;
  readonly thresholds?: Partial<ProviderUsageThresholds>;
}): ProviderUsageMeter {
  const { activeInstanceId, now } = input;
  if (activeInstanceId === null) return EMPTY_PROVIDER_USAGE_METER;
  const activeProvider = input.providers.find(
    (provider) => provider.instanceId === activeInstanceId,
  );
  const driver = activeProvider?.driver ?? null;
  const driverLabel = providerUsageLabelForDriver(driver);
  // Only providers with machine-readable quota get a meter.
  if (activeProvider === undefined || driverLabel === null) return EMPTY_PROVIDER_USAGE_METER;

  const thresholdOptions = input.thresholds !== undefined ? { thresholds: input.thresholds } : {};
  const snapshotByInstance = new Map(
    input.snapshots.map((snapshot) => [snapshot.instanceId, snapshot]),
  );
  const pools = new Map<
    ProviderInstanceId,
    NonNullable<ReturnType<typeof deriveProviderUsageAccountsFromServerSnapshot>>
  >();
  for (const snapshot of input.snapshots) {
    const pool = deriveProviderUsageAccountsFromServerSnapshot(snapshot, {
      now,
      ...thresholdOptions,
    });
    if (pool !== null) pools.set(snapshot.instanceId, pool);
  }
  const isGateway = (instanceId: ProviderInstanceId) =>
    pools.has(instanceId) || input.isGatewayInstance?.(instanceId) === true;

  if (isGateway(activeInstanceId)) {
    const snapshot = snapshotByInstance.get(activeInstanceId);
    const pool = pools.get(activeInstanceId) ?? null;
    const upstreamProvider = resolveProviderUsageUpstreamProvider({
      payload: snapshot?.payload,
      model: input.activeModel,
      isCustom:
        activeProvider.models.find((model) => model.slug === input.activeModel)?.isCustom === true,
      driver,
    });
    const activeUsage = snapshot
      ? deriveProviderUsageSnapshotFromServerSnapshot(snapshot, {
          now,
          preferredUpstreamProvider: upstreamProvider,
          ...thresholdOptions,
        })
      : null;
    if (pool === null) {
      // Gateway-backed but not read yet: one placeholder row for the instance.
      return {
        activeUsage,
        fable: null,
        accounts: [
          {
            instanceId: activeInstanceId,
            displayName: activeProvider.displayName ?? activeInstanceId,
            email: activeProvider.auth.email,
            isCurrent: true,
            usage: null,
            observedAt: snapshot?.observedAt ?? null,
          },
        ],
        label: driverLabel,
        gateway: true,
        directInstanceIds: [],
      };
    }
    const featuredId = featuredProviderUsageAccount(pool.accounts, upstreamProvider)?.id ?? null;
    // The verified-binding badges only apply where the server can read a
    // binding (Claude sessions). Elsewhere the featured account keeps the
    // legacy "current" so e.g. a Codex thread does not lose its badge.
    const bindingSupported = driver === "claudeAgent";
    const boundAuthIndex = bindingSupported
      ? resolveProviderUsageBoundAuthIndex(input.threadAccount, input.threadId, input.activeModel)
      : null;
    const displayAccounts = listProviderUsageAccountsForDisplay(pool.accounts);
    // A binding to an account no row shows (disabled since the session bound)
    // would leave "next" pointing at an account that is not in play.
    const boundRowVisible =
      boundAuthIndex !== null &&
      displayAccounts.some((account) => account.authIndex === boundAuthIndex);
    return {
      activeUsage,
      fable: resolveProviderUsageFableRing({
        upstreamProvider,
        accounts: pool.accounts,
        snapshot: activeUsage,
      }),
      accounts: displayAccounts.map((account) => ({
        instanceId: activeInstanceId,
        accountKey: `${activeInstanceId}:${account.id}`,
        ...presentProviderUsageAccount(account),
        isCurrent: bindingSupported
          ? boundRowVisible && account.authIndex === boundAuthIndex
          : account.id === featuredId,
        ...(bindingSupported
          ? { isNext: (boundAuthIndex === null || boundRowVisible) && account.id === featuredId }
          : {}),
        usage: account.usage,
        observedAt: snapshot?.observedAt ?? null,
      })),
      // The rows are upstream accounts of mixed providers, so the header
      // names the gateway instance rather than a driver.
      label: activeProvider.displayName ?? activeInstanceId,
      gateway: true,
      directInstanceIds: [],
    };
  }

  // A direct thread meters every enabled same-driver subscription, active
  // first; gateway siblings render only when a thread runs on them.
  const directProviders = input.providers
    .filter(
      (provider) =>
        provider.enabled && provider.driver === driver && !isGateway(provider.instanceId),
    )
    .sort((left, right) =>
      left.instanceId === activeInstanceId ? -1 : right.instanceId === activeInstanceId ? 1 : 0,
    );
  const accounts = directProviders.map((provider): ProviderUsageMeterAccount => {
    const usage = deriveProviderUsageSnapshotFromUsageLimits(provider.usageLimits, {
      provider: provider.driver,
      providerInstanceId: provider.instanceId,
      now,
      ...thresholdOptions,
    });
    const checkedAtMs = provider.usageLimits ? Date.parse(provider.usageLimits.checkedAt) : NaN;
    return {
      instanceId: provider.instanceId,
      displayName: provider.displayName ?? provider.instanceId,
      email: provider.auth.email,
      isCurrent: provider.instanceId === activeInstanceId,
      usage,
      observedAt: Number.isFinite(checkedAtMs) ? checkedAtMs : null,
      error:
        usage === null && provider.usageLimits?.unavailable?.reason === "probeFailed"
          ? (provider.usageLimits.unavailable.message ?? "Couldn't read usage")
          : null,
    };
  });
  const activeUsage =
    accounts.find((account) => account.instanceId === activeInstanceId)?.usage ?? null;
  return {
    activeUsage,
    fable: resolveProviderUsageFableRing({
      upstreamProvider: resolveProviderUsageUpstreamProvider({
        payload: undefined,
        model: input.activeModel,
        isCustom:
          activeProvider.models.find((model) => model.slug === input.activeModel)?.isCustom ===
          true,
        driver,
      }),
      accounts: null,
      snapshot: activeUsage,
    }),
    accounts,
    label: driverLabel,
    gateway: false,
    directInstanceIds: accounts.map((account) => account.instanceId),
  };
}
