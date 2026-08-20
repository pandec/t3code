import type { ThreadOutboxLoadState } from "@t3tools/client-runtime/state/thread-outbox-manager";

export const THREAD_OUTBOX_HYDRATION_MAX_RETRIES = 3;

export type ThreadOutboxHydrationAction = "load" | "wait" | "retry" | "deliver";

export function resolveThreadOutboxHydrationAction(
  loadState: ThreadOutboxLoadState,
  retryAttempts: number,
): ThreadOutboxHydrationAction {
  if (loadState.status === "ready") return "deliver";
  if (loadState.status === "idle") return "load";
  if (loadState.status === "loading") return "wait";
  return retryAttempts >= THREAD_OUTBOX_HYDRATION_MAX_RETRIES ? "deliver" : "retry";
}
