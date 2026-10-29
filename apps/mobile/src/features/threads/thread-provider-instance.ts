import { useMemo } from "react";

import { reportedModelIcon } from "@t3tools/client-runtime/customModelIcons";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  normalizeProviderAccentColor,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";
import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";

import type { ThreadListProvider } from "../../state/thread-list-environments";
export interface ThreadRowProviderInstance {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly showBadge: boolean;
  /** Fork: the thread's custom model icon, so gateway-served models show their family glyph. */
  readonly modelIcon?: string | undefined;
}

/** Scope by environment; default instance ids name different accounts on different servers. */
export function resolveThreadProviderInstance(
  providers: ReadonlyArray<ThreadListProvider> | undefined,
  thread: EnvironmentThreadShell,
): ThreadRowProviderInstance | null {
  if (providers === undefined) return null;
  const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const snapshot = providers.find((provider) => provider.instanceId === instanceId);
  if (!snapshot) return null;
  const entry = {
    driverKind: snapshot.driver,
    displayName: resolveProviderInstanceDisplayName(snapshot),
    accentColor: normalizeProviderAccentColor(snapshot.accentColor),
  };
  const modelIcon =
    snapshot.customModelIcons && instanceId === thread.modelSelection.instanceId
      ? reportedModelIcon(snapshot.customModelIcons, thread.modelSelection.model)
      : undefined;
  return {
    ...entry,
    showBadge: shouldShowInstanceBadge(
      { ...entry, enabled: snapshot.enabled },
      providers.map((provider) => ({ driverKind: provider.driver, enabled: provider.enabled })),
    ),
    ...(modelIcon ? { modelIcon } : {}),
  };
}

/** Cache per provider-list generation so fresh resolver objects cannot invalidate every memoized row. */
export function createThreadRowProviderInstanceResolver(
  providersByEnvironmentId: ReadonlyMap<EnvironmentId, ReadonlyArray<ThreadListProvider>>,
): (thread: EnvironmentThreadShell) => ThreadRowProviderInstance | null {
  const cache = new Map<string, ThreadRowProviderInstance | null>();
  return (thread) => {
    const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
    const cacheKey = `${thread.environmentId}|${instanceId ?? ""}|${thread.modelSelection.instanceId}|${thread.modelSelection.model}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const resolved = resolveThreadProviderInstance(
      providersByEnvironmentId.get(thread.environmentId),
      thread,
    );
    cache.set(cacheKey, resolved);
    return resolved;
  };
}

export function useThreadRowProviderInstanceResolver(
  providersByEnvironmentId: ReadonlyMap<EnvironmentId, ReadonlyArray<ThreadListProvider>>,
): (thread: EnvironmentThreadShell) => ThreadRowProviderInstance | null {
  return useMemo(
    () => createThreadRowProviderInstanceResolver(providersByEnvironmentId),
    [providersByEnvironmentId],
  );
}
