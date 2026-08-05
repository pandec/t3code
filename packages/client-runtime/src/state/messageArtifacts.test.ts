import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, MessageId } from "@t3tools/contracts";

import {
  beginMessageArtifactRequest,
  getMessageArtifactSessionSnapshot,
  rememberMessageSpeech,
  rememberMessageSummary,
  subscribeMessageArtifactSession,
} from "./messageArtifacts.ts";

const EMPTY_ARTIFACTS = { summary: null, speech: null };

describe("message artifact sessions", () => {
  it("deletes inactive artifacts without a pending request", () => {
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
    expect(getMessageArtifactSessionSnapshot(environmentId, messageId, sourceText)).toEqual(
      EMPTY_ARTIFACTS,
    );

    rememberMessageSummary(environmentId, sourceText, {
      messageId,
      summary: "Late summary",
      createdAt: "2026-08-05T00:01:00.000Z",
    });
    expect(getMessageArtifactSessionSnapshot(environmentId, messageId, sourceText)).toEqual(
      EMPTY_ARTIFACTS,
    );
  });

  it("delivers a result that completes after the last listener unsubscribes", () => {
    const environmentId = EnvironmentId.make("environment-in-flight-result");
    const messageId = MessageId.make("message-in-flight-result");
    const sourceText = "A response whose summary finishes after unmount";
    const unsubscribe = subscribeMessageArtifactSession(environmentId, messageId, () => {});
    const endRequest = beginMessageArtifactRequest(environmentId, messageId);

    unsubscribe();
    rememberMessageSummary(environmentId, sourceText, {
      messageId,
      summary: "Retained summary",
      createdAt: "2026-08-05T00:02:00.000Z",
    });
    endRequest();

    const remountUnsubscribe = subscribeMessageArtifactSession(environmentId, messageId, () => {});
    expect(
      getMessageArtifactSessionSnapshot(environmentId, messageId, sourceText).summary?.summary,
    ).toBe("Retained summary");

    remountUnsubscribe();
    expect(
      getMessageArtifactSessionSnapshot(environmentId, messageId, sourceText).summary?.summary,
    ).toBe("Retained summary");
  });

  it("notifies a listener that remounts before an in-flight result arrives", () => {
    const environmentId = EnvironmentId.make("environment-in-flight-remount");
    const messageId = MessageId.make("message-in-flight-remount");
    const sourceText = "A response whose speech finishes after remount";
    const staleUnsubscribe = subscribeMessageArtifactSession(environmentId, messageId, () => {});
    const endRequest = beginMessageArtifactRequest(environmentId, messageId);

    staleUnsubscribe();
    let notifications = 0;
    const currentUnsubscribe = subscribeMessageArtifactSession(environmentId, messageId, () => {
      notifications += 1;
    });
    rememberMessageSpeech(environmentId, sourceText, {
      messageId,
      speechId: "speech-in-flight-remount",
      transcript: "Listening version",
      mimeType: "audio/mpeg",
      sizeBytes: 1_024,
      createdAt: "2026-08-05T00:03:00.000Z",
    });
    endRequest();

    expect(notifications).toBe(1);
    expect(
      getMessageArtifactSessionSnapshot(environmentId, messageId, sourceText).speech?.speechId,
    ).toBe("speech-in-flight-remount");
    currentUnsubscribe();

    const nextUnsubscribe = subscribeMessageArtifactSession(environmentId, messageId, () => {});
    expect(
      getMessageArtifactSessionSnapshot(environmentId, messageId, sourceText).speech?.speechId,
    ).toBe("speech-in-flight-remount");
    nextUnsubscribe();
  });

  it("tracks concurrent summary and speech requests independently", () => {
    const environmentId = EnvironmentId.make("environment-concurrent-artifacts");
    const messageId = MessageId.make("message-concurrent-artifacts");
    const sourceText = "A response with concurrent artifact requests";
    const unsubscribe = subscribeMessageArtifactSession(environmentId, messageId, () => {});
    const endSummaryRequest = beginMessageArtifactRequest(environmentId, messageId);
    const endSpeechRequest = beginMessageArtifactRequest(environmentId, messageId);

    unsubscribe();
    rememberMessageSummary(environmentId, sourceText, {
      messageId,
      summary: "Concurrent summary",
      createdAt: "2026-08-05T00:04:00.000Z",
    });
    endSummaryRequest();
    rememberMessageSpeech(environmentId, sourceText, {
      messageId,
      speechId: "speech-concurrent-artifacts",
      transcript: "Concurrent listening version",
      mimeType: "audio/mpeg",
      sizeBytes: 2_048,
      createdAt: "2026-08-05T00:05:00.000Z",
    });
    endSpeechRequest();
    endSpeechRequest();

    const remountUnsubscribe = subscribeMessageArtifactSession(environmentId, messageId, () => {});
    const artifacts = getMessageArtifactSessionSnapshot(environmentId, messageId, sourceText);
    expect(artifacts.summary?.summary).toBe("Concurrent summary");
    expect(artifacts.speech?.speechId).toBe("speech-concurrent-artifacts");
    remountUnsubscribe();
  });

  it("cleans a request that ends without producing an artifact", () => {
    const environmentId = EnvironmentId.make("environment-failed-request");
    const messageId = MessageId.make("message-failed-request");
    const sourceText = "A response whose request fails";
    const unsubscribe = subscribeMessageArtifactSession(environmentId, messageId, () => {});
    const endRequest = beginMessageArtifactRequest(environmentId, messageId);

    unsubscribe();
    endRequest();
    rememberMessageSummary(environmentId, sourceText, {
      messageId,
      summary: "Too late",
      createdAt: "2026-08-05T00:04:00.000Z",
    });

    expect(getMessageArtifactSessionSnapshot(environmentId, messageId, sourceText)).toEqual(
      EMPTY_ARTIFACTS,
    );
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
      createdAt: "2026-08-05T00:05:00.000Z",
    });
    staleUnsubscribe();

    expect(
      getMessageArtifactSessionSnapshot(environmentId, messageId, sourceText).summary?.summary,
    ).toBe("Current summary");
    currentUnsubscribe();
  });

  it("bounds completed artifacts that never remount", () => {
    const environmentId = EnvironmentId.make("environment-retained-bound");
    const sourceText = "A response with a retained result";
    const messageIds = Array.from({ length: 24 }, (_, index) =>
      MessageId.make(`message-retained-bound-${index}`),
    );

    for (const [index, messageId] of messageIds.entries()) {
      const unsubscribe = subscribeMessageArtifactSession(environmentId, messageId, () => {});
      const endRequest = beginMessageArtifactRequest(environmentId, messageId);
      unsubscribe();
      rememberMessageSummary(environmentId, sourceText, {
        messageId,
        summary: `Summary ${index}`,
        createdAt: "2026-08-05T00:06:00.000Z",
      });
      endRequest();
    }

    expect(getMessageArtifactSessionSnapshot(environmentId, messageIds[0]!, sourceText)).toEqual(
      EMPTY_ARTIFACTS,
    );
    expect(
      getMessageArtifactSessionSnapshot(environmentId, messageIds.at(-1)!, sourceText).summary
        ?.summary,
    ).toBe("Summary 23");
  });
});
