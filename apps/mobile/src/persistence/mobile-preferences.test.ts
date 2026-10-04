import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

import * as MobileDatabase from "./mobile-database";
import {
  make,
  MOBILE_PREFERENCES_OPERATION_TIMEOUT_MS,
  MobilePreferencesSaveError,
  sanitizePreferences,
} from "./mobile-preferences";
import * as MobileSecureStorage from "./mobile-secure-storage";

describe("mobile preferences persistence", () => {
  it("drops retired Older section keys saved by earlier builds", () => {
    // Preferences persisted before the Older shelf was removed still carry
    // its keys; they must fall away without disturbing their siblings.
    const legacyPreferences = {
      sidebarOlderSectionEnabled: true,
      sidebarOlderSectionAfterDays: 30,
      sidebarOlderSectionCollapsedByDefault: true,
      sidebarOlderShelfExpanded: true,
      sidebarSnoozedShelfExpanded: true,
    };
    expect(sanitizePreferences(legacyPreferences)).toEqual({ sidebarSnoozedShelfExpanded: true });
  });

  it("keeps valid shelf fold states", () => {
    expect(
      sanitizePreferences({
        sidebarSnoozedShelfExpanded: true,
        sidebarSettledShelfExpanded: false,
        sidebarArchivedShelfExpanded: true,
      }),
    ).toMatchObject({
      sidebarSnoozedShelfExpanded: true,
      sidebarSettledShelfExpanded: false,
      sidebarArchivedShelfExpanded: true,
    });
    expect(
      sanitizePreferences({
        sidebarSnoozedShelfExpanded: "true" as unknown as boolean,
        sidebarSettledShelfExpanded: null as unknown as boolean,
        sidebarArchivedShelfExpanded: "yes" as unknown as boolean,
      }),
    ).toEqual({});
  });

  it("drops retired Attention filter keys saved by earlier builds", () => {
    const legacyPreferences = {
      sidebarAlwaysShowPinnedInAttention: true,
      threadLastVisitedAtById: { "environment-1:thread-1": "2026-06-01T10:00:00.000Z" },
      sidebarActiveShelfExpanded: false,
    };
    expect(sanitizePreferences(legacyPreferences)).toEqual({ sidebarActiveShelfExpanded: false });
  });

  it.effect("releases the update lock after a timed-out preference read", () =>
    Effect.gen(function* () {
      let loadCount = 0;
      const database = MobileDatabase.MobileDatabase.of({
        loadPreferencesJson: Effect.suspend(() => {
          loadCount += 1;
          return loadCount === 1 ? Effect.never : Effect.succeed(Option.none());
        }),
        savePreferencesJson: () => Effect.void,
      } as unknown as MobileDatabase.MobileDatabase["Service"]);
      const secureStorage = MobileSecureStorage.MobileSecureStorage.of({
        getItem: () => Effect.succeed(null),
        setItem: () => Effect.void,
        removeItem: () => Effect.void,
      });
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, database),
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, secureStorage),
      );

      const firstSave = yield* store
        .savePatch({ baseFontSize: 18 })
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(MOBILE_PREFERENCES_OPERATION_TIMEOUT_MS);

      expect(yield* Fiber.join(firstSave)).toBeInstanceOf(MobilePreferencesSaveError);

      expect(yield* store.savePatch({ baseFontSize: 19 })).toEqual({
        baseFontSize: 19,
      });
      expect(loadCount).toBe(2);
    }),
  );
});
