import { describe, expect, it } from "vite-plus/test";

import {
  admitNewAttentionKeys,
  createAttentionFilter,
  hasUnseenWake,
  isThreadAttention,
} from "./threadAttention.ts";

describe("thread attention", () => {
  it("excludes ready attention while the thread is marked as woke", () => {
    expect(
      isThreadAttention({
        isReady: true,
        readyAttentionSignal: true,
        wokeAt: "2026-03-09T10:05:00.000Z",
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
      }),
    ).toBe(false);
  });

  it("keeps ready attention after the wake has been seen", () => {
    expect(
      isThreadAttention({
        isReady: true,
        readyAttentionSignal: true,
        wokeAt: "2026-03-09T10:05:00.000Z",
        lastVisitedAt: "2026-03-09T10:06:00.000Z",
      }),
    ).toBe(true);
  });

  it("keeps non-ready attention and ignores invalid wake timestamps", () => {
    expect(
      isThreadAttention({
        isReady: false,
        readyAttentionSignal: false,
        wokeAt: "2026-03-09T10:05:00.000Z",
      }),
    ).toBe(true);
    expect(
      isThreadAttention({
        isReady: true,
        readyAttentionSignal: true,
        wokeAt: "not-a-date",
      }),
    ).toBe(true);
  });

  it("treats non-ready status as attention and requires a ready-thread signal", () => {
    expect(
      isThreadAttention({
        isReady: true,
        readyAttentionSignal: false,
        wokeAt: null,
      }),
    ).toBe(false);
    expect(
      isThreadAttention({
        isReady: false,
        readyAttentionSignal: false,
        wokeAt: null,
      }),
    ).toBe(true);
  });

  it("handles unseen wake timestamps", () => {
    expect(hasUnseenWake({ wokeAt: null })).toBe(false);
    expect(hasUnseenWake({ wokeAt: "not-a-date" })).toBe(false);
    expect(hasUnseenWake({ wokeAt: "2026-03-09T10:05:00.000Z" })).toBe(true);
    expect(
      hasUnseenWake({
        wokeAt: "2026-03-09T10:05:00.000Z",
        lastVisitedAt: "invalid",
      }),
    ).toBe(true);
    expect(
      hasUnseenWake({
        wokeAt: "2026-03-09T10:05:00.000Z",
        lastVisitedAt: "2026-03-09T10:05:00.000Z",
      }),
    ).toBe(false);
    expect(
      hasUnseenWake({
        wokeAt: "2026-03-09T10:05:00.000Z",
        lastVisitedAt: "2026-03-09T10:06:00.000Z",
      }),
    ).toBe(false);
  });

  it("captures sticky members and admits every newly seen key", () => {
    const state = createAttentionFilter({
      initialMemberKeys: ["environment-a:working"],
      keys: ["environment-a:working", "environment-a:ready"],
    });

    const unchanged = admitNewAttentionKeys(state, [
      "environment-a:working",
      "environment-a:ready",
    ]);
    expect(unchanged.memberKeys).toBe(state.memberKeys);
    expect(unchanged.knownKeys).toBe(state.knownKeys);

    const next = admitNewAttentionKeys(state, [
      "environment-a:working",
      "environment-b:created-elsewhere",
    ]);
    expect(next.memberKeys).not.toBe(state.memberKeys);
    expect(next.knownKeys).not.toBe(state.knownKeys);
    expect(state.memberKeys).toEqual(new Set(["environment-a:working"]));
    expect(state.knownKeys).toEqual(new Set(["environment-a:working", "environment-a:ready"]));
    expect(next.memberKeys).toEqual(
      new Set(["environment-a:working", "environment-b:created-elsewhere"]),
    );
    expect(next.knownKeys).toEqual(
      new Set(["environment-a:working", "environment-a:ready", "environment-b:created-elsewhere"]),
    );

    const stable = admitNewAttentionKeys(next, [
      "environment-a:working",
      "environment-a:ready",
      "environment-b:created-elsewhere",
    ]);
    expect(stable.memberKeys).toBe(next.memberKeys);
    expect(stable.knownKeys).toBe(next.knownKeys);
    expect(stable.memberKeys).not.toContain("environment-a:ready");
  });
});
