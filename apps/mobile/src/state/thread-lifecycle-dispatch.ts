import type {
  ThreadLifecycleIntent,
  ThreadLifecycleOutboxAction,
} from "@t3tools/client-runtime/state/thread-lifecycle-outbox-model";

export interface PreparedThreadLifecycleDispatch {
  readonly intent: ThreadLifecycleIntent;
  readonly action: ThreadLifecycleOutboxAction;
}

export async function prepareThreadLifecycleDispatch(options: {
  readonly intent: ThreadLifecycleIntent;
  readonly markDispatchAttempted: (
    intent: ThreadLifecycleIntent,
  ) => Promise<ThreadLifecycleIntent | null>;
  readonly confirmCurrent: (intent: ThreadLifecycleIntent) => Promise<boolean>;
  readonly readCurrentAction: (intent: ThreadLifecycleIntent) => ThreadLifecycleOutboxAction;
}): Promise<PreparedThreadLifecycleDispatch | null> {
  const attempted = await options.markDispatchAttempted(options.intent);
  if (attempted === null || !(await options.confirmCurrent(attempted))) return null;
  return { intent: attempted, action: options.readCurrentAction(attempted) };
}
