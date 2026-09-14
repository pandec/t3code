import { TurnId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  toasts: true,
  system: false,
  input: true,
  sounds: false,
  hydrated: true,
  shells: [] as EnvironmentThreadShell[],
  ready: new Set(["env-1"]),
  environments: ["env-1"],
  add: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: Record<string, boolean>) => unknown) =>
    select({
      enableTurnCompletionToasts: state.toasts,
      enableTurnCompletionSystemNotifications: state.system,
      enableInputRequestNotifications: state.input,
      enableNotificationSounds: state.sounds,
    }),
  useClientSettingsHydrated: () => state.hydrated,
  useTurnCompletionMinDurationSeconds: () => 0,
  getClientSettings: () => ({ enableNotificationSounds: state.sounds }),
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
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
  unlockNotificationAudio: vi.fn(),
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.add } }));

import { TurnCompletionNotifications } from "../notifications/turnCompletion";

const started = "2026-09-13T09:59:00.000Z";
const completed = "2026-09-13T10:00:00.000Z";
function shell(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: "thread-1",
    environmentId: "env-1",
    title: "Fix the login form",
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "running",
      requestedAt: started,
      startedAt: started,
      completedAt: null,
    },
    ...overrides,
  } as EnvironmentThreadShell;
}

let renderer: ReactTestRenderer | undefined;
async function render() {
  await act(async () => {
    if (renderer) renderer.update(<TurnCompletionNotifications />);
    else renderer = create(<TurnCompletionNotifications />);
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    toasts: true,
    system: false,
    input: true,
    sounds: false,
    hydrated: true,
    shells: [shell()],
    ready: new Set(["env-1"]),
    environments: ["env-1"],
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { focus: vi.fn() }));
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true }),
  );
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("turn and input notifications", () => {
  it("shows a completion toast while focused and routes its action", async () => {
    await render();
    state.shells = [
      shell({
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "completed",
          requestedAt: started,
          startedAt: started,
          completedAt: completed,
          assistantMessageId: null,
        },
      }),
    ];
    await render();
    expect(state.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "Agent finished",
        description: "Fix the login form",
      }),
    );
    state.add.mock.calls[0]?.[0].actionProps.onClick();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
  });

  it.each([
    ["hasPendingUserInput", "Input needed"],
    ["hasPendingApprovals", "Approval needed"],
  ] as const)("announces %s transitions", async (field, title) => {
    await render();
    state.shells = [shell({ [field]: true })];
    await render();
    expect(state.add).toHaveBeenCalledWith(expect.objectContaining({ title, type: "info" }));
  });

  it.each([
    ["session", { status: "error" }],
    [
      "latestTurn",
      {
        turnId: TurnId.make("turn-1"),
        state: "error",
        requestedAt: started,
        startedAt: started,
        completedAt: completed,
      },
    ],
  ] as const)("shows an error toast for a %s failure", async (field, value) => {
    await render();
    state.shells = [shell({ [field]: value })];
    await render();
    expect(state.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Thread failed",
        description: "Fix the login form",
      }),
    );
  });

  it("does not replay input transitions after an environment reconnect", async () => {
    await render();
    state.ready = new Set();
    await render();
    state.shells = [shell({ hasPendingApprovals: true })];
    state.ready = new Set(["env-1"]);
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });
});
