import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  type QueuedThreadMessage,
} from "@t3tools/client-runtime/state/thread-outbox-model";
import {
  ThreadOutboxStorageError,
  type ThreadOutboxStorage,
} from "@t3tools/client-runtime/state/thread-outbox-storage";

const THREAD_OUTBOX_STORAGE_KEY_PREFIX = "t3code:thread-outbox:v1:";

function messageStorageKey(message: QueuedThreadMessage): string {
  return `${THREAD_OUTBOX_STORAGE_KEY_PREFIX}${message.messageId}`;
}

/** One localStorage entry per queued message so writes never clobber siblings. */
export const localThreadOutboxStorage: ThreadOutboxStorage = {
  load: async () => {
    if (typeof localStorage === "undefined") {
      return [];
    }
    const messages: QueuedThreadMessage[] = [];
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key !== null && key.startsWith(THREAD_OUTBOX_STORAGE_KEY_PREFIX)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      const raw = localStorage.getItem(key);
      if (raw === null) {
        continue;
      }
      try {
        messages.push(decodeQueuedThreadMessage(JSON.parse(raw)));
      } catch (cause) {
        console.warn(
          "[thread-outbox] skipping invalid persisted message",
          new ThreadOutboxStorageError({
            operation: "read-message",
            environmentId: null,
            threadId: null,
            messageId: null,
            fileName: key,
            cause,
          }),
        );
      }
    }
    return messages;
  },
  write: async (message) => {
    localStorage.setItem(
      messageStorageKey(message),
      JSON.stringify(encodeQueuedThreadMessage(message)),
    );
  },
  remove: async (message) => {
    localStorage.removeItem(messageStorageKey(message));
  },
};
