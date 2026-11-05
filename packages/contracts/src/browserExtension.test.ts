import { describe, expect, it } from "@effect/vitest";

import {
  browserExtensionRunsInProfile,
  updateBrowserExtensionSettings,
} from "./browserExtension.ts";
import { BUILT_IN_BROWSER_PROFILES } from "./browserProfile.ts";

const id = "fdjamakpfbbddfjaooikfcpapjohcfmg";
const [defaultProfile, incognito] = BUILT_IN_BROWSER_PROFILES;
const work = { id: "work", name: "Work", kind: "persistent" } as const;

describe("browser extension settings", () => {
  it("pins without touching where the extension runs", () => {
    const enabled = updateBrowserExtensionSettings({}, id, { enabled: true, profileIds: ["work"] });
    const unpinned = updateBrowserExtensionSettings(enabled, id, { pinned: false });
    expect(unpinned[id]).toEqual({ enabled: true, profileIds: ["work"], pinned: false });
    expect(updateBrowserExtensionSettings(unpinned, id, { pinned: true })[id]?.pinned).toBe(true);
  });

  it("runs only when enabled for a persistent profile it was given", () => {
    expect(browserExtensionRunsInProfile({}, id, defaultProfile)).toBe(false);
    const enabled = updateBrowserExtensionSettings({}, id, { enabled: true });
    expect(browserExtensionRunsInProfile(enabled, id, defaultProfile)).toBe(true);
    expect(browserExtensionRunsInProfile(enabled, id, work)).toBe(false);
    expect(browserExtensionRunsInProfile(enabled, id, undefined)).toBe(false);
    const everywhere = updateBrowserExtensionSettings(enabled, id, {
      profileIds: ["default", "incognito", "work"],
    });
    expect(browserExtensionRunsInProfile(everywhere, id, incognito)).toBe(false);
    expect(browserExtensionRunsInProfile(everywhere, id, work)).toBe(true);
  });
});
