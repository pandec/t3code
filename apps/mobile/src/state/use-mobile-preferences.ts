import { useAtomValue } from "@effect/atom-react";
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
import { useMemo } from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { resolveAccentTintAlphas, type AccentTintAlphas } from "../lib/accentTint";
import type { Preferences } from "../persistence/mobile-preferences";
import { mobilePreferencesAtom } from "./preferences";

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
