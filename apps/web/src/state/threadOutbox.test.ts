import { afterEach, describe, expect, it } from "@effect/vitest";
import { MessageId } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  editingQueuedMessageIdsAtom,
  holdEditingQueuedMessage,
  releaseEditingQueuedMessage,
} from "./threadOutbox";

afterEach(() => {
  appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
});

describe("web queued-message edit holds", () => {
  it("grants one exclusive owner until release", () => {
    const messageId = MessageId.make("queued-message");
    expect(holdEditingQueuedMessage(messageId)).toBe(true);
    expect(holdEditingQueuedMessage(messageId)).toBe(false);
    releaseEditingQueuedMessage(messageId);
    expect(holdEditingQueuedMessage(messageId)).toBe(true);
  });
});
