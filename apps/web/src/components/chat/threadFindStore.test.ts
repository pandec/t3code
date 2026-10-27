import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  attachThreadFindTimeline,
  closeThreadFind,
  findForMessageMatch,
  openThreadFind,
  openThreadFindOnQuery,
  retainThreadFindForRoute,
  setThreadFindQuery,
  useThreadFindStore,
} from "./threadFindStore";
import { useThreadSplitStore } from "../thread-split/threadSplitStore";

const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
const otherRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-2"));
const threadKey = "env-1:thread-1";

function setup() {
  closeThreadFind();
  useThreadSplitStore.setState({ secondaryRef: null, splitMounted: false });
  const navigate = vi.fn();
  const readPosition = vi.fn(() => ({ entryId: "entry-9", occurrence: 1 }));
  return { navigate, readPosition, timeline: { threadKey, navigate, readPosition } };
}

describe("thread find store", () => {
  it("restarts an open query from the viewport of the timeline showing the thread", () => {
    const { navigate, readPosition, timeline } = setup();
    const detach = attachThreadFindTimeline(timeline);
    openThreadFind(threadKey);
    // Opening find is manual navigation; reopening it is not.
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(useThreadFindStore.getState()).toMatchObject({ threadKey, focusRequestId: 1 });

    setThreadFindQuery(threadKey, " needle ");
    expect(readPosition).toHaveBeenLastCalledWith("needle");
    // Opening again refocuses and restarts the search from where the viewport is.
    openThreadFind(threadKey);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(useThreadFindStore.getState()).toMatchObject({
      query: " needle ",
      focusRequestId: 2,
      start: { entryId: "entry-9", occurrence: 1 },
      navigationId: 2,
      requestId: 2,
    });
    detach();
  });

  it("opens a search result's find for a thread before its timeline shows it", () => {
    const { navigate, readPosition, timeline } = setup();
    const detach = attachThreadFindTimeline({ ...timeline, threadKey: "env-1:thread-2" });
    openThreadFindOnQuery(threadKey, { query: "Café", start: { entryId: "m", occurrence: 0 } });
    expect(useThreadFindStore.getState()).toMatchObject({
      threadKey,
      query: "Café",
      start: { entryId: "m", occurrence: 0 },
    });
    // Another thread's timeline does not answer for this one.
    setThreadFindQuery(threadKey, "Caf");
    expect(readPosition).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    detach();
  });

  it("keeps find over Settings and Usage, and closes it on any other route", () => {
    setup();
    openThreadFindOnQuery(threadKey, { query: "x" });
    retainThreadFindForRoute({ modalPage: false, threadRef });
    retainThreadFindForRoute({ modalPage: true, threadRef: null });
    expect(useThreadFindStore.getState()).toMatchObject({ threadKey, query: "x" });

    retainThreadFindForRoute({ modalPage: false, threadRef: otherRef });
    expect(useThreadFindStore.getState()).toMatchObject({ threadKey: null, query: "" });

    openThreadFindOnQuery(threadKey, { query: "x" });
    retainThreadFindForRoute({ modalPage: false, threadRef: null });
    expect(useThreadFindStore.getState().threadKey).toBeNull();
  });
});

describe("thread find in a split", () => {
  it("reads the viewport of the pane showing the thread and survives the other pane's route", () => {
    const { navigate, readPosition, timeline } = setup();
    useThreadSplitStore.setState({ secondaryRef: threadRef, splitMounted: true });
    const detachSecondary = attachThreadFindTimeline(timeline);
    const otherNavigate = vi.fn();
    const otherReadPosition = vi.fn(() => undefined);
    const detachPrimary = attachThreadFindTimeline({
      threadKey: "env-1:thread-2",
      navigate: otherNavigate,
      readPosition: otherReadPosition,
    });
    openThreadFind(threadKey);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(otherNavigate).not.toHaveBeenCalled();
    setThreadFindQuery(threadKey, "needle");
    expect(readPosition).toHaveBeenLastCalledWith("needle");
    expect(otherReadPosition).not.toHaveBeenCalled();

    retainThreadFindForRoute({ modalPage: false, threadRef: otherRef });
    expect(useThreadFindStore.getState().threadKey).toBe(threadKey);

    useThreadSplitStore.setState({ splitMounted: false });
    retainThreadFindForRoute({ modalPage: false, threadRef: otherRef });
    expect(useThreadFindStore.getState().threadKey).toBeNull();
    detachPrimary();
    detachSecondary();
  });
});

describe("findForMessageMatch", () => {
  it("opens find on the longest word as the snippet writes it, at the matched message", () => {
    expect(
      findForMessageMatch(
        { snippet: "The cafeteria, then the Café", messageId: MessageId.make("message-1") },
        "cafe",
      ),
    ).toEqual({ query: "Café", start: { entryId: "message-1", occurrence: 0 } });
    expect(findForMessageMatch({ snippet: "fix the sidebar lag" }, "fix sidebar")).toEqual({
      query: "sidebar",
    });
    // The whole query, when the snippet holds it as typed.
    expect(findForMessageMatch({ snippet: "then Vp  run dev again" }, "vp run dev")).toEqual({
      query: "Vp  run dev",
    });
  });
});
