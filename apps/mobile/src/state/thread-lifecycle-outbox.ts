import { useAtomValue } from "@effect/atom-react";
import { createThreadLifecycleOutboxManager } from "@t3tools/client-runtime/state/thread-lifecycle-outbox-manager";
import {
  threadLifecycleIntentKey,
  type ThreadLifecycleIntent,
} from "@t3tools/client-runtime/state/thread-lifecycle-outbox-model";
import { scopeThreadShell, type EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { appAtomRegistry } from "./atom-registry";
import {
  expoThreadLifecycleOutboxStorage,
  flushThreadLifecycleOutboxWrites,
} from "./thread-lifecycle-outbox-storage";

export const threadLifecycleOutboxManager = createThreadLifecycleOutboxManager({
  registry: appAtomRegistry,
  storage: expoThreadLifecycleOutboxStorage,
  atomLabel: "mobile:thread-lifecycle-outbox:intents",
  warn: (message, error) => console.warn(message, error),
});

export async function flushThreadLifecycleOutbox(): Promise<void> {
  await threadLifecycleOutboxManager.serialize(async () => {});
  await flushThreadLifecycleOutboxWrites();
}

export function ensureThreadLifecycleOutboxLoaded(): Promise<void> {
  return threadLifecycleOutboxManager.load();
}

export function enqueueThreadLifecycleIntent(intent: ThreadLifecycleIntent): Promise<void> {
  return threadLifecycleOutboxManager.enqueue(intent);
}

export function confirmThreadLifecycleIntentCurrent(
  intent: ThreadLifecycleIntent,
): Promise<boolean> {
  return threadLifecycleOutboxManager.confirmCurrent(intent);
}

export function markThreadLifecycleIntentDispatchAttempted(
  intent: ThreadLifecycleIntent,
): Promise<ThreadLifecycleIntent | null> {
  return threadLifecycleOutboxManager.markDispatchAttempted(intent);
}

export function removeThreadLifecycleIntentIfCurrent(
  intent: ThreadLifecycleIntent,
): Promise<boolean> {
  return threadLifecycleOutboxManager.removeIfCurrent(intent);
}

export function clearThreadLifecycleOutboxEnvironment(environmentId: EnvironmentId): Promise<void> {
  return threadLifecycleOutboxManager.clearEnvironment(environmentId);
}

export function useThreadLifecycleIntents(): Readonly<Record<string, ThreadLifecycleIntent>> {
  return useAtomValue(threadLifecycleOutboxManager.intentsByThreadKeyAtom);
}

export function useThreadLifecycleOutboxLoadState() {
  return useAtomValue(threadLifecycleOutboxManager.loadStateAtom);
}

export interface ThreadLifecyclePresentation {
  readonly activeThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingArchivedThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingArchivedThreadKeys: ReadonlySet<string>;
}

export function deriveThreadLifecyclePresentation(
  canonicalThreads: ReadonlyArray<EnvironmentThreadShell>,
  intents: Readonly<Record<string, ThreadLifecycleIntent>>,
): ThreadLifecyclePresentation {
  const activeByKey = new Map(
    canonicalThreads.map((thread) => [
      threadLifecycleIntentKey(thread.environmentId, thread.id),
      thread,
    ]),
  );
  const pendingArchivedThreads: EnvironmentThreadShell[] = [];
  const pendingArchivedThreadKeys = new Set<string>();

  for (const [key, intent] of Object.entries(intents)) {
    const canonical = activeByKey.get(key);
    const snapshot = scopeThreadShell(intent.environmentId, intent.thread);
    if (intent.desiredArchived) {
      activeByKey.delete(key);
      pendingArchivedThreadKeys.add(key);
      pendingArchivedThreads.push({
        ...(canonical ?? snapshot),
        archivedAt: intent.createdAt,
      });
      continue;
    }
    activeByKey.set(key, { ...(canonical ?? snapshot), archivedAt: null });
  }

  pendingArchivedThreads.sort((left, right) =>
    (right.archivedAt ?? right.updatedAt).localeCompare(left.archivedAt ?? left.updatedAt),
  );
  return {
    activeThreads: [...activeByKey.values()],
    pendingArchivedThreads,
    pendingArchivedThreadKeys,
  };
}

export function useThreadLifecyclePresentation(
  canonicalThreads: ReadonlyArray<EnvironmentThreadShell>,
): ThreadLifecyclePresentation {
  const intents = useThreadLifecycleIntents();
  return useMemo(
    () => deriveThreadLifecyclePresentation(canonicalThreads, intents),
    [canonicalThreads, intents],
  );
}

export function mergePendingArchivedThreads(
  serverArchive: {
    readonly threads: ReadonlyArray<EnvironmentThreadShell>;
    readonly totalCount: number;
  },
  pendingThreads: ReadonlyArray<EnvironmentThreadShell>,
  visibleCount: number,
  selectedThreadKey?: string | null,
): { readonly threads: ReadonlyArray<EnvironmentThreadShell>; readonly totalCount: number } {
  const pendingKeys = new Set(
    pendingThreads.map((thread) => threadLifecycleIntentKey(thread.environmentId, thread.id)),
  );
  const combined = [
    ...pendingThreads,
    ...serverArchive.threads.filter(
      (thread) => !pendingKeys.has(threadLifecycleIntentKey(thread.environmentId, thread.id)),
    ),
  ];
  const clipped = combined.slice(0, visibleCount);
  if (
    selectedThreadKey &&
    !clipped.some(
      (thread) => threadLifecycleIntentKey(thread.environmentId, thread.id) === selectedThreadKey,
    )
  ) {
    const selected = combined.find(
      (thread) => threadLifecycleIntentKey(thread.environmentId, thread.id) === selectedThreadKey,
    );
    if (selected) clipped.push(selected);
  }
  const serverPendingOverlap = serverArchive.threads.filter((thread) =>
    pendingKeys.has(threadLifecycleIntentKey(thread.environmentId, thread.id)),
  ).length;
  return {
    threads: clipped,
    totalCount: serverArchive.totalCount + pendingThreads.length - serverPendingOverlap,
  };
}
