import type { EnvironmentId } from "@t3tools/contracts";
import type { ProjectAccentColorMap } from "@t3tools/client-runtime/state/project-accent-colors";

type MutableProjectAccentColorMap = Record<string, ProjectAccentColorMap[string]>;

export interface ProjectAccentColorWrite {
  readonly environmentId: EnvironmentId;
  readonly fallbackMap: ProjectAccentColorMap;
  readonly readCurrentMap: () => ProjectAccentColorMap | undefined;
  readonly update: (current: ProjectAccentColorMap) => {
    readonly payload: MutableProjectAccentColorMap;
    readonly changed: boolean;
  };
  readonly persist: (
    payload: MutableProjectAccentColorMap,
  ) => Promise<ProjectAccentColorMap | null>;
}

const writeChains = new Map<EnvironmentId, Promise<ProjectAccentColorMap | null>>();

/**
 * The settings command serializes RPCs, but building two accent payloads before they
 * enter that queue can let a later whole-map replacement overwrite the first. Each
 * operation starts from the previous server response, or the freshest rendered map after
 * a failure.
 */
export function enqueueProjectAccentColorWrite(
  input: ProjectAccentColorWrite,
): Promise<ProjectAccentColorMap | null> {
  const previous = writeChains.get(input.environmentId) ?? Promise.resolve(null);
  const current = previous
    .catch(() => null)
    .then(async (lastPersistedMap) => {
      const base = lastPersistedMap ?? input.readCurrentMap() ?? input.fallbackMap;
      const { payload, changed } = input.update(base);
      return changed ? input.persist(payload) : base;
    });

  writeChains.set(input.environmentId, current);
  void current.then(
    () => {
      if (writeChains.get(input.environmentId) === current) {
        writeChains.delete(input.environmentId);
      }
    },
    () => {
      if (writeChains.get(input.environmentId) === current) {
        writeChains.delete(input.environmentId);
      }
    },
  );
  return current;
}

export function __resetProjectAccentColorWriteQueueForTests(): void {
  writeChains.clear();
}
