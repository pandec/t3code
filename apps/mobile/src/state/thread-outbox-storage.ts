import {
  ThreadOutboxStorageError,
  type ThreadOutboxLoadResult,
  type ThreadOutboxStorage,
} from "@t3tools/client-runtime/state/thread-outbox-storage";
import type { MessageId } from "@t3tools/contracts";

import { createExpoJsonRowStorage } from "./expo-json-row-storage";
import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  type QueuedThreadMessage,
} from "./thread-outbox-model";

export { ThreadOutboxStorageError, type ThreadOutboxLoadResult, type ThreadOutboxStorage };

function messageFileName(messageId: MessageId): string {
  return `${encodeURIComponent(messageId)}.json`;
}

const threadOutboxStore = createExpoJsonRowStorage<QueuedThreadMessage, ThreadOutboxStorageError>({
  directoryName: "thread-outbox",
  fileName: (message) => messageFileName(message.messageId),
  decode: decodeQueuedThreadMessage,
  encode: encodeQueuedThreadMessage,
  invalidRowWarning: "[thread-outbox] ignored invalid persisted message",
  strictRows: true,
  loadError: (cause) =>
    new ThreadOutboxStorageError({
      operation: "load",
      environmentId: null,
      threadId: null,
      messageId: null,
      fileName: null,
      cause,
    }),
  readError: (fileName, cause) =>
    new ThreadOutboxStorageError({
      operation: "read-message",
      environmentId: null,
      threadId: null,
      messageId: null,
      fileName,
      cause,
    }),
  writeError: (message, fileName, cause) =>
    new ThreadOutboxStorageError({
      operation: "write",
      environmentId: message.environmentId,
      threadId: message.threadId,
      messageId: message.messageId,
      fileName,
      cause,
    }),
  removeError: (message, fileName, cause) =>
    new ThreadOutboxStorageError({
      operation: "remove",
      environmentId: message.environmentId,
      threadId: message.threadId,
      messageId: message.messageId,
      fileName,
      cause,
    }),
});

export const expoThreadOutboxStorage: ThreadOutboxStorage = {
  ...threadOutboxStore.storage,
  load: async (): Promise<ThreadOutboxLoadResult> => {
    const result = await threadOutboxStore.storage.load();
    return { messages: result.rows, errors: result.errors };
  },
};
export const flushThreadOutboxWrites = threadOutboxStore.flushWrites;
