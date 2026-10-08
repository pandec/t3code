import {
  scopeThreadShell,
  type EnvironmentShellStatus,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { scopedThreadKey } from "../lib/scopedEntities";
import { shouldRetryThreadOutboxDelivery } from "./thread-outbox-model";

/**
 * Fork: archive/unarchive done on the phone while its environment is
 * disconnected. Each thread keeps at most one durable intent (its latest
 * revision), presented optimistically and applied on reconnect.
 */
const THREAD_LIFECYCLE_OUTBOX_SCHEMA_VERSION = 2;

const ThreadLifecycleIntentSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1, THREAD_LIFECYCLE_OUTBOX_SCHEMA_VERSION]),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  desiredArchived: Schema.Boolean,
  requiresDispatch: Schema.Boolean,
  dispatchAttempted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  dispatchedAction: Schema.NullOr(Schema.Literals(["archive", "unarchive", "cancel-archive"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  commandId: CommandId,
  createdAt: IsoDateTime,
  /** v2 shell source captured at enqueue, so the row renders while it is out of the shell. */
  thread: Schema.NullOr(OrchestrationV2ThreadShell),
});

const decodeStoredThreadLifecycleIntent = Schema.decodeUnknownSync(ThreadLifecycleIntentSchema);
const encodeStoredThreadLifecycleIntent = Schema.encodeUnknownSync(ThreadLifecycleIntentSchema);

export interface ThreadLifecycleIntent {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly desiredArchived: boolean;
  /**
   * An earlier revision in this chain may have reached the server, so its
   * reversal must be sent; carries over until the intent is removed.
   */
  readonly requiresDispatch: boolean;
  /** Persisted before this revision's command may be sent. */
  readonly dispatchAttempted: boolean;
  /** The action the attempt was persisted for; this command id is bound to it. */
  readonly dispatchedAction: ThreadLifecycleDispatchAction | null;
  readonly commandId: CommandId;
  readonly createdAt: string;
  readonly thread: OrchestrationV2ThreadShell | null;
}

export function encodeThreadLifecycleIntent(intent: ThreadLifecycleIntent): unknown {
  return encodeStoredThreadLifecycleIntent({
    schemaVersion: THREAD_LIFECYCLE_OUTBOX_SCHEMA_VERSION,
    ...intent,
  });
}

/**
 * Version 1 rows (pre-v2 fork) embed a v1 thread shell that no longer
 * decodes; their intent still applies, only the display snapshot is lost.
 */
export function decodeThreadLifecycleIntent(value: unknown): ThreadLifecycleIntent {
  const stored =
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 1
      ? { ...value, thread: null }
      : value;
  const { schemaVersion: _, ...intent } = decodeStoredThreadLifecycleIntent(stored);
  return intent;
}

export const threadLifecycleIntentKey = scopedThreadKey;

/**
 * Archive/unarchive revise an existing intent whatever the connection state,
 * so a direct command never races a pending reversal; with no intent, only a
 * disconnected archive queues one.
 */
export function threadLifecycleActionUsesOutbox(input: {
  readonly action: string;
  readonly environmentConnected: boolean;
  readonly hasIntent: boolean;
}): boolean {
  if (input.action === "archive") return !input.environmentConnected || input.hasIntent;
  return input.action === "unarchive" && input.hasIntent;
}

export function threadLifecycleRevisionRequiresDispatch(
  previous: ThreadLifecycleIntent | undefined,
): boolean {
  return previous?.requiresDispatch === true || previous?.dispatchAttempted === true;
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

/**
 * `archive` is sent as an archive-when-done request, so a thread that became
 * busy while the phone was offline archives after its turn instead of being
 * interrupted. `cancel-archive` withdraws such a pending request.
 */
export type ThreadLifecycleOutboxAction =
  | "wait"
  | "remove"
  | "archive"
  | "unarchive"
  | "cancel-archive";

export type ThreadLifecycleDispatchAction = Exclude<ThreadLifecycleOutboxAction, "wait" | "remove">;

/**
 * A connection's grant of one scope: "loading" until its session first loads,
 * "unverified" when that load failed with no cached grant.
 */
export type ScopeGrant = "granted" | "denied" | "loading" | "unverified";

export function resolveThreadLifecycleOutboxAction(input: {
  readonly environmentConnected: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  /** Messages for this thread still in the local outbox go first. */
  readonly hasQueuedMessages: boolean;
  /**
   * The connection's operate grant. Offline enqueues cannot check it, so an
   * intent waits for the grant to load and is dropped when it is denied: the
   * server would refuse every dispatch, and dropping restores the real state.
   * Denial wins over queued messages, which the same grant also holds back.
   * An unverified grant dispatches and leaves the decision to the server.
   */
  readonly operateGrant: ScopeGrant;
  readonly thread: Pick<EnvironmentThreadShell, "archivedAt" | "archiveRequest"> | undefined;
  readonly desiredArchived: boolean;
  readonly requiresDispatch: boolean;
}): ThreadLifecycleOutboxAction {
  if (
    !input.environmentConnected ||
    input.shellStatus !== "live" ||
    input.operateGrant === "loading"
  ) {
    return "wait";
  }
  if (input.operateGrant === "denied") return "remove";
  if (input.hasQueuedMessages) return "wait";
  const { thread } = input;
  // Live shells omit archived (and deleted) threads.
  if (thread === undefined) {
    if (!input.desiredArchived) return "unarchive";
    // An earlier reversal may have landed without the shell showing it yet.
    return input.requiresDispatch ? "archive" : "remove";
  }
  const archived = thread.archivedAt !== null;
  const archivePending = !archived && thread.archiveRequest?.status === "pending";
  if (input.desiredArchived) {
    return (archived || archivePending) && !input.requiresDispatch ? "remove" : "archive";
  }
  // Only cancel a pending archive one of our earlier revisions may have created.
  if (archivePending) return input.requiresDispatch ? "cancel-archive" : "remove";
  return !archived && !input.requiresDispatch ? "remove" : "unarchive";
}

/**
 * Holds an environment's intents back after one of our commands succeeds
 * until the live shell has applied that command's events: the shell stream
 * lags dispatch responses, and the next revision must decide against state
 * that includes the command (e.g. Undo seeing the deferred archive it cancels).
 */
export function createThreadLifecycleDispatchFence() {
  const sequences = new Map<EnvironmentId, number>();
  return {
    record: (environmentId: EnvironmentId, sequence: number): void => {
      sequences.set(environmentId, Math.max(sequences.get(environmentId) ?? 0, sequence));
    },
    /** Whether the shell has not yet applied our last dispatched command. */
    holds: (environmentId: EnvironmentId, shellSequence: number | null): boolean => {
      const sequence = sequences.get(environmentId);
      return sequence !== undefined && (shellSequence === null || shellSequence < sequence);
    },
  };
}

export type ThreadLifecycleOutboxFailureAction = "retry" | "rotate" | "remove";

/**
 * Transport failures retry the same command. A rejected command id never runs
 * again, so state-dependent rejections retry under a fresh id ("rotate"): a
 * schedule is rejected while runs are queued, and a cancel once the archive
 * has landed (the retry then unarchives). Other rejections make the intent moot.
 */
export function resolveThreadLifecycleOutboxFailureAction(input: {
  readonly error: unknown;
  readonly interrupted: boolean;
  readonly action: ThreadLifecycleDispatchAction;
  readonly threadActive: boolean;
}): ThreadLifecycleOutboxFailureAction {
  if (input.interrupted || shouldRetryThreadOutboxDelivery(input.error)) return "retry";
  if (input.action === "cancel-archive" || (input.action === "archive" && input.threadActive)) {
    return "rotate";
  }
  return "remove";
}

export interface ThreadLifecyclePresentation {
  readonly activeThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingArchivedThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingArchivedThreadKeys: ReadonlySet<string>;
}

/**
 * Overlays pending intents on the canonical (unarchived) shells: a pending
 * archive leaves the active list for the archived shelf, a pending unarchive
 * returns to the active list.
 */
export function deriveThreadLifecyclePresentation(
  canonicalThreads: ReadonlyArray<EnvironmentThreadShell>,
  intents: Readonly<Record<string, ThreadLifecycleIntent>>,
): ThreadLifecyclePresentation {
  if (Object.keys(intents).length === 0) {
    return {
      activeThreads: canonicalThreads,
      pendingArchivedThreads: [],
      pendingArchivedThreadKeys: new Set(),
    };
  }
  const activeByKey = new Map(
    canonicalThreads.map((thread) => [
      threadLifecycleIntentKey(thread.environmentId, thread.id),
      thread,
    ]),
  );
  const pendingArchivedThreads: EnvironmentThreadShell[] = [];
  const pendingArchivedThreadKeys = new Set<string>();

  for (const [key, intent] of Object.entries(intents)) {
    const shell =
      activeByKey.get(key) ??
      (intent.thread === null ? undefined : scopeThreadShell(intent.environmentId, intent.thread));
    if (intent.desiredArchived) {
      activeByKey.delete(key);
      pendingArchivedThreadKeys.add(key);
      if (shell !== undefined)
        pendingArchivedThreads.push({ ...shell, archivedAt: intent.createdAt });
      continue;
    }
    if (shell !== undefined) activeByKey.set(key, { ...shell, archivedAt: null });
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

/** Puts pending archives at the top of the server's recent archived shelf. */
export function mergePendingArchivedThreads(
  serverArchive: {
    readonly threads: ReadonlyArray<EnvironmentThreadShell>;
    readonly totalCount: number;
  },
  pendingThreads: ReadonlyArray<EnvironmentThreadShell>,
  visibleCount: number,
  selectedThreadKey: string | null = null,
): { readonly threads: ReadonlyArray<EnvironmentThreadShell>; readonly totalCount: number } {
  if (pendingThreads.length === 0) return serverArchive;
  const keyOf = (thread: EnvironmentThreadShell) =>
    threadLifecycleIntentKey(thread.environmentId, thread.id);
  const pendingKeys = new Set(pendingThreads.map(keyOf));
  const combined = [
    ...pendingThreads,
    ...serverArchive.threads.filter((thread) => !pendingKeys.has(keyOf(thread))),
  ];
  const clipped = combined.slice(0, Math.max(0, visibleCount));
  if (
    selectedThreadKey !== null &&
    !clipped.some((thread) => keyOf(thread) === selectedThreadKey)
  ) {
    const selected = combined.find((thread) => keyOf(thread) === selectedThreadKey);
    if (selected !== undefined) clipped.push(selected);
  }
  const serverPendingOverlap = serverArchive.threads.filter((thread) =>
    pendingKeys.has(keyOf(thread)),
  ).length;
  return {
    threads: clipped,
    totalCount: serverArchive.totalCount + pendingThreads.length - serverPendingOverlap,
  };
}
