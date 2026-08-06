import { describe, expect, it } from "vite-plus/test";

import {
  requestKeyboardStickyReset,
  subscribeKeyboardStickyResetRequests,
} from "./keyboardStickyResetRequests";

describe("keyboard sticky reset requests", () => {
  it("reports unhandled requests without subscribers", () => {
    expect(requestKeyboardStickyReset("message-send")).toBe(false);
  });

  it("reports unhandled when every subscriber declines", () => {
    const unsubscribe = subscribeKeyboardStickyResetRequests(() => false);
    try {
      expect(requestKeyboardStickyReset("message-send")).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it("notifies multiple subscribers and reports whether one handled the request", () => {
    const calls: string[] = [];
    const unsubscribeFirst = subscribeKeyboardStickyResetRequests((reason) => {
      calls.push(`first:${reason}`);
      return false;
    });
    const unsubscribeSecond = subscribeKeyboardStickyResetRequests((reason) => {
      calls.push(`second:${reason}`);
      return true;
    });

    try {
      expect(requestKeyboardStickyReset("message-send")).toBe(true);
      expect(calls).toEqual(["first:message-send", "second:message-send"]);
    } finally {
      unsubscribeFirst();
      unsubscribeSecond();
    }
  });

  it("stops notifying an unsubscribed handler", () => {
    let calls = 0;
    const unsubscribe = subscribeKeyboardStickyResetRequests(() => {
      calls += 1;
      return true;
    });

    unsubscribe();
    expect(requestKeyboardStickyReset("message-send")).toBe(false);
    expect(calls).toBe(0);
  });
});
