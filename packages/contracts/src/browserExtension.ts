import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type BrowserProfile,
  BrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
} from "./browserProfile.ts";

/** Chrome extension ids are 32 letters from a to p. */
export const BrowserExtensionId = Schema.String.check(Schema.isPattern(/^[a-p]{32}$/));
export type BrowserExtensionId = typeof BrowserExtensionId.Type;

export const BrowserExtensionSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  profileIds: Schema.Array(BrowserProfileId).pipe(
    Schema.withDecodingDefault(Effect.succeed([DEFAULT_BROWSER_PROFILE_ID])),
  ),
  pinned: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type BrowserExtensionSettings = typeof BrowserExtensionSettings.Type;

export const BrowserExtensionSettingsById = Schema.Record(
  BrowserExtensionId,
  BrowserExtensionSettings,
);
export type BrowserExtensionSettingsById = typeof BrowserExtensionSettingsById.Type;

const DEFAULT_BROWSER_EXTENSION_SETTINGS: BrowserExtensionSettings = {
  enabled: false,
  profileIds: [DEFAULT_BROWSER_PROFILE_ID],
  pinned: true,
};

export function browserExtensionSettings(
  settings: BrowserExtensionSettingsById,
  extensionId: string,
): BrowserExtensionSettings {
  return settings[extensionId] ?? DEFAULT_BROWSER_EXTENSION_SETTINGS;
}

export function updateBrowserExtensionSettings(
  settings: BrowserExtensionSettingsById,
  extensionId: string,
  patch: Partial<BrowserExtensionSettings>,
): BrowserExtensionSettingsById {
  return {
    ...settings,
    [extensionId]: { ...browserExtensionSettings(settings, extensionId), ...patch },
  };
}

/** Electron cannot load extensions into in-memory sessions, so incognito profiles never run them. */
export function browserExtensionRunsInProfile(
  settings: BrowserExtensionSettingsById,
  extensionId: string,
  profile: BrowserProfile | undefined,
): boolean {
  const extension = browserExtensionSettings(settings, extensionId);
  return (
    extension.enabled &&
    profile !== undefined &&
    profile.kind === "persistent" &&
    extension.profileIds.includes(profile.id)
  );
}
