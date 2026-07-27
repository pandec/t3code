import { afterEach, describe, expect, it } from "@effect/vitest";
import { MessageId } from "@t3tools/contracts";
import { vi } from "vite-plus/test";

vi.mock("./shell", () => ({
  environmentShell: {
    stateValueAtom: () => {
      throw new Error("not used by edit-hold tests");
    },
  },
}));

import { appAtomRegistry } from "./atom-registry";
import {
  editingQueuedMessageIdsAtom,
  ensureEditingQueuedMessageHeld,
  holdEditingQueuedMessage,
  releaseEditingQueuedMessage,
} from "./use-thread-outbox";

afterEach(() => {
  appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
});

describe("mobile queued-message edit holds", () => {
  it("distinguishes exclusive acquisition from an adoptable retained latch", () => {
    const exclusiveId = MessageId.make("exclusive");
    expect(holdEditingQueuedMessage(exclusiveId)).toBe(true);
    expect(holdEditingQueuedMessage(exclusiveId)).toBe(false);
    releaseEditingQueuedMessage(exclusiveId);

    const retainedId = MessageId.make("retained");
    ensureEditingQueuedMessageHeld(retainedId);
    ensureEditingQueuedMessageHeld(retainedId);
    expect(holdEditingQueuedMessage(retainedId)).toBe(false);
    releaseEditingQueuedMessage(retainedId);
    expect(appAtomRegistry.get(editingQueuedMessageIdsAtom)).toEqual({});
  });
});
