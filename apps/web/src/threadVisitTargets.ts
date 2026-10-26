/** Resolves remembered thread visits against live state (see threadLastVisited). */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { type DraftId, useComposerDraftStore } from "./composerDraftStore";
import { environmentCatalog } from "./connection/catalog";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { readThreadShell } from "./state/entities";
import { environmentShell } from "./state/shell";
import { environmentThreadShells } from "./state/threads";
import { threadVisitHistory } from "./threadLastVisited";
import type { ThreadRouteTarget } from "./threadRoutes";

// A stale entry must not open: the thread may be gone or archived, and
// point shell reads still serve cached snapshots for a removed or disabled
// environment, so the catalog is checked explicitly.
function isThreadOpenable(ref: ScopedThreadRef): boolean {
  if (
    appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(ref.environmentId)
      ?.enabled !== true
  ) {
    return false;
  }
  const shell = readThreadShell(ref);
  const state = Option.getOrNull(
    AsyncResult.value(appAtomRegistry.get(environmentShell.stateAtom(ref.environmentId))),
  );
  const key = scopedThreadKey(ref);
  if (shell !== null) {
    if (shell.archivedAt !== null) return false;
    if (state !== null) shellSeenAtGeneration.set(key, state.generation);
    return true;
  }
  // A shell that omits older settled threads holds one only while it is open or paged in. Within
  // the snapshot it was seen in, only a streamed removal proves it gone; a newer snapshot cleared
  // those, so it no longer can.
  return (
    state !== null &&
    shellSeenAtGeneration.get(key) === state.generation &&
    Option.exists(state.snapshot, (snapshot) => snapshot.olderSettled !== undefined) &&
    !state.removedAt.has(ref.threadId)
  );
}

// Shell generation at which each visited thread last had an unarchived shell.
const shellSeenAtGeneration = new Map<string, number>();

/** Notes the focused thread's shell while it is open: an older settled one loses it on leaving. */
export function trackVisitedThreadShell(ref: ScopedThreadRef): () => void {
  return appAtomRegistry.subscribe(
    environmentThreadShells.threadShellAtom(ref),
    () => void isThreadOpenable(ref),
    { immediate: true },
  );
}

// The server thread each remembered draft becomes once sent. Promotion
// cleanup deletes the draft session, possibly before the next visit is
// recorded, so the ref is captured while the draft is open.
const draftVisitThreadRefs = new Map<DraftId, ScopedThreadRef>();

export function rememberDraftThreadRef(draftId: DraftId): void {
  const session = useComposerDraftStore.getState().getDraftSession(draftId);
  if (session === null) return;
  draftVisitThreadRefs.set(
    draftId,
    session.promotedTo ?? scopeThreadRef(session.environmentId, session.threadId),
  );
}

// A sent draft resolves to its thread; a discarded one never got a thread.
export function resolveVisitTarget(target: ThreadRouteTarget): ThreadRouteTarget | null {
  if (target.kind === "server") {
    return isThreadOpenable(target.threadRef) ? target : null;
  }
  const session = useComposerDraftStore.getState().getDraftSession(target.draftId);
  if (session !== null && session.promotedTo == null) return target;
  rememberDraftThreadRef(target.draftId);
  const threadRef = draftVisitThreadRefs.get(target.draftId);
  return threadRef !== undefined && isThreadOpenable(threadRef)
    ? { kind: "server", threadRef }
    : null;
}

/**
 * Where snoozing or archiving the open thread takes the reader: the thread
 * visited before it (the Ctrl+Tab target), unless that one is snoozed or
 * archived too, or is among `alsoParking` (a bulk snooze in flight).
 */
export function resolveVisitTargetAfterPark(
  parked: ScopedThreadRef,
  alsoParking?: ReadonlySet<string>,
): ThreadRouteTarget | null {
  const now = new Date().toISOString();
  return threadVisitHistory.resolveTarget({ kind: "server", threadRef: parked }, (entry) => {
    const target = resolveVisitTarget(entry);
    if (target?.kind !== "server") return target;
    if (alsoParking?.has(scopedThreadKey(target.threadRef))) return null;
    const shell = readThreadShell(target.threadRef);
    return shell === null || !effectiveSnoozed(shell, { now }) ? target : null;
  });
}
