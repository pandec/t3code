import { beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { buildOpenInSplitThreadItems } from "./splitPaletteItems";
import { useThreadSplitStore } from "./threadSplitStore";

const threadRef = (environmentId: string, threadId: string) => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
});

function threadItem(value: string): CommandPaletteActionItem {
  return {
    kind: "action",
    value,
    searchTerms: [value],
    title: value,
    icon: null,
    run: async () => undefined,
  };
}

beforeEach(() => {
  useThreadSplitStore.setState({
    secondaryRef: null,
    splitMounted: false,
    activePaneId: "primary",
    splitRatio: 0.5,
  });
});

describe("buildOpenInSplitThreadItems", () => {
  it("rebinds thread items to open in the secondary pane", async () => {
    const items = buildOpenInSplitThreadItems({
      threadItems: [threadItem("thread:env-a:thread-1"), threadItem("action:new-thread")],
      routeThreadRef: null,
      secondaryRef: null,
    });

    expect(items.map((item) => item.value)).toEqual(["open-in-split:env-a:thread-1"]);
    await items[0]?.run();
    expect(useThreadSplitStore.getState().secondaryRef).toEqual(threadRef("env-a", "thread-1"));
    expect(useThreadSplitStore.getState().activePaneId).toBe("secondary");
  });

  it("excludes the routed thread and the current secondary thread", () => {
    const items = buildOpenInSplitThreadItems({
      threadItems: [
        threadItem("thread:env-a:thread-1"),
        threadItem("thread:env-a:thread-2"),
        threadItem("thread:env-b:thread-1"),
      ],
      routeThreadRef: threadRef("env-a", "thread-1"),
      secondaryRef: threadRef("env-a", "thread-2"),
    });

    // Same bare thread id in another environment stays offered.
    expect(items.map((item) => item.value)).toEqual(["open-in-split:env-b:thread-1"]);
  });
});
