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
  it("keeps valid pinned visibility preferences", () => {
    expect(
      sanitizePreferences({ sidebarAlwaysShowPinnedInAttention: true })
        .sidebarAlwaysShowPinnedInAttention,
    ).toBe(true);
    expect(
      sanitizePreferences({ sidebarAlwaysShowPinnedInAttention: "yes" as unknown as boolean })
        .sidebarAlwaysShowPinnedInAttention,
    ).toBeUndefined();
  });

  it("keeps only valid persisted thread visit timestamps", () => {
    expect(
      sanitizePreferences({
        threadLastVisitedAtById: {
          "environment-1:valid": "2026-06-01T10:00:00.000Z",
          "environment-1:invalid": "not-a-date",
        },
      }).threadLastVisitedAtById,
    ).toEqual({
      "environment-1:valid": "2026-06-01T10:00:00.000Z",
    });
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
