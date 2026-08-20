import {
  decodeThreadLifecycleIntent,
  encodeThreadLifecycleIntent,
  type ThreadLifecycleIntent,
} from "@t3tools/client-runtime/state/thread-lifecycle-outbox-model";
import {
  ThreadLifecycleOutboxStorageError,
  type ThreadLifecycleOutboxStorage,
} from "@t3tools/client-runtime/state/thread-lifecycle-outbox-storage";

import { createExpoJsonRowStorage } from "./expo-json-row-storage";

export { ThreadLifecycleOutboxStorageError, type ThreadLifecycleOutboxStorage };

function intentFileName(intent: Pick<ThreadLifecycleIntent, "environmentId" | "threadId">): string {
  return `${encodeURIComponent(`${intent.environmentId}:${intent.threadId}`)}.json`;
}

const threadLifecycleOutboxStore = createExpoJsonRowStorage<ThreadLifecycleIntent>({
  directoryName: "thread-lifecycle-outbox",
  fileName: intentFileName,
  decode: decodeThreadLifecycleIntent,
  encode: encodeThreadLifecycleIntent,
  invalidRowWarning: "[thread-lifecycle-outbox] ignored invalid persisted intent",
  loadError: (cause) =>
    new ThreadLifecycleOutboxStorageError({
      operation: "load",
      environmentId: null,
      threadId: null,
      fileName: null,
      cause,
    }),
  readError: (fileName, cause) =>
    new ThreadLifecycleOutboxStorageError({
      operation: "read-intent",
      environmentId: null,
      threadId: null,
      fileName,
      cause,
    }),
  writeError: (intent, fileName, cause) =>
    new ThreadLifecycleOutboxStorageError({
      operation: "write",
      environmentId: intent.environmentId,
      threadId: intent.threadId,
      fileName,
      cause,
    }),
  removeError: (intent, fileName, cause) =>
    new ThreadLifecycleOutboxStorageError({
      operation: "remove",
      environmentId: intent.environmentId,
      threadId: intent.threadId,
      fileName,
      cause,
    }),
});

export const expoThreadLifecycleOutboxStorage: ThreadLifecycleOutboxStorage =
  threadLifecycleOutboxStore.storage;
export const flushThreadLifecycleOutboxWrites = threadLifecycleOutboxStore.flushWrites;
