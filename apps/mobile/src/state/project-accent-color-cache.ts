/**
 * Device cache of the last-known project accent colors, per environment.
 *
 * Accents live in each server's settings, so without a cache the thread list
 * renders colorless on launch and flashes into color as environments connect.
 * The cached map per environment is served until that environment reports
 * fresh settings, which then replace it — the merge rules in
 * `resolveProjectAccentColor` are untouched; only where the per-environment
 * maps come from changes.
 */
import type { ProjectAccentColorMap } from "@t3tools/client-runtime/state/project-accent-colors";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SidebarProjectAccentColor } from "@t3tools/contracts/settings";
import { Atom } from "effect/unstable/reactivity";

import { isAccentColor } from "../lib/accentTint";
import {
  loadProjectAccentColors,
  saveProjectAccentColors,
  type StoredProjectAccentColors,
} from "../persistence/imperative";
import { appAtomRegistry } from "./atom-registry";

export type ProjectAccentColorsByEnvironment = ReadonlyMap<EnvironmentId, ProjectAccentColorMap>;

const EMPTY_CACHE: ProjectAccentColorsByEnvironment = new Map();

/** Bursts of settings events must not become a write per event. */
const PERSIST_DEBOUNCE_MS = 1_000;

export const projectAccentColorCacheAtom = Atom.make<ProjectAccentColorsByEnvironment>(
  EMPTY_CACHE,
).pipe(Atom.keepAlive, Atom.withLabel("mobile:project-accent-colors:cache"));

function accentColorsEqual(left: ProjectAccentColorMap, right: ProjectAccentColorMap): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((accentKey) => left[accentKey] === right[accentKey]);
}

function cachesEqual(
  left: ProjectAccentColorsByEnvironment,
  right: ProjectAccentColorsByEnvironment,
): boolean {
  if (left.size !== right.size) return false;
  for (const [environmentId, accentColors] of left) {
    const other = right.get(environmentId);
    if (other === undefined || !accentColorsEqual(accentColors, other)) return false;
  }
  return true;
}

/**
 * Fresh maps replace their environment's entry; environments that have not
 * reported yet (offline included) keep the cached one. Returns `cached`
 * unchanged when the content matches, so an identical settings event does not
 * re-render every row or trigger a write.
 */
export function mergeProjectAccentColorCache(input: {
  readonly cached: ProjectAccentColorsByEnvironment;
  readonly live: ProjectAccentColorsByEnvironment;
  /**
   * Environment ids the client still knows about, or null while that list is
   * unknown. Entries outside it are dropped so a removed environment cannot
   * keep coloring rows; being merely disconnected never drops an entry.
   */
  readonly knownEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}): ProjectAccentColorsByEnvironment {
  const next = new Map<EnvironmentId, ProjectAccentColorMap>();
  for (const [environmentId, accentColors] of input.cached) {
    if (input.knownEnvironmentIds !== null && !input.knownEnvironmentIds.has(environmentId)) {
      continue;
    }
    next.set(environmentId, accentColors);
  }
  for (const [environmentId, accentColors] of input.live) {
    next.set(environmentId, accentColors);
  }
  return cachesEqual(input.cached, next) ? input.cached : next;
}

/** Drops anything a row could not render, so a corrupt blob cannot blank one. */
export function decodeStoredProjectAccentColors(stored: unknown): ProjectAccentColorsByEnvironment {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return EMPTY_CACHE;
  const cache = new Map<EnvironmentId, ProjectAccentColorMap>();
  for (const [environmentId, accentColors] of Object.entries(stored)) {
    if (
      environmentId.length === 0 ||
      typeof accentColors !== "object" ||
      accentColors === null ||
      Array.isArray(accentColors)
    ) {
      continue;
    }
    const sanitized: Record<string, SidebarProjectAccentColor> = {};
    for (const [accentKey, color] of Object.entries(accentColors)) {
      if (accentKey.length > 0 && typeof color === "string" && isAccentColor(color)) {
        sanitized[accentKey] = color;
      }
    }
    cache.set(environmentId as EnvironmentId, sanitized);
  }
  return cache;
}

export function encodeProjectAccentColorCache(
  cache: ProjectAccentColorsByEnvironment,
): StoredProjectAccentColors {
  return Object.fromEntries(cache);
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingCache: ProjectAccentColorsByEnvironment | null = null;
// Writes are fire-and-forget; chaining them keeps an older cache from landing
// after a newer one.
let persistQueue: Promise<unknown> = Promise.resolve();

function schedulePersist(cache: ProjectAccentColorsByEnvironment): void {
  pendingCache = cache;
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const cacheToWrite = pendingCache;
    pendingCache = null;
    if (cacheToWrite === null) return;
    persistQueue = persistQueue.then(
      () =>
        saveProjectAccentColors(encodeProjectAccentColorCache(cacheToWrite)).catch((error) => {
          console.warn("[project-accent-colors] failed to persist the accent cache", error);
        }),
      () => undefined,
    );
  }, PERSIST_DEBOUNCE_MS);
}

let hydration: Promise<void> | null = null;

/** Serves the stored accents before any environment connects. Runs once. */
export function ensureProjectAccentColorCacheLoaded(): void {
  if (hydration !== null) return;
  hydration = loadProjectAccentColors()
    .then((stored) => {
      const cached = decodeStoredProjectAccentColors(stored);
      if (cached.size === 0) return;
      // Anything recorded while the read was in flight came from a live
      // server, so it outranks the stored copy.
      appAtomRegistry.set(
        projectAccentColorCacheAtom,
        mergeProjectAccentColorCache({
          cached,
          live: appAtomRegistry.get(projectAccentColorCacheAtom),
          knownEnvironmentIds: null,
        }),
      );
    })
    .catch((error) => {
      console.warn("[project-accent-colors] failed to load the accent cache", error);
    });
}

/** Folds fresh server maps into the cache and persists the result if it moved. */
export function recordProjectAccentColors(input: {
  readonly live: ProjectAccentColorsByEnvironment;
  readonly knownEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}): void {
  const cached = appAtomRegistry.get(projectAccentColorCacheAtom);
  const next = mergeProjectAccentColorCache({ ...input, cached });
  if (next === cached) return;
  appAtomRegistry.set(projectAccentColorCacheAtom, next);
  schedulePersist(next);
}
