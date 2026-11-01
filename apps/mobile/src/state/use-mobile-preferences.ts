import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  clampArchivedSectionVisibleCount,
  clampAccentTintIntensityPercent,
  clampSteerGraceWindowMs,
  DEFAULT_ARCHIVED_SECTION_VISIBLE_COUNT,
  DEFAULT_ACCENT_TINT_INTENSITY_PERCENT,
  DEFAULT_STEER_GRACE_WINDOW_MS,
  type AccentTintIntensityPercent,
  type ArchivedSectionVisibleCount,
  type SteerGraceWindowMs,
} from "@t3tools/contracts/settings";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

import { resolveAccentTintAlphas, type AccentTintAlphas } from "../lib/accentTint";
import type { Preferences } from "../persistence/mobile-preferences";
import { appAtomRegistry } from "./atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./preferences";
import {
  resolveThreadShelfExpanded,
  threadGroupFold,
  threadListFoldedAttention,
  threadShelfExpandedPatch,
  toggleCollapsedThreadGroup,
  type ThreadShelfId,
} from "./thread-shelf-expansion";

const EMPTY_PREFERENCES: Preferences = {};
const NO_FOLDS: ReadonlySet<string> = new Set();

/**
 * Fork: while the Active work filter is on, every section opens and folds live in memory only,
 * keyed like `threadGroupFold`, so turning the filter off restores the saved folds.
 */
const activeWorkFoldsAtom = Atom.make(NO_FOLDS).pipe(Atom.keepAlive);

function toggledFold(folds: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(folds);
  if (!next.delete(key)) next.add(key);
  return next;
}

/**
 * Mobile has no client-settings sync, so these are the fork's Extras settings stored on this
 * device. They load asynchronously; `hydrated` lets a consumer that cannot afford the default
 * wait for the stored value.
 */
export function useMobilePreferences(): {
  readonly preferences: Preferences;
  readonly hydrated: boolean;
} {
  const result = useAtomValue(mobilePreferencesAtom);
  const hydrated = AsyncResult.isSuccess(result);
  return {
    preferences: hydrated ? result.value : EMPTY_PREFERENCES,
    hydrated,
  };
}

export function useMobilePreferencesHydrated(): boolean {
  return useMobilePreferences().hydrated;
}

/** Steer grace window in milliseconds, clamped on read. */
export function useSteerGraceWindowMs(): SteerGraceWindowMs {
  const { preferences } = useMobilePreferences();
  const value = preferences.steerGraceWindowMs;
  return clampSteerGraceWindowMs(value ?? DEFAULT_STEER_GRACE_WINDOW_MS);
}

/** The steer grace window for app services outside React (the outbox delivery). */
export function readSteerGraceWindowMs(): SteerGraceWindowMs {
  const result = appAtomRegistry.get(mobilePreferencesAtom);
  const value = AsyncResult.isSuccess(result) ? result.value.steerGraceWindowMs : undefined;
  return clampSteerGraceWindowMs(value ?? DEFAULT_STEER_GRACE_WINDOW_MS);
}

/**
 * One shelf's fold state, remembered per device.
 *
 * A tap writes the choice through, so shelves stay where the user left them
 * across launches — the same thing the web sidebar's local-storage keys do.
 */
export function useThreadShelfExpansion(shelf: ThreadShelfId): {
  readonly expanded: boolean;
  readonly loaded: boolean;
  readonly toggle: () => void;
} {
  const { preferences, hydrated } = useMobilePreferences();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const registry = useContext(RegistryContext);
  const activeWorkFolds = useAtomValue(activeWorkFoldsAtom);
  const activeWork = preferences.activeWorkFilter === true;
  const expanded = activeWork
    ? !activeWorkFolds.has(shelf)
    : resolveThreadShelfExpanded({ shelf, preferences });
  // A transform reads the optimistic value, so two presses before the next
  // render still toggle twice instead of writing the same value.
  const toggle = () => {
    threadListFoldedAttention.acknowledge(shelf);
    if (activeWork) {
      registry.update(activeWorkFoldsAtom, (folds) => toggledFold(folds, shelf));
      return;
    }
    savePreferences({
      transform: (current) =>
        threadShelfExpandedPatch(
          shelf,
          !resolveThreadShelfExpanded({ shelf, preferences: current }),
        ),
    });
  };
  return { expanded, loaded: hydrated, toggle };
}

/** Working section, on by default once preferences load. */
export function useWorkingShelfEnabled(): boolean {
  const { preferences, hydrated } = useMobilePreferences();
  return hydrated && preferences.workingShelfEnabled !== false;
}

export function useArchivedSectionVisibleCount(): ArchivedSectionVisibleCount {
  const { preferences } = useMobilePreferences();
  const value = preferences.archivedSectionVisibleCount;
  return clampArchivedSectionVisibleCount(value ?? DEFAULT_ARCHIVED_SECTION_VISIBLE_COUNT);
}

export interface AccentTintSettings {
  readonly enabled: boolean;
  /** Clamped percentage, as the settings slider shows and writes it. */
  readonly intensityPercent: AccentTintIntensityPercent;
  readonly alphas: AccentTintAlphas;
}

/**
 * Whether (and how strongly) project accent colors tint mobile rows.
 *
 * While preferences load, the defaults stand: they are what every device
 * without an explicit choice renders anyway, so the common path never flashes
 * a tint change on launch.
 */
export function useAccentTintSettings(): AccentTintSettings {
  const { preferences } = useMobilePreferences();
  const enabled = preferences.accentTintsEnabled;
  const intensity = preferences.accentTintIntensityPercent;
  const intensityPercent = clampAccentTintIntensityPercent(
    intensity ?? DEFAULT_ACCENT_TINT_INTENSITY_PERCENT,
  );
  return {
    enabled: enabled ?? true,
    intensityPercent,
    alphas: resolveAccentTintAlphas(intensityPercent),
  };
}

export function useCollapsedThreadGroups() {
  const { preferences } = useMobilePreferences();
  const save = useAtomSet(updateMobilePreferencesAtom);
  const registry = useContext(RegistryContext);
  const activeWorkFolds = useAtomValue(activeWorkFoldsAtom);
  const activeWork = preferences.activeWorkFilter === true;
  const ids = activeWork
    ? new Set(
        [...activeWorkFolds].flatMap((key) =>
          key.startsWith("group:") ? [key.slice("group:".length)] : [],
        ),
      )
    : new Set(preferences.collapsedThreadGroups ?? []);
  const toggle = (id: string) => {
    const fold = threadGroupFold(id);
    threadListFoldedAttention.acknowledge(fold);
    if (activeWork) {
      registry.update(activeWorkFoldsAtom, (folds) => toggledFold(folds, fold));
      return;
    }
    save({ transform: (current) => toggleCollapsedThreadGroup(current, id) });
  };
  return { ids, toggle };
}

/** Fork: the thread list's Active work filter, remembered on this device. */
export function useActiveWorkFilter() {
  const { preferences } = useMobilePreferences();
  const save = useAtomSet(updateMobilePreferencesAtom);
  const registry = useContext(RegistryContext);
  const toggle = () => {
    registry.set(activeWorkFoldsAtom, NO_FOLDS);
    save({ transform: (current) => ({ activeWorkFilter: current.activeWorkFilter !== true }) });
  };
  return {
    enabled: preferences.activeWorkFilter === true,
    includeDone: preferences.activeFilterIncludeDone === true,
    toggle,
  };
}
