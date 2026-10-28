import { describe, expect, it } from "vite-plus/test";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { deriveTimelineMinimapItems } from "./MessagesTimeline.minimap";

describe("deriveTimelineMinimapItems", () => {
  it("previews a thread autolink as prose, not its URL", () => {
    const rows = [
      {
        kind: "message",
        id: "turn-1",
        message: {
          id: "turn-1",
          role: "assistant",
          text: "Started <t3-thread://v2/env-1/thread-1> and <https://example.com>.",
          streaming: false,
        },
        isFinalAssistantResponse: true,
      },
    ] as unknown as ReadonlyArray<MessagesTimelineRow>;
    expect(deriveTimelineMinimapItems(rows, "final-assistant")[0]?.primaryText).toBe(
      "Started a thread and <https://example.com>.",
    );
  });
});
