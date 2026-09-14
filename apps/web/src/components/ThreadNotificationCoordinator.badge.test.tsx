import { TurnId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  system: true,
  shells: [] as EnvironmentThreadShell[],
  ready: new Set(["one", "two"]),
  environments: ["one", "two"],
  badge: vi.fn(),
  navigate: vi.fn(),
  deliveries: [] as Array<Promise<boolean>>,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: Record<string, boolean>) => unknown) =>
    select({
      enableTurnCompletionToasts: false,
      enableTurnCompletionSystemNotifications: state.system,
      enableInputRequestNotifications: true,
      enableNotificationSounds: false,
    }),
  useClientSettingsHydrated: () => true,
  useTurnCompletionMinDurationSeconds: () => 0,
  getClientSettings: () => ({ enableNotificationSounds: false }),
}));
vi.mock("../state/entities", () => ({
  useThreadShells: () => state.shells,
  useEnvironmentIdsReadyForTurnCompletion: () => state.ready,
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: state.environments.map((environmentId) => ({ environmentId })),
  }),
}));
vi.mock("../threadNotifications", () => ({
  playNotificationSound: vi.fn(),
  setNotificationBadge: state.badge,
  unlockNotificationAudio: vi.fn(),
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { TurnCompletionNotifications } from "../notifications/turnCompletion";

const start = "2026-09-13T07:59:00Z";
function shell(
  environmentId: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id: "thread",
    environmentId,
    title: `Thread ${environmentId}`,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestTurn: {
      turnId: `turn-${environmentId}`,
      state: "running",
      requestedAt: start,
      startedAt: start,
      completedAt: null,
    },
    ...overrides,
  } as EnvironmentThreadShell;
}
function completedShell(environmentId: string, completedAt = "2026-09-13T08:00:00Z") {
  return shell(environmentId, {
    latestTurn: {
      turnId: TurnId.make(`turn-${environmentId}-${completedAt}`),
      state: "completed",
      requestedAt: start,
      startedAt: start,
      completedAt,
      assistantMessageId: null,
    },
  });
}
class TestNotification extends EventTarget {
  static permission = "granted";
  static sent: TestNotification[] = [];
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    TestNotification.sent.push(this);
  }
}
let renderer: ReactTestRenderer | undefined;
let focused = false;
async function render() {
  await act(async () => {
    if (renderer) renderer.update(<TurnCompletionNotifications />);
    else renderer = create(<TurnCompletionNotifications />);
    await Promise.resolve();
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  state.system = true;
  state.shells = [shell("one"), shell("two")];
  state.ready = new Set(["one", "two"]);
  state.environments = ["one", "two"];
  focused = false;
  TestNotification.sent = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", TestNotification);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { focus: vi.fn(), isSecureContext: true }),
  );
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused }),
  );
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("counts successful background deliveries, deduplicates threads, and clears on focus", async () => {
  await render();
  state.shells = [completedShell("one"), shell("two")];
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(1);
  const first = TestNotification.sent[0]!;
  state.shells = [completedShell("one", "2026-09-13T08:01:00Z"), completedShell("two")];
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(2);
  expect(first.close).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("focus"));
  expect(state.badge).toHaveBeenLastCalledWith(0);
  expect(
    TestNotification.sent.every((notification) => notification.close.mock.calls.length > 0),
  ).toBe(true);
});

it("clears only removed environments", async () => {
  await render();
  state.shells = [completedShell("one"), completedShell("two")];
  await render();
  const [removed, retained] = TestNotification.sent;
  state.environments = ["two"];
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(1);
  expect(removed!.close).toHaveBeenCalled();
  expect(retained!.close).not.toHaveBeenCalled();
});

it("clears on native broadcast and unsubscribes", async () => {
  let clear: (() => void) | undefined;
  const unsubscribe = vi.fn();
  Object.assign(window, {
    desktopBridge: {
      onNotificationBadgeClear: (listener: () => void) => {
        clear = listener;
        return unsubscribe;
      },
    },
  });
  await render();
  state.shells = [completedShell("one"), shell("two")];
  await render();
  clear!();
  expect(state.badge).toHaveBeenLastCalledWith(0);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("does not restore a late native delivery after focus or disabling notifications", async () => {
  let resolveDelivery!: (delivered: boolean) => void;
  const show = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        resolveDelivery = resolve;
      }),
  );
  Object.assign(window, {
    desktopBridge: { notifications: { show, onNotificationClicked: vi.fn(() => vi.fn()) } },
  });
  await render();
  state.shells = [completedShell("one"), shell("two")];
  await render();
  window.dispatchEvent(new Event("focus"));
  resolveDelivery(true);
  await act(async () => {
    await Promise.resolve();
  });
  expect(state.badge).toHaveBeenLastCalledWith(0);

  state.shells = [completedShell("one"), completedShell("two")];
  await render();
  state.system = false;
  await render();
  resolveDelivery(true);
  await act(async () => {
    await Promise.resolve();
  });
  expect(state.badge).toHaveBeenLastCalledWith(0);
});

it("counts a successful native delivery", async () => {
  const show = vi.fn().mockResolvedValue(true);
  Object.assign(window, {
    desktopBridge: { notifications: { show, onNotificationClicked: vi.fn(() => vi.fn()) } },
  });
  await render();
  state.shells = [completedShell("one"), shell("two")];
  await render();
  expect(show).toHaveBeenCalledOnce();
  expect(state.badge).toHaveBeenLastCalledWith(1);
});

it("badges background failures and pending input", async () => {
  await render();
  state.shells = [
    shell("one", { latestTurn: { ...shell("one").latestTurn!, state: "error" } }),
    shell("two", { hasPendingUserInput: true }),
  ];
  await render();
  expect(TestNotification.sent.map((notification) => notification.title)).toEqual([
    "Thread failed",
    "Input needed",
  ]);
  expect(state.badge).toHaveBeenLastCalledWith(2);
});
