import { describe, expect, it } from "vite-plus/test";

import { MessageId, ThreadId } from "@t3tools/contracts";
import { messageArtifactTextHash } from "@t3tools/shared/messageArtifactIdentity";

import {
  applyMessageSpeechThreadUpdate,
  currentThreadMessageSummary,
  toMessageSpeechThreadView,
} from "./voice.ts";

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

describe("thread listening updates", () => {
  it("replaces one message's entries and starts over at every snapshot", () => {
    const threadId = ThreadId.make("thread-updates");
    const kept = MessageId.make("message-kept");
    const changed = MessageId.make("message-changed");
    const recording = (messageId: MessageId) => ({
      messageId,
      speechId: `speech-${messageId}`,
      transcript: "Spoken.",
      mimeType: "audio/mpeg" as const,
      sizeBytes: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const snapshot = {
      type: "snapshot" as const,
      state: {
        threadId,
        recordings: [recording(kept), recording(changed)],
        pendingMessageIds: [],
        summaries: [],
      },
    };

    // Message updates before the first snapshot have nothing to apply to.
    expect(
      applyMessageSpeechThreadUpdate(null, {
        type: "message",
        threadId,
        messageId: changed,
        pending: true,
      }),
    ).toBeNull();
    const view = applyMessageSpeechThreadUpdate(null, snapshot);
    const pending = applyMessageSpeechThreadUpdate(view, {
      type: "message",
      threadId,
      messageId: changed,
      pending: true,
    });
    expect([...(pending?.recordings.keys() ?? [])]).toEqual([kept]);
    expect([...(pending?.pending ?? [])]).toEqual([changed]);

    const done = applyMessageSpeechThreadUpdate(pending, {
      type: "message",
      threadId,
      messageId: changed,
      recording: recording(changed),
      pending: false,
    });
    expect([...(done?.recordings.keys() ?? [])]).toEqual([kept, changed]);
    expect(done?.pending.size).toBe(0);
    expect(applyMessageSpeechThreadUpdate(done, snapshot)).toEqual(view);
  });
});
