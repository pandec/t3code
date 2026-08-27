import type { CommandId } from "@t3tools/contracts";

const MAX_TRACKED_REQUESTS = 256;
const ownedRequestIds = new Set<CommandId>();

export function markOwnedMessageSpeechRequest(requestId: CommandId): void {
  ownedRequestIds.add(requestId);
  if (ownedRequestIds.size <= MAX_TRACKED_REQUESTS) return;
  const oldest = ownedRequestIds.values().next().value;
  if (oldest !== undefined) ownedRequestIds.delete(oldest);
}

export function forgetOwnedMessageSpeechRequest(requestId: CommandId): void {
  ownedRequestIds.delete(requestId);
}

export function consumeOwnedMessageSpeechRequest(requestId: CommandId): boolean {
  const owned = ownedRequestIds.has(requestId);
  ownedRequestIds.delete(requestId);
  return owned;
}
