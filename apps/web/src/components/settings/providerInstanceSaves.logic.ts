import type { ProviderInstanceConfig, ProviderInstanceId } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";

import {
  type CustomModelSave,
  pendingCustomModelSaves,
  settleCustomModelSave,
} from "./customModelSaves.logic";

export type ProviderInstanceSave = CustomModelSave<ProviderInstanceConfig>;

/** Unechoed whole-envelope writes per instance, and the stored envelope they were last reconciled with. */
export type ProviderInstanceSaves = ReadonlyMap<
  ProviderInstanceId,
  { readonly stored: string; readonly saves: ReadonlyArray<ProviderInstanceSave> }
>;

// Change detection reads the whole envelope: a masked field can change while the key stays put.
const storedSnapshot = (instance: ProviderInstanceConfig | undefined) =>
  stableStringify(instance ?? null);

/** Sensitive env values and usage-source keys echo redacted, so the key keeps only whether one is set. */
export function providerInstanceKey(instance: ProviderInstanceConfig | undefined): string {
  if (instance === undefined) return "";
  const { environment, usageSource } = instance;
  return stableStringify({
    ...instance,
    environment: environment?.map((variable) =>
      variable.sensitive && typeof variable.value === "string"
        ? {
            name: variable.name,
            sensitive: true,
            set: variable.value !== "" || !!variable.valueRedacted,
          }
        : variable,
    ),
    usageSource: usageSource && {
      kind: usageSource.kind,
      managementUrl: usageSource.managementUrl,
      keySet: usageSource.managementKey !== "" || !!usageSource.managementKeyRedacted,
    },
  });
}

function withInstanceSaves(
  saves: ProviderInstanceSaves,
  instanceId: ProviderInstanceId,
  stored: string,
  pending: ReadonlyArray<ProviderInstanceSave>,
): ProviderInstanceSaves {
  const next = new Map(saves);
  if (pending.length > 0) next.set(instanceId, { stored, saves: pending });
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
    const snapshot = storedSnapshot(stored?.[instanceId]);
    if (snapshot === entry.stored) continue;
    next = withInstanceSaves(
      next,
      instanceId,
      snapshot,
      pendingCustomModelSaves(entry.saves, providerInstanceKey(stored?.[instanceId])),
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
  return withInstanceSaves(saves, instanceId, entry?.stored ?? storedSnapshot(stored), [
    ...(entry?.saves ?? []),
    sent,
  ]);
}

/** `returned` is the instance in the server's reply to a successful write. */
export function settleProviderInstanceSave(
  saves: ProviderInstanceSaves,
  instanceId: ProviderInstanceId,
  sent: ProviderInstanceSave,
  saved: boolean,
  returned?: ProviderInstanceConfig,
): ProviderInstanceSaves {
  const entry = saves.get(instanceId);
  if (entry === undefined) return saves;
  // A write that changed only redacted fields reads back as the stored envelope, so no echo comes.
  const sentIndex = entry.saves.findIndex((save) => save.models === sent.models);
  // Only the oldest save: an earlier one still awaits an echo that can arrive after this reply.
  const unobservable =
    saved &&
    sentIndex === 0 &&
    storedSnapshot(returned) === entry.stored &&
    storedSnapshot(sent.models) !== entry.stored;
  return withInstanceSaves(
    saves,
    instanceId,
    entry.stored,
    unobservable ? entry.saves.slice(1) : settleCustomModelSave(entry.saves, sent, saved),
  );
}
