import {
  ThreadLifecycleOutboxStorageError,
  type ThreadLifecycleOutboxStorage,
} from "@t3tools/client-runtime/state/thread-lifecycle-outbox-storage";

import { writeFileAtomically } from "../lib/atomic-file";
import {
  decodeThreadLifecycleIntent,
  encodeThreadLifecycleIntent,
  type ThreadLifecycleIntent,
} from "@t3tools/client-runtime/state/thread-lifecycle-outbox-model";

export { ThreadLifecycleOutboxStorageError, type ThreadLifecycleOutboxStorage };

const THREAD_LIFECYCLE_OUTBOX_DIRECTORY = "thread-lifecycle-outbox";
const inFlightWrites = new Set<Promise<void>>();

function trackInFlightWrite(operation: Promise<void>): Promise<void> {
  inFlightWrites.add(operation);
  void operation.catch(() => undefined).finally(() => inFlightWrites.delete(operation));
  return operation;
}

export async function flushThreadLifecycleOutboxWrites(): Promise<void> {
  while (inFlightWrites.size > 0) {
    await Promise.allSettled(inFlightWrites);
  }
}

function intentFileName(intent: Pick<ThreadLifecycleIntent, "environmentId" | "threadId">): string {
  return `${encodeURIComponent(`${intent.environmentId}:${intent.threadId}`)}.json`;
}

async function getOutboxDirectory() {
  const { Directory, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, THREAD_LIFECYCLE_OUTBOX_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

async function getIntentFile(intent: Pick<ThreadLifecycleIntent, "environmentId" | "threadId">) {
  const { File } = await import("expo-file-system");
  return new File(await getOutboxDirectory(), intentFileName(intent));
}

export const expoThreadLifecycleOutboxStorage: ThreadLifecycleOutboxStorage = {
  load: async () => {
    const intents: ThreadLifecycleIntent[] = [];
    try {
      const { File } = await import("expo-file-system");
      const directory = await getOutboxDirectory();
      for (const entry of directory.list()) {
        if (!(entry instanceof File) || !entry.name.endsWith(".json")) continue;
        try {
          intents.push(decodeThreadLifecycleIntent(JSON.parse(await entry.text()) as unknown));
        } catch (cause) {
          console.warn(
            "[thread-lifecycle-outbox] ignored invalid persisted intent",
            new ThreadLifecycleOutboxStorageError({
              operation: "read-intent",
              environmentId: null,
              threadId: null,
              fileName: entry.name,
              cause,
            }),
          );
        }
      }
    } catch (cause) {
      throw new ThreadLifecycleOutboxStorageError({
        operation: "load",
        environmentId: null,
        threadId: null,
        fileName: null,
        cause,
      });
    }
    return intents;
  },
  write: async (intent) => {
    const fileName = intentFileName(intent);
    try {
      await trackInFlightWrite(
        (async () => {
          const file = await getIntentFile(intent);
          await writeFileAtomically(file, JSON.stringify(encodeThreadLifecycleIntent(intent)));
        })(),
      );
    } catch (cause) {
      throw new ThreadLifecycleOutboxStorageError({
        operation: "write",
        environmentId: intent.environmentId,
        threadId: intent.threadId,
        fileName,
        cause,
      });
    }
  },
  remove: async (intent) => {
    const fileName = intentFileName(intent);
    try {
      const file = await getIntentFile(intent);
      if (file.exists) file.delete();
    } catch (cause) {
      throw new ThreadLifecycleOutboxStorageError({
        operation: "remove",
        environmentId: intent.environmentId,
        threadId: intent.threadId,
        fileName,
        cause,
      });
    }
  },
};
