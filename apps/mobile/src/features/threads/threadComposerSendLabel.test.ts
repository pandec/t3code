import { describe, expect, it } from "vite-plus/test";

import { threadComposerSendLabel } from "./threadComposerSendLabel";

describe("threadComposerSendLabel", () => {
  it.each([
    {
      name: "connected running turn",
      input: { sessionStatus: "running", connectionState: "connected", queueCount: 0 },
      expected: "Steer",
    },
    {
      name: "offline running turn with queued work",
      input: { sessionStatus: "running", connectionState: "offline", queueCount: 2 },
      expected: "Steer",
    },
    {
      name: "connected starting turn",
      input: { sessionStatus: "starting", connectionState: "connected", queueCount: 0 },
      expected: "Steer",
    },
    {
      name: "connected thread without a session",
      input: { sessionStatus: null, connectionState: "connected", queueCount: 0 },
      expected: "Send",
    },
    {
      name: "idle thread with queued work",
      input: { sessionStatus: "idle", connectionState: "connected", queueCount: 1 },
      expected: "Queue",
    },
    {
      name: "reconnecting idle thread",
      input: { sessionStatus: "idle", connectionState: "reconnecting", queueCount: 0 },
      expected: "Queue",
    },
  ] as const)("$name labels the action $expected", ({ input, expected }) => {
    expect(threadComposerSendLabel(input)).toBe(expected);
  });
});
