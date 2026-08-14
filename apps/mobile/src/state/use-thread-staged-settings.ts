import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atom-registry";
import { modelSelectionsEqual } from "./thread-outbox-model";

export interface StagedSetting<T> {
  readonly value: T;
  readonly baseline: T;
}

export interface StagedThreadSettings {
  readonly modelSelection?: StagedSetting<ModelSelection>;
  readonly runtimeMode?: StagedSetting<RuntimeMode>;
  readonly interactionMode?: StagedSetting<ProviderInteractionMode>;
}

export interface ThreadSettings {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export const threadStagedSettingsAtom = Atom.make<Record<string, StagedThreadSettings>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-staged-settings"),
);

export function stageThreadSettings(
  threadKey: string,
  patch: Partial<ThreadSettings>,
  baselines: ThreadSettings,
): void {
  const current = appAtomRegistry.get(threadStagedSettingsAtom);
  const existing = current[threadKey] ?? {};
  const staged: StagedThreadSettings = {
    ...existing,
    ...(patch.modelSelection !== undefined
      ? { modelSelection: { value: patch.modelSelection, baseline: baselines.modelSelection } }
      : {}),
    ...(patch.runtimeMode !== undefined
      ? { runtimeMode: { value: patch.runtimeMode, baseline: baselines.runtimeMode } }
      : {}),
    ...(patch.interactionMode !== undefined
      ? { interactionMode: { value: patch.interactionMode, baseline: baselines.interactionMode } }
      : {}),
  };
  if (Object.keys(staged).length === 0) {
    return;
  }
  appAtomRegistry.set(threadStagedSettingsAtom, { ...current, [threadKey]: staged });
}

export function getStagedThreadSettings(threadKey: string): StagedThreadSettings | undefined {
  return appAtomRegistry.get(threadStagedSettingsAtom)[threadKey];
}

export function useStagedThreadSettings(
  threadKey: string | null,
): StagedThreadSettings | undefined {
  const stagedByThreadKey = useAtomValue(threadStagedSettingsAtom);
  return threadKey ? stagedByThreadKey[threadKey] : undefined;
}

export function clearStagedThreadSettings(threadKey: string): void {
  const current = appAtomRegistry.get(threadStagedSettingsAtom);
  if (!current[threadKey]) {
    return;
  }
  const next = { ...current };
  delete next[threadKey];
  appAtomRegistry.set(threadStagedSettingsAtom, next);
}

export function removeStagedThreadSettingsForEnvironment(environmentId: EnvironmentId): void {
  const current = appAtomRegistry.get(threadStagedSettingsAtom);
  const environmentPrefix = `${environmentId}:`;
  const next = Object.fromEntries(
    Object.entries(current).filter(([threadKey]) => !threadKey.startsWith(environmentPrefix)),
  );
  if (Object.keys(next).length !== Object.keys(current).length) {
    appAtomRegistry.set(threadStagedSettingsAtom, next);
  }
}

export function resolveStagedThreadSettings(
  staged: StagedThreadSettings | undefined,
  thread: ThreadSettings,
): ThreadSettings {
  return {
    modelSelection:
      staged?.modelSelection &&
      modelSelectionsEqual(thread.modelSelection, staged.modelSelection.baseline)
        ? staged.modelSelection.value
        : thread.modelSelection,
    runtimeMode:
      staged?.runtimeMode && thread.runtimeMode === staged.runtimeMode.baseline
        ? staged.runtimeMode.value
        : thread.runtimeMode,
    interactionMode:
      staged?.interactionMode && thread.interactionMode === staged.interactionMode.baseline
        ? staged.interactionMode.value
        : thread.interactionMode,
  };
}
