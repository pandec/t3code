import type { ThreadLifecycleIntent } from "@t3tools/client-runtime/state/thread-lifecycle-outbox-model";

export async function prepareThreadLifecycleDispatch(options: {
  readonly intent: ThreadLifecycleIntent;
  readonly markDispatchAttempted: (
    intent: ThreadLifecycleIntent,
  ) => Promise<ThreadLifecycleIntent | null>;
  readonly confirmCurrent: (intent: ThreadLifecycleIntent) => Promise<boolean>;
}): Promise<ThreadLifecycleIntent | null> {
  const attempted = await options.markDispatchAttempted(options.intent);
  if (attempted === null || !(await options.confirmCurrent(attempted))) return null;
  return attempted;
}
