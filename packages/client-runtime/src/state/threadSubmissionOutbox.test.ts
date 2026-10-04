import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeLegacyQueuedThreadMessage,
  isRetryableThreadSubmissionError,
} from "./threadSubmissionOutbox.ts";

const legacyRow = {
  schemaVersion: 9,
  environmentId: "env-1",
  threadId: "thread-1",
  messageId: "message-1",
  commandId: "command-1",
  text: "hello",
  inputOrigin: "voice-transcription",
  attachments: [
    {
      id: "inline",
      type: "image",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,AAA",
    },
    {
      id: "file-backed",
      type: "image",
      name: "b.png",
      mimeType: "image/png",
      sizeBytes: 3,
      fileUri: "file:///outbox/b.png",
    },
  ],
  runtimeMode: "approval-required",
  deliveryIntent: "steer",
  graceStartedAt: "2026-09-01T10:00:01.000Z",
  threadSettings: { branch: null },
  createdAt: "2026-09-01T10:00:00.000Z",
};

describe("decodeLegacyQueuedThreadMessage", () => {
  it("keeps the fork row's content and maps its delivery intent", () => {
    const message = decodeLegacyQueuedThreadMessage(legacyRow);
    expect(message.dispatchMode).toBe("steer");
    expect(message.inputOrigin).toBe("voice-transcription");
    expect(message.runtimeMode).toBe("approval-required");
    expect(message.attachments).toEqual([
      expect.objectContaining({ id: "inline", previewUri: "data:image/png;base64,AAA" }),
      expect.objectContaining({
        id: "file-backed",
        fileUri: "file:///outbox/b.png",
        previewUri: "file:///outbox/b.png",
      }),
    ]);
    expect(message).not.toHaveProperty("graceStartedAt");
    expect(message).not.toHaveProperty("threadSettings");
  });

  it("reads rows written before delivery intents as queued", () => {
    const { deliveryIntent: _, ...row } = legacyRow;
    expect(decodeLegacyQueuedThreadMessage({ ...row, schemaVersion: 4 }).dispatchMode).toBe(
      "queue",
    );
  });

  it("rejects rows that are not fork outbox rows", () => {
    expect(() => decodeLegacyQueuedThreadMessage({ ...legacyRow, schemaVersion: 10 })).toThrow();
  });
});

describe("isRetryableThreadSubmissionError", () => {
  it("keeps transport failures and drops server decisions", () => {
    expect(isRetryableThreadSubmissionError(new Error("SocketCloseError: connection closed"))).toBe(
      true,
    );
    expect(isRetryableThreadSubmissionError({ _tag: "EnvironmentRpcUnavailableError" })).toBe(true);
    expect(
      isRetryableThreadSubmissionError(
        new OrchestrationDispatchCommandError({ message: "Thread was deleted." }),
      ),
    ).toBe(false);
    expect(isRetryableThreadSubmissionError(new Error("Thread was deleted."))).toBe(false);
  });
});
