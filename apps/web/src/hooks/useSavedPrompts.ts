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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SavedPrompt, SavedPromptLibrary } from "@t3tools/contracts/settings";
import {
  buildSavedPromptSyncPatches,
  resolveSavedPromptLibrary,
  stampSavedPromptLibrary,
} from "@t3tools/client-runtime/state/saved-prompts";
import { Atom } from "effect/unstable/reactivity";

import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useUpdateSettingsForEnvironment } from "./useSettings";

export interface SavedPrompts {
  readonly prompts: ReadonlyArray<SavedPrompt>;
  /** At least one environment is connected (capable or not). */
  readonly hasConnectedEnvironment: boolean;
  /** At least one connected environment persists saved prompts. */
  readonly canEdit: boolean;
  /**
   * Stamps and replaces the library on every connected capable environment.
   * Functional on purpose: consecutive edits made before the server state
   * round-trips must compose on the pending library, not on a stale render.
   */
  readonly saveAll: (
    update: (current: ReadonlyArray<SavedPrompt>) => ReadonlyArray<SavedPrompt>,
  ) => void;
}

interface SavedPromptEnvironmentState {
  readonly librariesByEnvironment: ReadonlyMap<EnvironmentId, SavedPromptLibrary>;
  readonly writableEnvironmentIds: ReadonlySet<EnvironmentId>;
}

function collectSavedPromptEnvironmentState(
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>,
): SavedPromptEnvironmentState {
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
}

function useSavedPromptEnvironmentState(): SavedPromptEnvironmentState {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  return useMemo(() => collectSavedPromptEnvironmentState(presentations), [presentations]);
}

/**
 * The resolved library, identity-stable while its content is unchanged: the
 * winning environment's `savedPromptLibrary` is carried by reference through
 * config updates, so hot subscribers (the composer, the palette) do not
 * re-render on unrelated presentation churn.
 */
const savedPromptLibraryAtom = Atom.make((get) => {
  const { librariesByEnvironment } = collectSavedPromptEnvironmentState(
    get(environmentPresentations.presentationsAtom),
  );
  return resolveSavedPromptLibrary(librariesByEnvironment).library;
}).pipe(Atom.withLabel("web-saved-prompt-library"));

/** Read-only library view for hot consumers (composer, palette). */
export function useSavedPromptList(): ReadonlyArray<SavedPrompt> {
  return useAtomValue(savedPromptLibraryAtom).prompts;
}

export function useSavedPrompts(): SavedPrompts {
  const { librariesByEnvironment, writableEnvironmentIds } = useSavedPromptEnvironmentState();
  const updateEnvironmentSettings = useUpdateSettingsForEnvironment();

  const library = useMemo(
    () => resolveSavedPromptLibrary(librariesByEnvironment).library,
    [librariesByEnvironment],
  );
  // Unacknowledged local edit, rendered optimistically: the UI and the next
  // edit's baseline are always the same library, so consecutive edits
  // compose on what the user sees rather than on a hidden pending value.
  const [pendingLibrary, setPendingLibrary] = useState<SavedPromptLibrary | null>(null);
  // Strictly newer only: a resolved library that caught up — or tied, the
  // accepted equal-stamp collision residue — wins over the pending one.
  const effectiveLibrary =
    pendingLibrary !== null && pendingLibrary.updatedAt > library.updatedAt
      ? pendingLibrary
      : library;
  const effectiveLibraryRef = useRef(effectiveLibrary);
  effectiveLibraryRef.current = effectiveLibrary;

  // Housekeeping: once the resolved state reaches the pending stamp the edit
  // is acknowledged, and keeping the pending value would only shadow later
  // remote edits.
  useEffect(() => {
    if (pendingLibrary !== null && library.updatedAt >= pendingLibrary.updatedAt) {
      setPendingLibrary(null);
    }
  }, [library, pendingLibrary]);

  const saveAll = useCallback(
    (update: (current: ReadonlyArray<SavedPrompt>) => ReadonlyArray<SavedPrompt>) => {
      if (writableEnvironmentIds.size === 0) return;
      const savedPromptLibrary = stampSavedPromptLibrary(
        effectiveLibraryRef.current,
        update(effectiveLibraryRef.current.prompts),
        Date.now(),
      );
      setPendingLibrary(savedPromptLibrary);
      const writes = [...writableEnvironmentIds].map((environmentId) =>
        updateEnvironmentSettings(environmentId, { savedPromptLibrary }),
      );
      void Promise.all(writes).then((results) => {
        if (results.every((result) => result?._tag !== "Success")) {
          // Every environment rejected the edit: drop the optimistic value so
          // the UI returns to server truth instead of showing a write that
          // never landed. (A later pending edit stays — it has its own fate.)
          setPendingLibrary((current) => (current === savedPromptLibrary ? null : current));
        }
      });
    },
    [updateEnvironmentSettings, writableEnvironmentIds],
  );

  return useMemo(
    () => ({
      prompts: effectiveLibrary.prompts,
      hasConnectedEnvironment: librariesByEnvironment.size > 0,
      canEdit: writableEnvironmentIds.size > 0,
      saveAll,
    }),
    [effectiveLibrary, librariesByEnvironment, saveAll, writableEnvironmentIds],
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
  // Background repair, not a user action: a flaky environment must not raise
  // error toasts, so this bypasses `useUpdateSettingsForEnvironment`.
  const persistSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  // Stamps currently in flight per environment, so a slow acknowledgement is
  // not re-sent on every unrelated presentation change in between.
  const pushedStampsRef = useRef(new Map<EnvironmentId, number>());

  useEffect(() => {
    // Settled or moot entries leave the guard: an environment that converged,
    // disconnected, or regressed (e.g. a hand-edited settings.json) becomes
    // pushable again instead of being suppressed by an old in-flight stamp.
    for (const [environmentId, stamp] of pushedStampsRef.current) {
      const current = librariesByEnvironment.get(environmentId);
      if (current === undefined || current.updatedAt >= stamp) {
        pushedStampsRef.current.delete(environmentId);
      }
    }

    const patches = buildSavedPromptSyncPatches({
      librariesByEnvironment,
      writableEnvironmentIds,
    });
    for (const patch of patches) {
      const stamp = patch.savedPromptLibrary.updatedAt;
      if ((pushedStampsRef.current.get(patch.environmentId) ?? 0) >= stamp) continue;
      pushedStampsRef.current.set(patch.environmentId, stamp);
      void persistSettings({
        environmentId: patch.environmentId,
        input: { patch: { savedPromptLibrary: patch.savedPromptLibrary } },
      }).then((result) => {
        if (
          result._tag !== "Success" &&
          pushedStampsRef.current.get(patch.environmentId) === stamp
        ) {
          // Failed push: forget it so the next state change may retry.
          pushedStampsRef.current.delete(patch.environmentId);
        }
      });
    }
  }, [librariesByEnvironment, persistSettings, writableEnvironmentIds]);
}
