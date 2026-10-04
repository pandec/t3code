import { describe, expect, it } from "@effect/vitest";

import { decodeStoredOrLegacyQueuedThreadMessage } from "./thread-outbox-legacy";
import { decodeQueuedThreadMessage, encodeQueuedThreadMessage } from "./thread-outbox-model";

const forkRow = {
  schemaVersion: 9,
  environmentId: "env-1",
  threadId: "thread-1",
  messageId: "message-1",
  commandId: "command-1",
  text: "[Build](t3-context://v1/terminal/build-output)",
  inputOrigin: "voice-transcription",
  context: {
    version: 1,
    records: [
      {
        version: 1,
        kind: "terminal",
        contextId: "build-output",
        label: "Build",
        terminalId: "main",
        terminalLabel: "Terminal",
        lineStart: 2,
        lineEnd: 2,
        text: "Build failed",
      },
    ],
  },
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
      id: "pasted",
      type: "file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      fileUri: "file:///composer-attachments/notes.txt",
    },
  ],
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "approval-required",
  interactionMode: "plan",
  deliveryIntent: "steer",
  localCheckoutBranch: "feature",
  graceStartedAt: "2026-09-01T10:00:01.000Z",
  createdAt: "2026-09-01T10:00:00.000Z",
};

describe("decodeStoredOrLegacyQueuedThreadMessage", () => {
  it("migrates a fork outbox row into a current row that survives a storage round trip", () => {
    const { message, migrated } = decodeStoredOrLegacyQueuedThreadMessage(forkRow);
    expect(migrated).toBe(true);
    expect(message).toMatchObject({
      messageId: "message-1",
      commandId: "command-1",
      text: forkRow.text,
      inputOrigin: "voice-transcription",
      context: forkRow.context,
      modelSelection: forkRow.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      dispatchMode: "steer",
    });
    expect(message.attachments).toEqual([
      expect.objectContaining({ id: "inline", previewUri: "data:image/png;base64,AAA" }),
      expect.objectContaining({ id: "pasted", fileUri: "file:///composer-attachments/notes.txt" }),
    ]);
    const rewritten = JSON.parse(JSON.stringify(encodeQueuedThreadMessage(message))) as unknown;
    expect(decodeQueuedThreadMessage(rewritten)).toEqual(message);
    expect(decodeStoredOrLegacyQueuedThreadMessage(rewritten).migrated).toBe(false);
  });

  it("keeps an unreadable row an error", () => {
    expect(() => decodeStoredOrLegacyQueuedThreadMessage({ schemaVersion: 9 })).toThrow();
  });
});
