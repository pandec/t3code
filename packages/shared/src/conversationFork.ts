export const THREAD_FORK_FAILURE_PREFIX = "Conversation fork failed: ";

export function isThreadForkFailure(lastError: string | null | undefined): boolean {
  return lastError?.startsWith(THREAD_FORK_FAILURE_PREFIX) ?? false;
}
