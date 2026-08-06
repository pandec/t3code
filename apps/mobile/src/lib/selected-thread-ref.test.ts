import { describe, expect, it } from "vite-plus/test";
import type { NavigationState } from "@react-navigation/native";

import { selectedWorkspaceThreadRef } from "./selected-thread-ref";

type FakeRoute = { name: string; params?: Record<string, unknown> };

function navState(routes: FakeRoute[]): NavigationState {
  return { index: routes.length - 1, routes } as unknown as NavigationState;
}

function threadParams(suffix: string) {
  return { environmentId: `env-${suffix}`, threadId: `thread-${suffix}` };
}

function expectRef(
  state: NavigationState,
  expected: { environmentId: string; threadId: string } | null,
) {
  const ref = selectedWorkspaceThreadRef(state);
  if (expected === null) {
    expect(ref).toBeNull();
    return;
  }
  expect(ref).not.toBeNull();
  expect(String(ref?.environmentId)).toBe(expected.environmentId);
  expect(String(ref?.threadId)).toBe(expected.threadId);
}

describe("selectedWorkspaceThreadRef", () => {
  it("resolves from a plain Thread route", () => {
    const state = navState([{ name: "Thread", params: threadParams("a") }]);
    expectRef(state, { environmentId: "env-a", threadId: "thread-a" });
  });

  it("returns null when no route carries thread params", () => {
    const state = navState([{ name: "Home" }]);
    expectRef(state, null);
  });

  it("returns null for a non-thread-scoped overlay alone (SettingsSheet)", () => {
    const state = navState([{ name: "SettingsSheet" }]);
    expectRef(state, null);
  });

  it("normalizes deep-link route params before deriving the thread ref", () => {
    const state = navState([
      {
        name: "GitOverview",
        params: { environmentId: " env-a ", threadId: [" thread-a "] },
      },
    ]);
    expectRef(state, { environmentId: "env-a", threadId: "thread-a" });
  });

  describe("thread-scoped overlay routes, deep-linked with no underlying Thread route", () => {
    const cases: FakeRoute[] = [
      { name: "GitOverview", params: threadParams("git-overview") },
      { name: "GitCommit", params: threadParams("git-commit") },
      { name: "GitBranches", params: threadParams("git-branches") },
      { name: "GitConfirm", params: threadParams("git-confirm") },
      { name: "ThreadReviewComment", params: threadParams("review-comment") },
    ];

    for (const route of cases) {
      it(`derives the thread ref from ${route.name} when it is the only route in the stack`, () => {
        const state = navState([route]);
        const suffix = String((route.params as { threadId: string }).threadId).replace(
          "thread-",
          "",
        );
        expectRef(state, { environmentId: `env-${suffix}`, threadId: `thread-${suffix}` });
      });
    }
  });

  describe("push / pop across a thread-scoped overlay", () => {
    it("promotes the overlay's thread ref when it is pushed above Thread", () => {
      const state = navState([
        { name: "Thread", params: threadParams("a") },
        { name: "GitOverview", params: threadParams("b") },
      ]);
      expectRef(state, { environmentId: "env-b", threadId: "thread-b" });
    });

    it("demotes back to the Thread route's ref once the overlay is popped", () => {
      const withOverlay = navState([
        { name: "Thread", params: threadParams("a") },
        { name: "GitBranches", params: threadParams("b") },
      ]);
      expectRef(withOverlay, { environmentId: "env-b", threadId: "thread-b" });

      const popped = navState([{ name: "Thread", params: threadParams("a") }]);
      expectRef(popped, { environmentId: "env-a", threadId: "thread-a" });
    });

    it("promotes a non-thread-scoped overlay above Thread without losing the thread ref", () => {
      // SettingsSheet is a workspace overlay but NOT thread-scoped; the
      // selected ref must fall back to the Thread route beneath it.
      const state = navState([
        { name: "Thread", params: threadParams("a") },
        { name: "SettingsSheet" },
      ]);
      expectRef(state, { environmentId: "env-a", threadId: "thread-a" });
    });

    it("demotes to null once a thread-scoped overlay is popped with no Thread route beneath it", () => {
      const withOverlay = navState([
        { name: "Home" },
        { name: "GitConfirm", params: threadParams("a") },
      ]);
      expectRef(withOverlay, { environmentId: "env-a", threadId: "thread-a" });

      const popped = navState([{ name: "Home" }]);
      expectRef(popped, null);
    });
  });
});
