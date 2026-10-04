import { decodeLegacyQueuedThreadMessage } from "@t3tools/client-runtime/state/thread-submission-outbox";

import { decodeQueuedThreadMessage, type QueuedThreadMessage } from "./thread-outbox-model";

/**
 * Decodes one stored outbox row. Rows the fork's client-owned outbox wrote
 * (schema versions 5-9, or inline images without a stored preview) are
 * converted to the current row; `migrated` tells storage to rewrite the file
 * once. The fork's delivery intent becomes the dispatch mode; its grace
 * anchor and settings fallback have no v2 meaning and are dropped.
 */
export function decodeStoredOrLegacyQueuedThreadMessage(value: unknown): {
  readonly message: QueuedThreadMessage;
  readonly migrated: boolean;
} {
  try {
    return { message: decodeQueuedThreadMessage(value), migrated: false };
  } catch (cause) {
    let legacy: ReturnType<typeof decodeLegacyQueuedThreadMessage>;
    try {
      legacy = decodeLegacyQueuedThreadMessage(value);
    } catch {
      throw cause;
    }
    return {
      message: {
        environmentId: legacy.environmentId,
        threadId: legacy.threadId,
        messageId: legacy.messageId,
        commandId: legacy.commandId,
        text: legacy.text,
        ...(legacy.inputOrigin === undefined ? {} : { inputOrigin: legacy.inputOrigin }),
        ...(legacy.context === undefined ? {} : { context: legacy.context }),
        attachments: legacy.attachments,
        ...(legacy.modelSelection === undefined ? {} : { modelSelection: legacy.modelSelection }),
        ...(legacy.runtimeMode === undefined ? {} : { runtimeMode: legacy.runtimeMode }),
        ...(legacy.interactionMode === undefined
          ? {}
          : { interactionMode: legacy.interactionMode }),
        dispatchMode: legacy.dispatchMode,
        ...(legacy.creation === undefined ? {} : { creation: legacy.creation }),
        createdAt: legacy.createdAt,
      },
      migrated: true,
    };
  }
}
