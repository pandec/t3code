import { describe, expect, it } from "vite-plus/test";

import {
  canSteerQueuedThreadMessageNow,
  soonestSteerGraceRemainingMs,
  STEER_GRACE_WINDOW_MS,
  steerGraceRemainingMs,
} from "./threadOutboxModel.ts";

const createdAt = "2026-07-27T10:00:00.000Z";
const createdAtMs = Date.parse(createdAt);

describe("steerGraceRemainingMs", () => {
  it("holds a fresh steer for the whole window", () => {
    expect(steerGraceRemainingMs({ deliveryIntent: "steer", createdAt }, createdAtMs)).toBe(
      STEER_GRACE_WINDOW_MS,
    );
  });

  it("counts the window down", () => {
    expect(steerGraceRemainingMs({ deliveryIntent: "steer", createdAt }, createdAtMs + 2_000)).toBe(
      STEER_GRACE_WINDOW_MS - 2_000,
    );
  });

  it("releases the steer once the window elapses", () => {
    expect(
      steerGraceRemainingMs(
        { deliveryIntent: "steer", createdAt },
        createdAtMs + STEER_GRACE_WINDOW_MS,
      ),
    ).toBe(0);
    expect(
      steerGraceRemainingMs({ deliveryIntent: "steer", createdAt }, createdAtMs + 60_000),
    ).toBe(0);
  });

  it("never holds a queued message — the running turn already does", () => {
    expect(steerGraceRemainingMs({ deliveryIntent: "queue", createdAt }, createdAtMs)).toBe(0);
    expect(steerGraceRemainingMs({ createdAt }, createdAtMs)).toBe(0);
  });

  it("sends immediately when the timestamp is unreadable", () => {
    // Better a steer that skips its window than one stuck in the queue.
    expect(steerGraceRemainingMs({ deliveryIntent: "steer", createdAt: "nonsense" }, 0)).toBe(0);
  });

  it("sends immediately when the timestamp is in the future", () => {
    expect(
      steerGraceRemainingMs(
        { deliveryIntent: "steer", createdAt: "2099-01-01T00:00:00.000Z" },
        createdAtMs,
      ),
    ).toBe(0);
  });

  it("does not resurrect a window for a steer promoted from an old queued message", () => {
    // The row action flips intent on a message queued long ago; the user asked
    // for it now, so it must not wait again.
    expect(
      steerGraceRemainingMs({ deliveryIntent: "steer", createdAt }, createdAtMs + 3_600_000),
    ).toBe(0);
  });
});

describe("canSteerQueuedThreadMessageNow", () => {
  it("gates only a steer whose grace window is still live", () => {
    expect(
      canSteerQueuedThreadMessageNow({ deliveryIntent: "queue", createdAt }, createdAtMs),
    ).toBe(true);
    expect(
      canSteerQueuedThreadMessageNow({ deliveryIntent: "steer", createdAt }, createdAtMs),
    ).toBe(false);
    expect(
      canSteerQueuedThreadMessageNow(
        { deliveryIntent: "steer", createdAt },
        createdAtMs + STEER_GRACE_WINDOW_MS,
      ),
    ).toBe(true);
  });

  it("fails open for an unreadable timestamp", () => {
    expect(
      canSteerQueuedThreadMessageNow({ deliveryIntent: "steer", createdAt: "nonsense" }, 0),
    ).toBe(true);
  });
});

describe("soonestSteerGraceRemainingMs", () => {
  it("returns the earliest live grace deadline and ignores queued or expired rows", () => {
    expect(
      soonestSteerGraceRemainingMs(
        [
          { deliveryIntent: "queue", createdAt },
          { deliveryIntent: "steer", createdAt },
          { deliveryIntent: "steer", createdAt: "2026-07-27T10:00:01.000Z" },
          { deliveryIntent: "steer", createdAt: "2026-07-27T09:59:00.000Z" },
        ],
        createdAtMs + 2_000,
      ),
    ).toBe(3_000);
  });

  it("returns null when no grace deadline remains", () => {
    expect(
      soonestSteerGraceRemainingMs(
        [
          { deliveryIntent: "queue", createdAt },
          { deliveryIntent: "steer", createdAt: "2026-07-27T09:59:00.000Z" },
        ],
        createdAtMs,
      ),
    ).toBeNull();
  });
});
