import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  clampArchivedSectionVisibleCount,
  clampAccentTintIntensityPercent,
  clampSidebarOlderSectionAfterDays,
  clampSteerGraceWindowMs,
  DEFAULT_ARCHIVED_SECTION_VISIBLE_COUNT,
  DEFAULT_ACCENT_TINT_INTENSITY_PERCENT,
  DEFAULT_SIDEBAR_OLDER_SECTION_AFTER_DAYS,
  DEFAULT_STEER_GRACE_WINDOW_MS,
  type AccentTintIntensityPercent,
  type ArchivedSectionVisibleCount,
  type SidebarOlderSectionAfterDays,
  type SteerGraceWindowMs,
} from "@t3tools/contracts/settings";
import { useCallback, useMemo } from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { resolveAccentTintAlphas, type AccentTintAlphas } from "../lib/accentTint";
import type { Preferences } from "../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./preferences";
import {
  resolveThreadShelfExpanded,
  threadShelfExpandedPatch,
  type ThreadShelfId,
} from "./thread-shelf-expansion";

const EMPTY_PREFERENCES: Preferences = {};

/**
 * Device preferences plus whether the persisted blob has arrived.
 *
 * Mobile has no client-settings sync, so these are the fork's Extras settings
 * as stored on this device. Preferences load asynchronously; `hydrated` lets a
 * consumer that cannot afford the default (see the steer hold in
 * `use-thread-outbox-drain`) wait for the stored value instead.
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
  return useMemo(() => clampSteerGraceWindowMs(value ?? DEFAULT_STEER_GRACE_WINDOW_MS), [value]);
}

export function useAlwaysShowPinnedInAttention(): boolean {
  const { preferences } = useMobilePreferences();
  return preferences.sidebarAlwaysShowPinnedInAttention ?? false;
}

/** Whether the active block sorts by newest user message instead of creation. */
export function useSortActiveByLatestUserMessage(): boolean {
  const { preferences } = useMobilePreferences();
  return preferences.sidebarV2SortActiveByLatestUserMessage ?? false;
}

/**
 * Whether threads settle on their own. Off means inactivity and merged pull
 * requests both stop filing threads away; explicit settling still works.
 */
export function useThreadAutoSettleEnabled(): boolean {
  const { preferences } = useMobilePreferences();
  return preferences.threadAutoSettleEnabled !== false;
}

export interface OlderSectionSettings {
  readonly enabled: boolean;
  readonly afterDays: SidebarOlderSectionAfterDays;
  readonly collapsedByDefault: boolean;
}

/** The Older shelf's three settings, clamped on read like the rest. */
export function useOlderSectionSettings(): OlderSectionSettings {
  const { preferences } = useMobilePreferences();
  const enabled = preferences.sidebarOlderSectionEnabled ?? false;
  const afterDays = preferences.sidebarOlderSectionAfterDays;
  // Folded by default, as on web: an unfolded shelf on first run would just
  // be the list the user already had, with a header in the middle of it.
  const collapsedByDefault = preferences.sidebarOlderSectionCollapsedByDefault ?? true;
  return useMemo(
    () => ({
      enabled,
      afterDays: clampSidebarOlderSectionAfterDays(
        afterDays ?? DEFAULT_SIDEBAR_OLDER_SECTION_AFTER_DAYS,
      ),
      collapsedByDefault,
    }),
    [afterDays, collapsedByDefault, enabled],
  );
}

/**
 * One shelf's fold state, remembered per device.
 *
 * A tap writes the choice through, so shelves stay where the user left them
 * across launches — the same thing the web sidebar's local-storage keys do.
 * For the Older shelf the Extras setting only seeds the shelf, and only until
 * that first tap.
 */
export function useThreadShelfExpansion(shelf: ThreadShelfId): {
  readonly expanded: boolean;
  readonly toggle: () => void;
} {
  const { preferences } = useMobilePreferences();
  const { collapsedByDefault } = useOlderSectionSettings();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const expanded = resolveThreadShelfExpanded({
    shelf,
    preferences,
    olderCollapsedByDefault: collapsedByDefault,
  });
  const toggle = useCallback(
    () => savePreferences(threadShelfExpandedPatch(shelf, !expanded)),
    [expanded, savePreferences, shelf],
  );
  return useMemo(() => ({ expanded, toggle }), [expanded, toggle]);
}

export function useArchivedSectionVisibleCount(): ArchivedSectionVisibleCount {
  const { preferences } = useMobilePreferences();
  const value = preferences.archivedSectionVisibleCount;
  return useMemo(
    () => clampArchivedSectionVisibleCount(value ?? DEFAULT_ARCHIVED_SECTION_VISIBLE_COUNT),
    [value],
  );
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
  return useMemo(() => {
    const intensityPercent = clampAccentTintIntensityPercent(
      intensity ?? DEFAULT_ACCENT_TINT_INTENSITY_PERCENT,
    );
    return {
      enabled: enabled ?? true,
      intensityPercent,
      alphas: resolveAccentTintAlphas(intensityPercent),
    };
  }, [enabled, intensity]);
}
