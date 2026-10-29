import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { readCustomModelIcons } from "@t3tools/client-runtime/customModelIcons";

export type ThreadListProvider = Pick<
  ServerProvider,
  "instanceId" | "driver" | "enabled" | "displayName" | "accentColor" | "iconUrl"
> & {
  /** Fork: the instance's custom-model icon overrides (slug → model icon id). */
  readonly customModelIcons?: Readonly<Record<string, string>>;
};

const capabilityKeys = ["threadSnoozeUntilDone", "threadAutoSettleOptOut"] as const;

function selectEnvironment(config: ServerConfig) {
  return {
    providers: config.providers.map(
      ({ instanceId, driver, enabled, displayName, accentColor, iconUrl }) => ({
        instanceId,
        driver,
        enabled,
        displayName,
        accentColor,
        iconUrl,
        customModelIcons: readCustomModelIcons(
          config.settings.providerInstances?.[instanceId]?.config,
        ),
      }),
    ),
    machineKind: resolveEnvironmentMachineKind(config),
    capabilities: config.environment.capabilities,
    snoozePresets: config.settings.snoozePresets,
  };
}

type ListEnvironment = ReturnType<typeof selectEnvironment>;

function sameIcons(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
) {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  );
}

function sameProviders(
  left: ReadonlyArray<ThreadListProvider>,
  right: ReadonlyArray<ThreadListProvider>,
) {
  return (
    left.length === right.length &&
    left.every((provider, index) => {
      const other = right[index]!;
      return (
        provider.instanceId === other.instanceId &&
        provider.driver === other.driver &&
        provider.enabled === other.enabled &&
        provider.displayName === other.displayName &&
        provider.accentColor === other.accentColor &&
        provider.iconUrl === other.iconUrl &&
        sameIcons(provider.customModelIcons, other.customModelIcons)
      );
    })
  );
}

function collectEnvironments(environments: ReadonlyMap<EnvironmentId, ListEnvironment>) {
  const providersByEnvironmentId = new Map<EnvironmentId, ReadonlyArray<ThreadListProvider>>();
  const machineByEnvironmentId = new Map<EnvironmentId, EnvironmentMachineKind>();
  // Every protocol-2 server supports these thread actions; they only wait for its config.
  const loadedEnvironmentIds = new Set<EnvironmentId>();
  const snoozeUntilDoneEnvironmentIds = new Set<EnvironmentId>();
  const autoSettleOptOutEnvironmentIds = new Set<EnvironmentId>();
  const snoozePresetsByEnvironmentId = new Map<EnvironmentId, ListEnvironment["snoozePresets"]>();
  for (const [id, { providers, machineKind, capabilities, snoozePresets }] of environments) {
    providersByEnvironmentId.set(id, providers);
    snoozePresetsByEnvironmentId.set(id, snoozePresets);
    machineByEnvironmentId.set(id, machineKind);
    loadedEnvironmentIds.add(id);
    if (capabilities.threadSnoozeUntilDone === true) snoozeUntilDoneEnvironmentIds.add(id);
    if (capabilities.threadAutoSettleOptOut === true) autoSettleOptOutEnvironmentIds.add(id);
  }
  return {
    providersByEnvironmentId,
    machineByEnvironmentId,
    settlementEnvironmentIds: loadedEnvironmentIds,
    snoozeEnvironmentIds: loadedEnvironmentIds,
    snoozeUntilDoneEnvironmentIds,
    pinningEnvironmentIds: loadedEnvironmentIds,
    autoSettleOptOutEnvironmentIds,
    pinReorderEnvironmentIds: loadedEnvironmentIds,
    activeReorderEnvironmentIds: loadedEnvironmentIds,
    titleRegenerationEnvironmentIds: loadedEnvironmentIds,
    snoozePresetsByEnvironmentId,
  };
}

export function createThreadListEnvironmentsAtom(
  configsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ServerConfig>>,
) {
  let previous = new Map<EnvironmentId, ListEnvironment>();
  let result = collectEnvironments(previous);
  return Atom.make((get) => {
    const configs = get(configsAtom);
    const next = new Map<EnvironmentId, ListEnvironment>();
    let changed = configs.size !== previous.size;
    for (const [id, config] of configs) {
      const selected = selectEnvironment(config);
      const prior = previous.get(id);
      if (prior && sameProviders(prior.providers, selected.providers)) {
        selected.providers = prior.providers;
      }
      if (prior && JSON.stringify(prior.snoozePresets) === JSON.stringify(selected.snoozePresets)) {
        selected.snoozePresets = prior.snoozePresets;
      }
      const unchanged =
        prior &&
        prior.providers === selected.providers &&
        prior.machineKind === selected.machineKind &&
        prior.snoozePresets === selected.snoozePresets &&
        capabilityKeys.every(
          (key) => (prior.capabilities[key] === true) === (selected.capabilities[key] === true),
        );
      next.set(id, unchanged ? prior : selected);
      if (!unchanged) changed = true;
    }
    if (changed) {
      previous = next;
      result = collectEnvironments(next);
    }
    return result;
  }).pipe(Atom.withLabel("thread-list-environments"));
}
