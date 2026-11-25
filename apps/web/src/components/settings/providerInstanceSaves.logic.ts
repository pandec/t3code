import type { ProviderInstanceConfig, ProviderInstanceId } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";

import {
  type CustomModelSave,
  pendingCustomModelSaves,
  settleCustomModelSave,
} from "./customModelSaves.logic";

export type ProviderInstanceSave = CustomModelSave<ProviderInstanceConfig>;

/** Unechoed whole-envelope writes per instance, and the stored key they were last reconciled with. */
export type ProviderInstanceSaves = ReadonlyMap<
  ProviderInstanceId,
  { readonly storedKey: string; readonly saves: ReadonlyArray<ProviderInstanceSave> }
>;

/** Env values and usage-source keys can echo redacted, so a write and its echo share a key without them. */
export function providerInstanceKey(instance: ProviderInstanceConfig | undefined): string {
  if (instance === undefined) return "";
  const { environment, usageSource } = instance;
  return stableStringify({
    ...instance,
    environment: environment?.map(({ name, sensitive }) => ({ name, sensitive })),
    usageSource: usageSource && {
      kind: usageSource.kind,
      managementUrl: usageSource.managementUrl,
    },
  });
}

function withInstanceSaves(
  saves: ProviderInstanceSaves,
  instanceId: ProviderInstanceId,
  storedKey: string,
  pending: ReadonlyArray<ProviderInstanceSave>,
): ProviderInstanceSaves {
  const next = new Map(saves);
  if (pending.length > 0) next.set(instanceId, { storedKey, saves: pending });
  else next.delete(instanceId);
  return next;
}

/** Applies the custom model echo rules to every instance whose stored envelope changed. */
export function reconcileProviderInstanceSaves(
  saves: ProviderInstanceSaves,
  stored: Readonly<Record<string, ProviderInstanceConfig>> | undefined,
): ProviderInstanceSaves {
  let next = saves;
  for (const [instanceId, entry] of saves) {
    const storedKey = providerInstanceKey(stored?.[instanceId]);
    if (storedKey === entry.storedKey) continue;
    next = withInstanceSaves(
      next,
      instanceId,
      storedKey,
      pendingCustomModelSaves(entry.saves, storedKey),
    );
  }
  return next;
}

export function addProviderInstanceSave(
  saves: ProviderInstanceSaves,
  instanceId: ProviderInstanceId,
  sent: ProviderInstanceSave,
  stored: ProviderInstanceConfig | undefined,
): ProviderInstanceSaves {
  const entry = saves.get(instanceId);
  return withInstanceSaves(saves, instanceId, entry?.storedKey ?? providerInstanceKey(stored), [
    ...(entry?.saves ?? []),
    sent,
  ]);
}

export function settleProviderInstanceSave(
  saves: ProviderInstanceSaves,
  instanceId: ProviderInstanceId,
  sent: ProviderInstanceSave,
  saved: boolean,
): ProviderInstanceSaves {
  const entry = saves.get(instanceId);
  if (entry === undefined) return saves;
  return withInstanceSaves(
    saves,
    instanceId,
    entry.storedKey,
    settleCustomModelSave(entry.saves, sent, saved),
  );
}
