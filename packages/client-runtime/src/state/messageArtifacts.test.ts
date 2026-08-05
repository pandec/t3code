import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, MessageId } from "@t3tools/contracts";

import {
  getMessageArtifactSessionSnapshot,
  rememberMessageSummary,
  subscribeMessageArtifactSession,
} from "./messageArtifacts.ts";

describe("message artifact sessions", () => {
  it("deletes artifacts after the last listener unsubscribes", () => {
    const environmentId = EnvironmentId.make("environment-artifact-cleanup");
    const messageId = MessageId.make("message-artifact-cleanup");
    const sourceText = "A response to summarize";
    const unsubscribeFirst = subscribeMessageArtifactSession(environmentId, messageId, () => {});
    const unsubscribeSecond = subscribeMessageArtifactSession(environmentId, messageId, () => {});

    rememberMessageSummary(environmentId, sourceText, {
      messageId,
      summary: "Short summary",
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    expect(
      getMessageArtifactSessionSnapshot(environmentId, messageId, sourceText).summary,
    ).not.toBeNull();

    unsubscribeFirst();
    expect(
      getMessageArtifactSessionSnapshot(environmentId, messageId, sourceText).summary,
    ).not.toBeNull();

    unsubscribeSecond();
    expect(getMessageArtifactSessionSnapshot(environmentId, messageId, sourceText)).toEqual({
      summary: null,
      speech: null,
    });

    rememberMessageSummary(environmentId, sourceText, {
      messageId,
      summary: "Late summary",
      createdAt: "2026-08-05T00:01:00.000Z",
    });
    expect(getMessageArtifactSessionSnapshot(environmentId, messageId, sourceText)).toEqual({
      summary: null,
      speech: null,
    });
  });

  it("does not let a stale unsubscribe clear a newer session", () => {
    const environmentId = EnvironmentId.make("environment-stale-unsubscribe");
    const messageId = MessageId.make("message-stale-unsubscribe");
    const sourceText = "A response with a remounted listener";
    const staleUnsubscribe = subscribeMessageArtifactSession(environmentId, messageId, () => {});
    staleUnsubscribe();

    const currentUnsubscribe = subscribeMessageArtifactSession(environmentId, messageId, () => {});
    rememberMessageSummary(environmentId, sourceText, {
      messageId,
      summary: "Current summary",
      createdAt: "2026-08-05T00:02:00.000Z",
    });
    staleUnsubscribe();

    expect(
      getMessageArtifactSessionSnapshot(environmentId, messageId, sourceText).summary?.summary,
    ).toBe("Current summary");
    currentUnsubscribe();
  });
});
