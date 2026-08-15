/**
 * Saved prompt library, shared by every client.
 *
 * Prompts live in each server's `ServerSettings.savedPromptLibrary` so the
 * library a user builds on one machine is usable from every connected
 * environment. Unlike project accent colors (a per-key map merged with
 * owner precedence), the library is one atomic value under last-write-wins:
 *
 * - **Reads pick the newest stamp** (`resolveSavedPromptLibrary`) among the
 *   connected environments, with a stable environmentId tie-break so every
 *   client resolves the same winner.
 * - **Writes stamp and fan out** (`stampSavedPromptLibrary` + the caller's
 *   fan-out) to every connected environment that advertises `savedPrompts`,
 *   so an edit becomes durable on each machine rather than only on whichever
 *   one happened to be primary.
 * - **Stale environments are repaired** (`buildSavedPromptSyncPatches`): an
 *   environment that was offline during an edit receives the newest library
 *   when it reconnects. Whole-library LWW is what keeps deletion simple — a
 *   per-prompt merge would resurrect deleted prompts from the stale side.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { SavedPrompt, SavedPromptLibrary } from "@t3tools/contracts/settings";
import { EMPTY_SAVED_PROMPT_LIBRARY } from "@t3tools/contracts/settings";

export interface ResolvedSavedPromptLibrary {
  readonly library: SavedPromptLibrary;
  /** Environment whose copy won, null when every copy is the empty default. */
  readonly sourceEnvironmentId: EnvironmentId | null;
}

// .sort() on a copy, not .toSorted(): this module is bundled into the mobile
// app, and Hermes doesn't ship the ES2023 change-by-copy array methods.
function orderedEntries(
  librariesByEnvironment: ReadonlyMap<EnvironmentId, SavedPromptLibrary>,
): Array<[EnvironmentId, SavedPromptLibrary]> {
  return [...librariesByEnvironment.entries()].sort(([left], [right]) => left.localeCompare(right));
}

/** The newest library among connected environments; ties break by the stable
    environmentId order so concurrent equal stamps resolve identically on
    every client instead of ping-ponging between them. */
export function resolveSavedPromptLibrary(
  librariesByEnvironment: ReadonlyMap<EnvironmentId, SavedPromptLibrary>,
): ResolvedSavedPromptLibrary {
  let winner: ResolvedSavedPromptLibrary = {
    library: EMPTY_SAVED_PROMPT_LIBRARY,
    sourceEnvironmentId: null,
  };
  for (const [environmentId, library] of orderedEntries(librariesByEnvironment)) {
    if (library.updatedAt > winner.library.updatedAt) {
      winner = { library, sourceEnvironmentId: environmentId };
    }
  }
  return winner;
}

export interface SavedPromptSyncPatch {
  readonly environmentId: EnvironmentId;
  readonly savedPromptLibrary: SavedPromptLibrary;
}

/**
 * Repair patches that bring stale environments up to the newest library.
 * Only environments with a STRICTLY older stamp are patched — pushing to
 * equal stamps would loop forever on the (converged) steady state.
 */
export function buildSavedPromptSyncPatches(input: {
  readonly librariesByEnvironment: ReadonlyMap<EnvironmentId, SavedPromptLibrary>;
  /** Connected environments that advertise saved-prompt persistence. */
  readonly writableEnvironmentIds: ReadonlySet<EnvironmentId>;
}): SavedPromptSyncPatch[] {
  const { library } = resolveSavedPromptLibrary(input.librariesByEnvironment);
  if (library.updatedAt === 0) return [];

  return orderedEntries(input.librariesByEnvironment).flatMap(([environmentId, candidate]) =>
    input.writableEnvironmentIds.has(environmentId) && candidate.updatedAt < library.updatedAt
      ? [{ environmentId, savedPromptLibrary: library }]
      : [],
  );
}

/**
 * The next library after a local edit. The stamp is monotonic over the
 * current resolved library so a clock behind another machine's still
 * produces a winning write.
 */
export function stampSavedPromptLibrary(
  current: SavedPromptLibrary,
  prompts: ReadonlyArray<SavedPrompt>,
  now: number,
): SavedPromptLibrary {
  return { updatedAt: Math.max(now, current.updatedAt + 1), prompts };
}
