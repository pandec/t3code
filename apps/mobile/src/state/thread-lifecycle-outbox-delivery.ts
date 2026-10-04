import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import type { ThreadLifecycleOutboxManager } from "./thread-lifecycle-outbox-manager";
import {
  resolveThreadLifecycleOutboxFailureAction,
  type ThreadLifecycleIntent,
  type ThreadLifecycleOutboxAction,
} from "./thread-lifecycle-outbox-model";

export type ThreadLifecycleDispatchAction = Exclude<ThreadLifecycleOutboxAction, "wait" | "remove">;

export interface ThreadLifecycleDeliveryDeps {
  readonly manager: Pick<
    ThreadLifecycleOutboxManager,
    "confirmCurrent" | "markDispatchAttempted" | "removeIfCurrent"
  >;
  /** Same-thread messages queued earlier must be visible before deciding. */
  readonly loadMessageOutbox: () => Promise<boolean>;
  /** The action for the intent against current state. */
  readonly readAction: (intent: ThreadLifecycleIntent) => ThreadLifecycleOutboxAction;
  readonly dispatch: (
    action: ThreadLifecycleDispatchAction,
    intent: ThreadLifecycleIntent,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly onSettled: (intent: ThreadLifecycleIntent) => void;
}

/**
 * Delivers one intent. Resolves false when it should be retried later. The
 * action is re-read after every await because the user can revise the intent
 * (Undo) or the thread can change while a step is pending.
 */
export async function deliverThreadLifecycleIntent(
  intent: ThreadLifecycleIntent,
  deps: ThreadLifecycleDeliveryDeps,
): Promise<boolean> {
  const removeCurrent = async (candidate: ThreadLifecycleIntent): Promise<boolean> => {
    try {
      await deps.manager.removeIfCurrent(candidate);
      return true;
    } catch (error) {
      console.warn("[thread-lifecycle-outbox] failed to remove intent", {
        environmentId: candidate.environmentId,
        threadId: candidate.threadId,
        commandId: candidate.commandId,
        error,
      });
      return false;
    }
  };

  if (!(await deps.loadMessageOutbox())) return false;
  if (!(await deps.manager.confirmCurrent(intent))) return true;
  const action = deps.readAction(intent);
  if (action === "wait") return true;
  if (action === "remove") return removeCurrent(intent);

  // Persist the attempt first: a later reversal must then be sent even if
  // this command's outcome is never observed.
  let attempted: ThreadLifecycleIntent | null;
  try {
    attempted = await deps.manager.markDispatchAttempted(intent);
    if (attempted !== null && !(await deps.manager.confirmCurrent(attempted))) attempted = null;
  } catch (error) {
    console.warn("[thread-lifecycle-outbox] failed to persist dispatch attempt", {
      environmentId: intent.environmentId,
      threadId: intent.threadId,
      commandId: intent.commandId,
      error,
    });
    return false;
  }
  if (attempted === null) return true;

  const finalAction = deps.readAction(attempted);
  if (finalAction === "wait") return true;
  if (finalAction === "remove") return removeCurrent(attempted);

  const result = await deps.dispatch(finalAction, attempted);
  if (AsyncResult.isSuccess(result)) {
    deps.onSettled(attempted);
    return removeCurrent(attempted);
  }
  const failureAction = resolveThreadLifecycleOutboxFailureAction({
    error: Cause.squash(result.cause),
    interrupted: Cause.hasInterruptsOnly(result.cause),
  });
  console.warn("[thread-lifecycle-outbox] lifecycle delivery failed", {
    environmentId: attempted.environmentId,
    threadId: attempted.threadId,
    commandId: attempted.commandId,
    action: finalAction,
    failureAction,
    cause: result.cause,
  });
  if (failureAction === "retry") return false;
  deps.onSettled(attempted);
  return removeCurrent(attempted);
}
