/**
 * Web access to the cross-environment saved prompt library.
 *
 * The library is a server setting (`ServerSettings.savedPromptLibrary`), one
 * copy per environment, synced with whole-library last-write-wins: reads pick
 * the newest stamp among connected environments, edits stamp and fan out to
 * every capable environment, and `useSavedPromptLibrarySync` repairs stale
 * environments when they reconnect. See
 * `@t3tools/client-runtime/state/saved-prompts` for the rules.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SavedPrompt, SavedPromptLibrary } from "@t3tools/contracts/settings";
import {
  buildSavedPromptSyncPatches,
  resolveSavedPromptLibrary,
  stampSavedPromptLibrary,
} from "@t3tools/client-runtime/state/saved-prompts";

import { environmentPresentations } from "~/state/presentation";
import { useUpdateSettingsForEnvironment } from "./useSettings";

export interface SavedPrompts {
  readonly prompts: ReadonlyArray<SavedPrompt>;
  /** At least one connected environment persists saved prompts. */
  readonly canEdit: boolean;
  /** Stamps and replaces the library on every connected capable environment. */
  readonly saveAll: (prompts: ReadonlyArray<SavedPrompt>) => void;
}

interface SavedPromptEnvironmentState {
  readonly librariesByEnvironment: ReadonlyMap<EnvironmentId, SavedPromptLibrary>;
  readonly writableEnvironmentIds: ReadonlySet<EnvironmentId>;
}

function useSavedPromptEnvironmentState(): SavedPromptEnvironmentState {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  return useMemo(() => {
    const librariesByEnvironment = new Map<EnvironmentId, SavedPromptLibrary>();
    const writableEnvironmentIds = new Set<EnvironmentId>();
    for (const [environmentId, presentation] of presentations) {
      const config = presentation.serverConfig;
      if (presentation.connection.phase !== "connected" || config === null) continue;
      librariesByEnvironment.set(environmentId, config.settings.savedPromptLibrary);
      if (config.environment.capabilities.savedPrompts === true) {
        writableEnvironmentIds.add(environmentId);
      }
    }
    return { librariesByEnvironment, writableEnvironmentIds };
  }, [presentations]);
}

export function useSavedPrompts(): SavedPrompts {
  const { librariesByEnvironment, writableEnvironmentIds } = useSavedPromptEnvironmentState();
  const updateEnvironmentSettings = useUpdateSettingsForEnvironment();

  const library = useMemo(
    () => resolveSavedPromptLibrary(librariesByEnvironment).library,
    [librariesByEnvironment],
  );
  const libraryRef = useRef(library);
  libraryRef.current = library;

  const saveAll = useCallback(
    (prompts: ReadonlyArray<SavedPrompt>) => {
      const savedPromptLibrary = stampSavedPromptLibrary(libraryRef.current, prompts, Date.now());
      for (const environmentId of writableEnvironmentIds) {
        void updateEnvironmentSettings(environmentId, { savedPromptLibrary });
      }
    },
    [updateEnvironmentSettings, writableEnvironmentIds],
  );

  return useMemo(
    () => ({ prompts: library.prompts, canEdit: writableEnvironmentIds.size > 0, saveAll }),
    [library, saveAll, writableEnvironmentIds],
  );
}

/**
 * Pushes the newest library to connected environments holding a strictly
 * older stamp. Mounted once at the app root; convergence is driven by state:
 * each acknowledged push updates that environment's settings, re-runs the
 * effect, and eventually leaves `buildSavedPromptSyncPatches` empty.
 */
export function useSavedPromptLibrarySync(): void {
  const { librariesByEnvironment, writableEnvironmentIds } = useSavedPromptEnvironmentState();
  const updateEnvironmentSettings = useUpdateSettingsForEnvironment();
  // Stamps already in flight per environment, so a slow acknowledgement is
  // not re-sent on every unrelated presentation change in between.
  const pushedStampsRef = useRef(new Map<EnvironmentId, number>());

  useEffect(() => {
    const patches = buildSavedPromptSyncPatches({
      librariesByEnvironment,
      writableEnvironmentIds,
    });
    for (const patch of patches) {
      const stamp = patch.savedPromptLibrary.updatedAt;
      if ((pushedStampsRef.current.get(patch.environmentId) ?? 0) >= stamp) continue;
      pushedStampsRef.current.set(patch.environmentId, stamp);
      void updateEnvironmentSettings(patch.environmentId, {
        savedPromptLibrary: patch.savedPromptLibrary,
      }).then((result) => {
        if (
          result?._tag !== "Success" &&
          pushedStampsRef.current.get(patch.environmentId) === stamp
        ) {
          // Failed push: forget it so the next state change may retry.
          pushedStampsRef.current.delete(patch.environmentId);
        }
      });
    }
  }, [librariesByEnvironment, updateEnvironmentSettings, writableEnvironmentIds]);
}
