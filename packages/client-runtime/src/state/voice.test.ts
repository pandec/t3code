import { describe, expect, it } from "vite-plus/test";

import { MessageId, ThreadId } from "@t3tools/contracts";
import { messageArtifactTextHash } from "@t3tools/shared/messageArtifactIdentity";

import { currentThreadMessageSummary, toMessageSpeechThreadView } from "./voice.ts";

describe("thread message summaries", () => {
  it("serves a stored summary only while it summarizes the shown text", () => {
    const messageId = MessageId.make("message-summary-hydrated");
    const view = toMessageSpeechThreadView({
      threadId: ThreadId.make("thread-summary-hydrated"),
      recordings: [],
      pendingMessageIds: [],
      summaries: [
        {
          messageId,
          summary: "Short version.",
          createdAt: "2026-01-01T00:00:00.000Z",
          sourceTextHash: messageArtifactTextHash("The long answer."),
        },
      ],
    });

    expect(currentThreadMessageSummary(view, messageId, "  The long answer. ")).toEqual({
      messageId,
      summary: "Short version.",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(currentThreadMessageSummary(view, messageId, "An edited answer.")).toBeNull();
    expect(currentThreadMessageSummary(undefined, messageId, "The long answer.")).toBeNull();
  });
});
