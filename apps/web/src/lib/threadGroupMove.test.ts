import { AsyncResult } from "effect/unstable/reactivity";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";
import { groupMovableThreads, moveThreadsToGroup } from "./threadGroupMove";

const thread = (id: string, environmentId = "env-a") => ({
  id: id as ThreadId,
  environmentId: environmentId as EnvironmentId,
});

describe("groupMovableThreads", () => {
  it("keeps only threads whose environment supports groups", () => {
    const threads = [thread("t1", "env-a"), thread("t2", "env-b"), thread("t3", "env-a")];
    expect(groupMovableThreads(threads, (environmentId) => environmentId === "env-a")).toEqual([
      threads[0],
      threads[2],
    ]);
  });
});

describe("moveThreadsToGroup", () => {
  it("moves every thread and reports the failures without stopping early", async () => {
    const calls: Array<[string, string | null]> = [];
    const outcome = await moveThreadsToGroup({
      threads: [thread("ok-1"), thread("fails"), thread("ok-2")],
      customGroupId: "group-1",
      move: async (threadRef, customGroupId) => {
        calls.push([threadRef.threadId, customGroupId]);
        return threadRef.threadId === "fails"
          ? AsyncResult.failure(Cause.fail(new Error("boom")))
          : AsyncResult.success(undefined);
      },
    });
    expect(calls).toEqual([
      ["ok-1", "group-1"],
      ["fails", "group-1"],
      ["ok-2", "group-1"],
    ]);
    expect(outcome.movedThreadKeys).toEqual(["env-a:ok-1", "env-a:ok-2"]);
    expect(outcome.failedCount).toBe(1);
    expect(outcome.firstError).toBeInstanceOf(Error);
  });
});
