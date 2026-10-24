import { beforeEach, describe, expect, it } from "vite-plus/test";

import { usePinnedMessageStore } from "./pinnedMessageStore";

beforeEach(() => {
  usePinnedMessageStore.setState({ pinnedMessageIdsByThreadKey: {} });
});

describe("pinnedMessageStore", () => {
  it("toggles pins per thread and drops a thread once its last pin is removed", () => {
    const { togglePinnedMessage } = usePinnedMessageStore.getState();
    togglePinnedMessage("env:thread-a", "message-1");
    togglePinnedMessage("env:thread-a", "message-2");
    togglePinnedMessage("env:thread-b", "message-1");

    expect(usePinnedMessageStore.getState().pinnedMessageIdsByThreadKey).toEqual({
      "env:thread-a": ["message-1", "message-2"],
      "env:thread-b": ["message-1"],
    });

    togglePinnedMessage("env:thread-a", "message-1");
    togglePinnedMessage("env:thread-b", "message-1");

    expect(usePinnedMessageStore.getState().pinnedMessageIdsByThreadKey).toEqual({
      "env:thread-a": ["message-2"],
    });
  });

  it("drops malformed stored pins on hydration", () => {
    const merge = usePinnedMessageStore.persist.getOptions().merge!;
    const current = usePinnedMessageStore.getState();

    expect(
      merge({ pinnedMessageIdsByThreadKey: null }, current).pinnedMessageIdsByThreadKey,
    ).toEqual({});
    expect(
      merge({ pinnedMessageIdsByThreadKey: { a: ["m1", 2], b: "m2", c: [] } }, current)
        .pinnedMessageIdsByThreadKey,
    ).toEqual({ a: ["m1"] });
  });
});
