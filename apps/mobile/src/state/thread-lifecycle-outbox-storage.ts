import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { createExpoJsonRowStorage } from "./expo-json-row-storage";
import type { ThreadLifecycleOutboxStorage } from "./thread-lifecycle-outbox-manager";
import {
  decodeThreadLifecycleIntent,
  encodeThreadLifecycleIntent,
  type ThreadLifecycleIntent,
} from "./thread-lifecycle-outbox-model";

export class ThreadLifecycleOutboxStorageError extends Schema.TaggedError<ThreadLifecycleOutboxStorageError>()(
  "ThreadLifecycleOutboxStorageError",
  {
    operation: Schema.Literals(["load", "read-intent", "write", "remove"]),
    environmentId: Schema.NullOr(EnvironmentId),
    threadId: Schema.NullOr(ThreadId),
    fileName: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread lifecycle outbox storage operation ${this.operation} failed for environment ${this.environmentId ?? "unknown"}, thread ${this.threadId ?? "unknown"}, file ${this.fileName ?? "unknown"}.`;
  }
}

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
