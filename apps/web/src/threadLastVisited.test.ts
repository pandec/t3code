import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import { resolveShortcutCommand } from "./keybindings";
import {
  createLastVisitedThreadShortcut,
  createThreadVisitHistory,
  type LastVisitedShortcutEvent,
} from "./threadLastVisited";

const threadRef = (environmentId: string, threadId: string): ScopedThreadRef => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
});

const A = threadRef("env-a", "thread-a");
const B = threadRef("env-a", "thread-b");
const C = threadRef("env-b", "thread-a");

describe("createThreadVisitHistory", () => {
  it("keeps only the last two distinct threads and toggles between them", () => {
    const history = createThreadVisitHistory();
    expect(history.resolveTarget(null)).toBeNull();
    history.record(A);
    expect(history.resolveTarget(A)).toBeNull();
    history.record(B);
    expect(history.resolveTarget(B)).toEqual(A);
    history.record(A);
    expect(history.resolveTarget(A)).toEqual(B);
    history.record(C);
    expect(history.resolveTarget(C)).toEqual(A);
    // Repeated visits of the focused thread never shift the pair.
    history.record({ ...C });
    expect(history.resolveTarget(C)).toEqual(A);
  });

  it("returns the thread the user came from while a draft is focused", () => {
    const history = createThreadVisitHistory();
    history.record(A);
    history.record(B);
    history.record(null);
    expect(history.resolveTarget(null)).toEqual(B);
  });
});

function keyEvent(overrides: Partial<LastVisitedShortcutEvent> = {}) {
  const event = {
    type: "keydown",
    key: "Tab",
    code: "Tab",
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    target: null,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } satisfies LastVisitedShortcutEvent;
  return event;
}

function shortcut(
  overrides: Partial<Parameters<typeof createLastVisitedThreadShortcut>[0]> = {},
  platform = "MacIntel",
) {
  const openThread = vi.fn();
  const controller = createLastVisitedThreadShortcut({
    isDesktop: true,
    pendingRelease: { key: null },
    resolveCommand: (event) =>
      resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform,
        context: { isDesktop: true },
      }),
    isBlocked: () => false,
    resolveTarget: () => A,
    openThread,
    ...overrides,
  });
  return { controller, openThread };
}

describe("createLastVisitedThreadShortcut", () => {
  it("opens the target on Ctrl+Tab and consumes the press and its release", () => {
    for (const platform of ["MacIntel", "Linux x86_64", "Win32"]) {
      const pendingRelease = { key: null };
      const { controller, openThread } = shortcut({ pendingRelease }, platform);
      const down = keyEvent();
      controller.onKeyDown(down);
      expect(openThread).toHaveBeenCalledWith(A);
      expect(down.preventDefault).toHaveBeenCalled();
      expect(down.stopPropagation).toHaveBeenCalled();

      // Opening navigates, which re-registers the handlers before the key
      // comes up; Control released before Tab still belongs to this press.
      const { controller: rebuilt } = shortcut({ pendingRelease }, platform);
      const up = keyEvent({ type: "keyup", ctrlKey: false });
      rebuilt.onKeyUp(up);
      expect(up.preventDefault).toHaveBeenCalled();
      expect(up.stopPropagation).toHaveBeenCalled();

      // Only the one matching release is swallowed.
      const secondUp = keyEvent({ type: "keyup", ctrlKey: false });
      rebuilt.onKeyUp(secondUp);
      expect(secondUp.preventDefault).not.toHaveBeenCalled();
    }
  });

  it("ignores the chord outside the desktop app", () => {
    // The default binding itself is desktop-gated, so a browser never resolves it.
    expect(
      resolveShortcutCommand(keyEvent(), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: false },
      }),
    ).toBeNull();
    const { controller, openThread } = shortcut({ isDesktop: false });
    const down = keyEvent();
    controller.onKeyDown(down);
    expect(openThread).not.toHaveBeenCalled();
    expect(down.preventDefault).not.toHaveBeenCalled();
    const up = keyEvent({ type: "keyup" });
    controller.onKeyUp(up);
    expect(up.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves a fresh Tab release alone after a shortcut release was lost", () => {
    const { controller } = shortcut();
    controller.onKeyDown(keyEvent());
    // The app lost focus before Tab came up, then received a plain Tab press.
    const down = keyEvent({ ctrlKey: false });
    controller.onKeyDown(down);
    const up = keyEvent({ type: "keyup", ctrlKey: false });
    controller.onKeyUp(up);
    expect(down.preventDefault).not.toHaveBeenCalled();
    expect(up.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves other keys, Cmd+Tab, and already handled events alone", () => {
    const { controller, openThread } = shortcut();
    const ignored = [
      keyEvent({ ctrlKey: false }),
      keyEvent({ ctrlKey: false, metaKey: true }),
      keyEvent({ defaultPrevented: true }),
    ];
    for (const event of ignored) {
      controller.onKeyDown(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(openThread).not.toHaveBeenCalled();
  });

  it("consumes the chord without opening on repeat, when blocked, or without a target", () => {
    const cases = [
      { event: keyEvent({ repeat: true }), overrides: {} },
      { event: keyEvent(), overrides: { isBlocked: () => true } },
      { event: keyEvent(), overrides: { resolveTarget: () => null } },
    ];
    for (const { event, overrides } of cases) {
      const { controller, openThread } = shortcut(overrides);
      controller.onKeyDown(event);
      expect(openThread).not.toHaveBeenCalled();
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
      const up = keyEvent({ type: "keyup", ctrlKey: false });
      controller.onKeyUp(up);
      expect(up.preventDefault).toHaveBeenCalled();
    }
  });
});
