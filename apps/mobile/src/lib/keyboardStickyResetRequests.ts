export type KeyboardStickyResetRequestReason = "message-send";

export type KeyboardStickyResetRequestHandler = (
  reason: KeyboardStickyResetRequestReason,
) => boolean;

const handlers = new Set<KeyboardStickyResetRequestHandler>();

export function subscribeKeyboardStickyResetRequests(
  handler: KeyboardStickyResetRequestHandler,
): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function requestKeyboardStickyReset(reason: KeyboardStickyResetRequestReason): boolean {
  let handled = false;
  for (const handler of Array.from(handlers)) {
    try {
      handled = handler(reason) || handled;
    } catch {
      // A recovery subscriber must never turn an already successful send into
      // a failure or prevent other mounted coordinators from handling it.
    }
  }
  return handled;
}
