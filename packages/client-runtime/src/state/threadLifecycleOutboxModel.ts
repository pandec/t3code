import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  OrchestrationThreadShell,
  ThreadId,
  type OrchestrationThreadShell as OrchestrationThreadShellType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { EnvironmentShellStatus } from "./shell.ts";
import {
  outboxDeliveryErrorMessages,
  scopedThreadKey,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
} from "./threadOutboxModel.ts";

const THREAD_LIFECYCLE_OUTBOX_SCHEMA_VERSION = 1;

export const ThreadLifecycleIntentSchema = Schema.Struct({
  schemaVersion: Schema.Literal(THREAD_LIFECYCLE_OUTBOX_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  desiredArchived: Schema.Boolean,
  requiresDispatch: Schema.Boolean,
  dispatchAttempted: Schema.Boolean,
  commandId: CommandId,
  createdAt: IsoDateTime,
  baselineArchivedAt: Schema.NullOr(IsoDateTime),
  thread: OrchestrationThreadShell,
});

const decodeStoredThreadLifecycleIntent = Schema.decodeUnknownSync(ThreadLifecycleIntentSchema);
const encodeStoredThreadLifecycleIntent = Schema.encodeUnknownSync(ThreadLifecycleIntentSchema);

export interface ThreadLifecycleIntent {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly desiredArchived: boolean;
  /** Reversals dispatch when an earlier revision may have reached the server. */
  readonly requiresDispatch: boolean;
  /** Persisted before this revision's command may be sent. */
  readonly dispatchAttempted: boolean;
  readonly commandId: CommandId;
  readonly createdAt: string;
  readonly baselineArchivedAt: string | null;
  readonly thread: OrchestrationThreadShellType;
}

export function encodeThreadLifecycleIntent(intent: ThreadLifecycleIntent): unknown {
  return encodeStoredThreadLifecycleIntent({
    schemaVersion: THREAD_LIFECYCLE_OUTBOX_SCHEMA_VERSION,
    ...intent,
  });
}

export function decodeThreadLifecycleIntent(value: unknown): ThreadLifecycleIntent {
  const { schemaVersion: _, ...intent } = decodeStoredThreadLifecycleIntent(value);
  return intent;
}

export const threadLifecycleIntentKey = scopedThreadKey;

export function threadLifecycleRevisionRequiresDispatch(
  previous: ThreadLifecycleIntent | undefined,
): boolean {
  return previous?.dispatchAttempted === true;
}

export function groupThreadLifecycleIntents(
  intents: ReadonlyArray<ThreadLifecycleIntent>,
): Readonly<Record<string, ThreadLifecycleIntent>> {
  return Object.fromEntries(
    intents.map((intent) => [
      threadLifecycleIntentKey(intent.environmentId, intent.threadId),
      intent,
    ]),
  );
}

export type ThreadLifecycleOutboxAction = "wait" | "remove" | "archive" | "unarchive";

export function resolveThreadLifecycleOutboxAction(input: {
  readonly environmentConnected: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly messageOutboxReady: boolean;
  readonly threadExists: boolean;
  readonly threadArchived: boolean;
  readonly desiredArchived: boolean;
  readonly requiresDispatch: boolean;
  readonly hasQueuedMessages: boolean;
  readonly messageDispatching: boolean;
  readonly messageProjectionPending: boolean;
  readonly threadBusy: boolean;
}): ThreadLifecycleOutboxAction {
  if (!input.environmentConnected || input.shellStatus !== "live" || !input.messageOutboxReady) {
    return "wait";
  }
  if (
    input.hasQueuedMessages ||
    input.messageDispatching ||
    input.messageProjectionPending ||
    input.threadBusy
  ) {
    return "wait";
  }
  if (!input.threadExists && (input.desiredArchived || !input.requiresDispatch)) {
    return "remove";
  }
  if (input.threadArchived === input.desiredArchived && !input.requiresDispatch) {
    return "remove";
  }
  return input.desiredArchived ? "archive" : "unarchive";
}

function lifecycleIntentAlreadyFulfilled(error: unknown, desiredArchived: boolean): boolean {
  const detail = outboxDeliveryErrorMessages(error).join("\n").toLocaleLowerCase();
  return desiredArchived
    ? detail.includes("already archived") || detail.includes("does not exist")
    : detail.includes("is not archived") || detail.includes("does not exist");
}

export const shouldRetryThreadLifecycleOutboxDelivery = shouldRetryThreadOutboxDelivery;

export type ThreadLifecycleOutboxFailureAction = "retry" | "fulfilled" | "discard";

export function resolveThreadLifecycleOutboxFailureAction(input: {
  readonly error: unknown;
  readonly desiredArchived: boolean;
  readonly interrupted: boolean;
}): ThreadLifecycleOutboxFailureAction {
  if (lifecycleIntentAlreadyFulfilled(input.error, input.desiredArchived)) {
    return "fulfilled";
  }
  if (input.interrupted || shouldRetryThreadLifecycleOutboxDelivery(input.error)) {
    return "retry";
  }
  return "discard";
}

export const threadLifecycleOutboxRetryDelayMs = threadOutboxRetryDelayMs;
