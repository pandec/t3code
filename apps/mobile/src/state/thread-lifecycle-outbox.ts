import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { appAtomRegistry } from "./atom-registry";
import { createThreadLifecycleOutboxManager } from "./thread-lifecycle-outbox-manager";
import {
  deriveThreadLifecyclePresentation,
  type ThreadLifecycleIntent,
  type ThreadLifecyclePresentation,
} from "./thread-lifecycle-outbox-model";
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

/** Lands queued intent writes before an app update restarts the runtime. */
export async function flushThreadLifecycleOutbox(): Promise<void> {
  await threadLifecycleOutboxManager.serialize(async () => {});
  await flushThreadLifecycleOutboxWrites();
}

export function enqueueThreadLifecycleIntent(intent: ThreadLifecycleIntent): Promise<void> {
  return threadLifecycleOutboxManager.enqueue(intent);
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

/** Canonical unarchived shells with pending archive/unarchive intents applied. */
export function useThreadLifecyclePresentation(
  canonicalThreads: ReadonlyArray<EnvironmentThreadShell>,
): ThreadLifecyclePresentation {
  const intents = useThreadLifecycleIntents();
  return useMemo(
    () => deriveThreadLifecyclePresentation(canonicalThreads, intents),
    [canonicalThreads, intents],
  );
}
