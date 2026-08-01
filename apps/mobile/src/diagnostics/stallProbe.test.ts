import { describe, expect, it } from "@effect/vitest";

import { eventLoopStallBucket, eventLoopStallDuration } from "./stallProbe";

describe("mobile JS stall probe", () => {
  it("computes non-negative timer drift", () => {
    expect(eventLoopStallDuration(1_000, 1_420)).toBe(420);
    expect(eventLoopStallDuration(1_000, 990)).toBe(0);
  });

  it("groups stalls into stable buckets", () => {
    expect(eventLoopStallBucket(150)).toBe("150-249");
    expect(eventLoopStallBucket(250)).toBe("250-499");
    expect(eventLoopStallBucket(500)).toBe("500-999");
    expect(eventLoopStallBucket(1_000)).toBe("1000-1999");
    expect(eventLoopStallBucket(2_000)).toBe("2000+");
  });
});
