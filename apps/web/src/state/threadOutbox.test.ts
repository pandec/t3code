import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  enqueueThreadSubmission,
  hasPendingThreadSubmission,
  loadThreadOutbox,
  removeThreadSubmission,
  resolveThreadSubmissionOutcome,
  selectThreadSubmissionsToSend,
  type PendingThreadSubmission,
} from "./threadOutbox";

function memoryStorage(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
  };
}

const forkRow = {
  schemaVersion: 9,
  environmentId: "env-1",
  threadId: "thread-1",
  messageId: "legacy-1",
  commandId: "command-legacy-1",
  text: "from the fork",
  attachments: [
    {
      id: "img-1",
      type: "image",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,AAA",
    },
  ],
  runtimeMode: "approval-required",
  interactionMode: "default",
  deliveryIntent: "steer",
  createdAt: "2026-09-01T10:00:00.000Z",
};

function submission(
  messageId: string,
  createdAt: string,
  threadId = "thread-1",
): PendingThreadSubmission {
  return {
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make(threadId),
    commandId: CommandId.make(`command-${messageId}`),
    messageId: MessageId.make(messageId),
    text: messageId,
    attachments: [],
    dispatchMode: "auto",
    createdAt,
  };
}

describe("loadThreadOutbox", () => {
  it("migrates fork outbox rows once and keeps rows web cannot send", () => {
    const storage = memoryStorage({
      "t3code:thread-outbox:v1:legacy-1": JSON.stringify(forkRow),
      "t3code:thread-outbox:v1:legacy-2": JSON.stringify({
        ...forkRow,
        messageId: "legacy-2",
        attachments: [
          {
            id: "f",
            type: "file",
            name: "f.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
            fileUri: "file:///f.txt",
          },
        ],
      }),
    });

    const [migrated, ...rest] = loadThreadOutbox(storage);
    expect(rest).toEqual([]);
    expect(migrated).toMatchObject({
      messageId: "legacy-1",
      commandId: "command-legacy-1",
      dispatchMode: "steer",
      settings: { runtimeMode: "approval-required", interactionMode: "default" },
      attachments: [{ id: "img-1", type: "image", dataUrl: "data:image/png;base64,AAA" }],
    });
    expect(storage.getItem("t3code:thread-outbox:v1:legacy-1")).toBeNull();
    expect(storage.getItem("t3code:thread-outbox:v1:legacy-2")).not.toBeNull();

    // The rewritten row reads back in the current shape.
    expect(loadThreadOutbox(storage)).toEqual([migrated]);
  });
});

describe("enqueueThreadSubmission", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a dictated message's voice origin through storage and drain selection", () => {
    const storage = memoryStorage({});
    vi.stubGlobal("localStorage", storage);
    const voice: PendingThreadSubmission = {
      ...submission("voice", "2026-09-01T10:00:00.000Z"),
      inputOrigin: "voice-transcription",
    };
    expect(enqueueThreadSubmission(voice)).toBe(true);

    const reloaded = loadThreadOutbox(storage);
    expect(reloaded).toEqual([voice]);
    expect(
      selectThreadSubmissionsToSend({
        submissions: reloaded,
        inFlight: new Set(),
        connectedEnvironmentIds: new Set([voice.environmentId]),
        retryAtByMessageId: new Map(),
        nowMs: 0,
      }),
    ).toEqual([voice]);
    removeThreadSubmission(voice.messageId);
  });
});

describe("selectThreadSubmissionsToSend", () => {
  it("sends the oldest row per connected thread and holds the rest behind it", () => {
    const first = submission("a", "2026-09-01T10:00:00.000Z");
    const second = submission("b", "2026-09-01T10:00:01.000Z");
    const otherThread = submission("c", "2026-09-01T10:00:02.000Z", "thread-2");
    const base = {
      submissions: [second, otherThread, first],
      inFlight: new Set<MessageId>(),
      connectedEnvironmentIds: new Set([EnvironmentId.make("env-1")]),
      retryAtByMessageId: new Map<MessageId, number>(),
      nowMs: 1_000,
    };

    expect(selectThreadSubmissionsToSend(base)).toEqual([first, otherThread]);
    expect(
      selectThreadSubmissionsToSend({ ...base, inFlight: new Set([first.messageId]) }),
    ).toEqual([otherThread]);
    expect(
      selectThreadSubmissionsToSend({
        ...base,
        retryAtByMessageId: new Map([[first.messageId, 2_000]]),
      }),
    ).toEqual([otherThread]);
    expect(selectThreadSubmissionsToSend({ ...base, connectedEnvironmentIds: new Set() })).toEqual(
      [],
    );
  });
});

describe("hasPendingThreadSubmission", () => {
  it("keeps a new send behind an older row that is backing off", () => {
    const older = submission("a", "2026-09-01T10:00:00.000Z");
    const environmentId = EnvironmentId.make("env-1");
    expect(hasPendingThreadSubmission([older], environmentId, older.threadId)).toBe(true);
    expect(hasPendingThreadSubmission([older], environmentId, ThreadId.make("thread-2"))).toBe(
      false,
    );

    // The new send is enqueued behind it, so the drain sends neither while it backs off.
    const newer = submission("b", "2026-09-01T10:00:01.000Z");
    const base = {
      submissions: [older, newer],
      inFlight: new Set<MessageId>(),
      connectedEnvironmentIds: new Set([environmentId]),
      retryAtByMessageId: new Map([[older.messageId, 2_000]]),
      nowMs: 1_000,
    };
    expect(selectThreadSubmissionsToSend(base)).toEqual([]);
    expect(selectThreadSubmissionsToSend({ ...base, submissions: [newer] })).toEqual([newer]);
  });
});

describe("resolveThreadSubmissionOutcome", () => {
  it("keeps unconfirmed sends and drops server rejections", () => {
    expect(resolveThreadSubmissionOutcome(null)).toBe("delivered");
    expect(
      resolveThreadSubmissionOutcome({
        interrupted: true,
        error: new Error("Thread was deleted."),
      }),
    ).toBe("retry");
    expect(
      resolveThreadSubmissionOutcome({
        interrupted: false,
        error: new Error("SocketCloseError: closed"),
      }),
    ).toBe("retry");
    expect(
      resolveThreadSubmissionOutcome({
        interrupted: false,
        error: new Error("Thread was deleted."),
      }),
    ).toBe("rejected");
  });
});
