import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { linearCommentDraftKey, useLinearCommentDraftStore } from "./linearCommentDraftStore";

const environmentId = EnvironmentId.make("environment-a");
const threadRef = { environmentId, threadId: ThreadId.make("thread-a") };
const issueA = linearCommentDraftKey(environmentId, threadRef, "issue-a");
const issueB = linearCommentDraftKey(environmentId, threadRef, "issue-b");

describe("Linear comment drafts", () => {
  beforeEach(() => {
    useLinearCommentDraftStore.setState({ drafts: {} });
  });

  it("retains separate drafts when returning to an issue, thread, or environment", () => {
    const otherEnvironment = EnvironmentId.make("environment-b");
    const keys = [
      issueA,
      issueB,
      linearCommentDraftKey(
        environmentId,
        { ...threadRef, threadId: ThreadId.make("b") },
        "issue-a",
      ),
      linearCommentDraftKey(
        otherEnvironment,
        { ...threadRef, environmentId: otherEnvironment },
        "issue-a",
      ),
      linearCommentDraftKey(environmentId, null, "issue-a"),
    ];
    for (const [index, key] of keys.entries()) {
      useLinearCommentDraftStore.getState().setBody(key, `Draft ${index}`);
    }

    for (const [index, key] of keys.entries()) {
      expect(useLinearCommentDraftStore.getState().drafts[key]).toEqual({
        body: `Draft ${index}`,
        posting: false,
      });
    }
  });

  it("keeps a pending post locked across readers, preserves failure, and clears only success", () => {
    useLinearCommentDraftStore.getState().setBody(issueA, "  First comment  ");
    expect(useLinearCommentDraftStore.getState().beginPost(issueA)).toBe("First comment");

    // Another panel can open and post while the first panel is unmounted.
    useLinearCommentDraftStore.getState().setBody(issueB, "Second comment");
    expect(useLinearCommentDraftStore.getState().beginPost(issueB)).toBe("Second comment");

    // Returning to the first issue cannot edit or resubmit its pending comment.
    expect(useLinearCommentDraftStore.getState().beginPost(issueA)).toBeNull();
    useLinearCommentDraftStore.getState().setBody(issueA, "Replacement");
    expect(useLinearCommentDraftStore.getState().drafts[issueA]).toEqual({
      body: "  First comment  ",
      posting: true,
    });

    useLinearCommentDraftStore.getState().finishPost(issueA, false);
    expect(useLinearCommentDraftStore.getState().drafts[issueA]).toEqual({
      body: "  First comment  ",
      posting: false,
    });
    expect(useLinearCommentDraftStore.getState().beginPost(issueA)).toBe("First comment");
    useLinearCommentDraftStore.getState().finishPost(issueA, true);
    expect(useLinearCommentDraftStore.getState().drafts[issueA]).toBeUndefined();
    expect(useLinearCommentDraftStore.getState().drafts[issueB]).toEqual({
      body: "Second comment",
      posting: true,
    });
  });

  it("does not post blank drafts and removes cleared entries", () => {
    expect(useLinearCommentDraftStore.getState().beginPost(issueA)).toBeNull();
    useLinearCommentDraftStore.getState().setBody(issueA, " \n ");
    expect(useLinearCommentDraftStore.getState().beginPost(issueA)).toBeNull();
    useLinearCommentDraftStore.getState().setBody(issueA, "");
    expect(useLinearCommentDraftStore.getState().drafts).toEqual({});
  });
});
