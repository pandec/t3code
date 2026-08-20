import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  OrchestrationThreadShell,
  ThreadId,
  type OrchestrationThreadShell as OrchestrationThreadShellType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { isTransportConnectionErrorMessage } from "../errors/index.ts";
import type { EnvironmentShellStatus } from "./shell.ts";
import { threadOutboxRetryDelayMs } from "./threadOutboxModel.ts";

const THREAD_LIFECYCLE_OUTBOX_SCHEMA_VERSION = 1;

export const ThreadLifecycleIntentSchema = Schema.Struct({
  schemaVersion: Schema.Literal(THREAD_LIFECYCLE_OUTBOX_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  desiredArchived: Schema.Boolean,
  requiresDispatch: Schema.Boolean,
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
  /** Reversals dispatch even when the live shell still shows the baseline state. */
  readonly requiresDispatch: boolean;
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

export function threadLifecycleIntentKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}:${threadId}`;
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
  readonly threadExists: boolean;
  readonly threadArchived: boolean;
  readonly desiredArchived: boolean;
  readonly requiresDispatch: boolean;
  readonly hasQueuedMessages: boolean;
  readonly messageDispatching: boolean;
  readonly hasActiveTurn: boolean;
}): ThreadLifecycleOutboxAction {
  if (!input.environmentConnected || input.shellStatus !== "live") {
    return "wait";
  }
  if (!input.threadExists && (input.desiredArchived || !input.requiresDispatch)) {
    return "remove";
  }
  if (input.threadArchived === input.desiredArchived && !input.requiresDispatch) {
    return "remove";
  }
  if (input.hasQueuedMessages || input.messageDispatching || input.hasActiveTurn) {
    return "wait";
  }
  return input.desiredArchived ? "archive" : "unarchive";
}

function errorMessages(error: unknown): ReadonlyArray<string> {
  const messages: string[] = [];
  const visited = new Set<object>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > 5) return;
    if (typeof value === "string") {
      messages.push(value);
      return;
    }
    if (typeof value !== "object" || value === null || visited.has(value)) {
      return;
    }
    visited.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ["message", "detail", "cause", "error"] as const) {
      if (key in record) visit(record[key], depth + 1);
    }
  };

  visit(error, 0);
  return messages;
}

function lifecycleIntentAlreadyFulfilled(error: unknown, desiredArchived: boolean): boolean {
  const detail = errorMessages(error).join("\n").toLocaleLowerCase();
  return desiredArchived
    ? detail.includes("already archived") || detail.includes("does not exist")
    : detail.includes("is not archived") || detail.includes("does not exist");
}

export function shouldRetryThreadLifecycleOutboxDelivery(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ConnectionTransientError"
  ) {
    return true;
  }
  return errorMessages(error).some(isTransportConnectionErrorMessage);
}

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
