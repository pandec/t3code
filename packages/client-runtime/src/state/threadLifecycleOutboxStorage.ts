import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ThreadLifecycleIntent } from "./threadLifecycleOutboxModel.ts";

export class ThreadLifecycleOutboxStorageError extends Schema.TaggedErrorClass<ThreadLifecycleOutboxStorageError>()(
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

export interface ThreadLifecycleOutboxStorage {
  readonly load: () => Promise<ReadonlyArray<ThreadLifecycleIntent>>;
  readonly write: (intent: ThreadLifecycleIntent) => Promise<void>;
  readonly remove: (intent: ThreadLifecycleIntent) => Promise<void>;
}
