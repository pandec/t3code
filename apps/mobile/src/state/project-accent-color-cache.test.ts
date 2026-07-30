import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const { saveProjectAccentColors } = vi.hoisted(() => ({
  saveProjectAccentColors: vi.fn(() => Promise.resolve()),
}));

vi.mock("../persistence/imperative", () => ({
  loadProjectAccentColors: vi.fn(() => Promise.resolve(undefined)),
  saveProjectAccentColors,
}));

import {
  decodeStoredProjectAccentColors,
  encodeProjectAccentColorCache,
  mergeProjectAccentColorCache,
  projectAccentColorCacheAtom,
  recordProjectAccentColors,
  type ProjectAccentColorsByEnvironment,
} from "./project-accent-color-cache";
import { appAtomRegistry } from "./atom-registry";

const environmentA = "env-a" as EnvironmentId;
const environmentB = "env-b" as EnvironmentId;

describe("decodeStoredProjectAccentColors", () => {
  it("keeps well-formed entries and drops unrenderable colors", () => {
    const cache = decodeStoredProjectAccentColors({
      [environmentA]: { "repo:one": "#0055aa", "repo:two": "rebeccapurple", "repo:three": 12 },
      [environmentB]: ["not", "a", "map"],
      "": { "repo:one": "#0055aa" },
    });
    expect([...cache]).toEqual([[environmentA, { "repo:one": "#0055aa" }]]);
  });

  it("treats a corrupt blob as no cache at all", () => {
    expect(decodeStoredProjectAccentColors(undefined).size).toBe(0);
    expect(decodeStoredProjectAccentColors(["nope"]).size).toBe(0);
  });
});

describe("mergeProjectAccentColorCache", () => {
  const cached: ProjectAccentColorsByEnvironment = new Map<EnvironmentId, Record<string, string>>([
    [environmentA, { "repo:one": "#0055aa" }],
    [environmentB, { "repo:two": "#aa5500" }],
  ]);

  it("lets a fresh map replace its environment and keeps the others cached", () => {
    const merged = mergeProjectAccentColorCache({
      cached,
      live: new Map([[environmentA, { "repo:one": "#112233" }]]),
      knownEnvironmentIds: null,
    });
    expect([...merged]).toEqual([
      [environmentA, { "repo:one": "#112233" }],
      [environmentB, { "repo:two": "#aa5500" }],
    ]);
  });

  it("returns the cache unchanged when a settings event repeats what is stored", () => {
    expect(
      mergeProjectAccentColorCache({
        cached,
        // Same content, fresh objects — what a re-delivered server config looks like.
        live: new Map([[environmentA, { "repo:one": "#0055aa" }]]),
        knownEnvironmentIds: null,
      }),
    ).toBe(cached);
  });

  it("drops environments the client no longer knows about", () => {
    const merged = mergeProjectAccentColorCache({
      cached,
      live: new Map(),
      knownEnvironmentIds: new Set([environmentA]),
    });
    expect([...merged.keys()]).toEqual([environmentA]);
  });

  it("keeps a known environment that is merely disconnected", () => {
    expect(
      mergeProjectAccentColorCache({
        cached,
        live: new Map(),
        knownEnvironmentIds: new Set([environmentA, environmentB]),
      }),
    ).toBe(cached);
  });
});

describe("recordProjectAccentColors", () => {
  it("persists one write for a burst of settings events", async () => {
    vi.useFakeTimers();
    saveProjectAccentColors.mockClear();
    try {
      recordProjectAccentColors({
        live: new Map([[environmentA, { "repo:one": "#0055aa" }]]),
        knownEnvironmentIds: null,
      });
      recordProjectAccentColors({
        live: new Map([[environmentA, { "repo:one": "#112233" }]]),
        knownEnvironmentIds: null,
      });
      expect(saveProjectAccentColors).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(saveProjectAccentColors).toHaveBeenCalledTimes(1);
      expect(saveProjectAccentColors).toHaveBeenCalledWith({
        [environmentA]: { "repo:one": "#112233" },
      });
      expect(
        encodeProjectAccentColorCache(appAtomRegistry.get(projectAccentColorCacheAtom)),
      ).toEqual({ [environmentA]: { "repo:one": "#112233" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not write when the servers repeat what is already cached", async () => {
    vi.useFakeTimers();
    saveProjectAccentColors.mockClear();
    try {
      recordProjectAccentColors({
        live: new Map([[environmentA, { "repo:one": "#112233" }]]),
        knownEnvironmentIds: null,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(saveProjectAccentColors).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
