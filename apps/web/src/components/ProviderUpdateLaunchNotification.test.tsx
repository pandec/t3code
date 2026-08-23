import type { Dispatch, ReactElement, SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  type EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

import type {
  LocalEnvironmentUpdateGroup,
  ProviderUpdateCandidate,
  ProviderUpdateRowStatus,
} from "./ProviderUpdateLaunchNotification.logic";

const testState = vi.hoisted(() => ({
  addProviderUpdateToast: vi.fn(),
  dismissNotificationKey: vi.fn(),
  dismissedNotificationKeys: new Set<string>(),
  groups: [] as LocalEnvironmentUpdateGroup[],
  navigate: vi.fn(),
  toastAdd: vi.fn(),
  toastClose: vi.fn(),
  updateProvider: vi.fn(),
}));

const hooks = vi.hoisted(() => {
  interface EffectSlot {
    readonly kind: "effect";
    readonly deps: ReadonlyArray<unknown> | undefined;
    cleanup: (() => void) | undefined;
  }

  interface MemoSlot {
    readonly kind: "memo";
    readonly deps: ReadonlyArray<unknown> | undefined;
    readonly value: unknown;
  }

  interface RefSlot {
    readonly kind: "ref";
    readonly value: { current: unknown };
  }

  interface StateSlot {
    readonly kind: "state";
    value: unknown;
  }

  type Slot = EffectSlot | MemoSlot | RefSlot | StateSlot | unknown[];
  interface Context {
    cursor: number;
    readonly pendingEffects: Array<{
      readonly effect: () => void | (() => void);
      readonly index: number;
      readonly previousCleanup: (() => void) | undefined;
    }>;
    readonly slots: Slot[];
  }

  const contexts = new Map<string, Context>();
  let currentContextKey: string | null = null;

  const context = (): Context => {
    if (currentContextKey === null) {
      throw new Error("Hook called outside a test render.");
    }
    let value = contexts.get(currentContextKey);
    if (!value) {
      value = { cursor: 0, pendingEffects: [], slots: [] };
      contexts.set(currentContextKey, value);
    }
    return value;
  };

  const nextIndex = (): number => context().cursor++;
  const depsChanged = (
    previous: ReadonlyArray<unknown> | undefined,
    next: ReadonlyArray<unknown> | undefined,
  ): boolean =>
    previous === undefined ||
    next === undefined ||
    previous.length !== next.length ||
    previous.some((value, index) => !Object.is(value, next[index]));

  return {
    flushEffects(key: string): void {
      const value = contexts.get(key);
      if (!value) return;
      const effects = value.pendingEffects.splice(0);
      for (const pending of effects) {
        pending.previousCleanup?.();
        const cleanup = pending.effect();
        const slot = value.slots[pending.index];
        if (slot && !Array.isArray(slot) && slot.kind === "effect") {
          slot.cleanup = cleanup ?? undefined;
        }
      }
    },
    render<T>(key: string, render: () => T): T {
      currentContextKey = key;
      const value = context();
      value.cursor = 0;
      try {
        return render();
      } finally {
        currentContextKey = null;
      }
    },
    reset(): void {
      for (const value of contexts.values()) {
        for (const slot of value.slots) {
          if (slot && !Array.isArray(slot) && slot.kind === "effect") {
            slot.cleanup?.();
          }
        }
      }
      contexts.clear();
      currentContextKey = null;
    },
    useCallback<T>(callback: T, deps?: ReadonlyArray<unknown>): T {
      const index = nextIndex();
      const value = context();
      const previous = value.slots[index];
      if (
        previous &&
        !Array.isArray(previous) &&
        previous.kind === "memo" &&
        !depsChanged(previous.deps, deps)
      ) {
        return previous.value as T;
      }
      value.slots[index] = { kind: "memo", deps, value: callback };
      return callback;
    },
    useEffect(effect: () => void | (() => void), deps?: ReadonlyArray<unknown>): void {
      const index = nextIndex();
      const value = context();
      const previous = value.slots[index];
      if (
        previous &&
        !Array.isArray(previous) &&
        previous.kind === "effect" &&
        !depsChanged(previous.deps, deps)
      ) {
        return;
      }
      const previousCleanup =
        previous && !Array.isArray(previous) && previous.kind === "effect"
          ? previous.cleanup
          : undefined;
      value.slots[index] = { kind: "effect", deps, cleanup: previousCleanup };
      value.pendingEffects.push({ effect, index, previousCleanup });
    },
    useMemo<T>(factory: () => T, deps?: ReadonlyArray<unknown>): T {
      const index = nextIndex();
      const value = context();
      const previous = value.slots[index];
      if (
        previous &&
        !Array.isArray(previous) &&
        previous.kind === "memo" &&
        !depsChanged(previous.deps, deps)
      ) {
        return previous.value as T;
      }
      const next = factory();
      value.slots[index] = { kind: "memo", deps, value: next };
      return next;
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      const value = context();
      const previous = value.slots[index];
      if (Array.isArray(previous)) {
        return previous;
      }
      const next = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      value.slots[index] = next;
      return next;
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      const value = context();
      const previous = value.slots[index];
      if (previous && !Array.isArray(previous) && previous.kind === "ref") {
        return previous.value as { current: T };
      }
      const next = { current: initialValue };
      value.slots[index] = { kind: "ref", value: next as { current: unknown } };
      return next;
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      const value = context();
      let slot = value.slots[index];
      if (!slot || Array.isArray(slot) || slot.kind !== "state") {
        slot = {
          kind: "state",
          value: typeof initialValue === "function" ? (initialValue as () => T)() : initialValue,
        };
        value.slots[index] = slot;
      }
      const stateSlot = slot as StateSlot;
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        stateSlot.value =
          typeof nextValue === "function"
            ? (nextValue as (previous: T) => T)(stateSlot.value as T)
            : nextValue;
      };
      return [stateSlot.value as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => testState.navigate }));
vi.mock("~/connection/desktopLocal", () => ({ isDesktopLocalConnectionTarget: () => false }));
vi.mock("~/state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("~/state/server", () => ({
  serverEnvironment: { updateProvider: Symbol("updateProvider") },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateProvider,
}));
vi.mock("../providerUpdateDismissal", () => ({
  useDismissedProviderUpdateNotificationKeys: () => ({
    dismissedNotificationKeys: testState.dismissedNotificationKeys,
    dismissNotificationKey: testState.dismissNotificationKey,
  }),
}));
vi.mock("./ProviderUpdateLaunchNotification.environments", () => ({
  useLocalEnvironmentUpdateGroups: () => ({
    groups: testState.groups,
    isAnySettling: false,
  }),
}));
vi.mock("./ProviderUpdatePrimaryNotification", () => ({
  addProviderUpdateToast: testState.addProviderUpdateToast,
  ProviderUpdatePrimaryNotification: () => null,
}));
vi.mock("./ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: testState.toastAdd,
    close: testState.toastClose,
  },
}));

import { ProviderUpdateEnvironmentRows } from "./ProviderUpdateEnvironmentRows";
import { ProviderUpdateEnvironmentsNotification } from "./ProviderUpdateLaunchNotification";

let fixtureIndex = 0;

function provider(
  environmentId: EnvironmentId,
  updateStatus?: "succeeded" | "unchanged",
): ServerProvider {
  const succeeded = updateStatus === "succeeded";
  const suffix = environmentId as string;
  const result: ServerProvider = {
    instanceId: ProviderInstanceId.make(`codex-${suffix}`),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: succeeded ? "1.1.0" : "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-26T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: succeeded ? "current" : "behind_latest",
      currentVersion: succeeded ? "1.1.0" : "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "npm install -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-06-26T12:00:00.000Z",
      message: succeeded ? "Up to date." : "Update available.",
    },
  };
  return updateStatus
    ? {
        ...result,
        updateState: {
          status: updateStatus,
          startedAt: "2026-06-26T12:00:01.000Z",
          finishedAt: "2026-06-26T12:00:02.000Z",
          message: "Provider update finished.",
          output: null,
        },
      }
    : result;
}

function setGroup(environmentId: EnvironmentId, snapshot = provider(environmentId)): void {
  const candidate = provider(environmentId) as ProviderUpdateCandidate;
  testState.groups = [
    {
      environmentId,
      label: "WSL",
      isPrimary: false,
      isSettling: false,
      candidates: [candidate],
      providers: [snapshot],
    },
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function renderHost(): void {
  hooks.render("host", () => ProviderUpdateEnvironmentsNotification());
  hooks.flushEffects("host");
}

type RowElement = ReactElement<{
  readonly status: ProviderUpdateRowStatus;
  readonly onUpdate: () => void;
}>;

type PromptToast = {
  readonly data: { readonly onClose: () => void };
  readonly description: ReactElement<Parameters<typeof ProviderUpdateEnvironmentRows>[0]>;
};

function promptToast(): PromptToast {
  return testState.toastAdd.mock.calls[0]![0] as PromptToast;
}

function renderRows(description: PromptToast["description"]): RowElement {
  const output = hooks.render("rows", () =>
    ProviderUpdateEnvironmentRows(description.props),
  ) as ReactElement<{
    readonly children: RowElement | RowElement[];
  }>;
  const children = output.props.children;
  return Array.isArray(children) ? children[0]! : children;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ProviderUpdateEnvironmentsNotification result ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T12:00:00.000Z"));
    hooks.reset();
    testState.addProviderUpdateToast.mockReset();
    testState.dismissNotificationKey.mockReset();
    testState.dismissedNotificationKeys.clear();
    testState.navigate.mockReset();
    testState.toastAdd.mockReset().mockReturnValue(1);
    testState.toastClose.mockReset();
    testState.updateProvider.mockReset();
    fixtureIndex += 1;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers an RPC-first unchanged result once after dismissal", async () => {
    const environmentId = `env-rpc-${fixtureIndex}` as EnvironmentId;
    const request =
      deferred<ReturnType<typeof AsyncResult.success<{ providers: ServerProvider[] }>>>();
    setGroup(environmentId);
    testState.updateProvider.mockReturnValue(request.promise);
    renderHost();

    const prompt = promptToast();
    renderRows(prompt.description).props.onUpdate();
    expect(testState.toastClose).not.toHaveBeenCalled();
    prompt.data.onClose();

    const terminalProvider = provider(environmentId, "unchanged");
    request.resolve(AsyncResult.success({ providers: [terminalProvider] }));
    await flushPromises();
    expect(testState.addProviderUpdateToast).toHaveBeenCalledTimes(1);
    expect(testState.addProviderUpdateToast).toHaveBeenCalledWith(
      expect.objectContaining({ view: expect.objectContaining({ phase: "unchanged" }) }),
    );

    setGroup(environmentId, terminalProvider);
    renderHost();
    expect(testState.addProviderUpdateToast).toHaveBeenCalledTimes(1);
  });

  it("delivers a live-state-first unchanged result once after dismissal", async () => {
    const environmentId = `env-live-${fixtureIndex}` as EnvironmentId;
    const request =
      deferred<ReturnType<typeof AsyncResult.success<{ providers: ServerProvider[] }>>>();
    setGroup(environmentId);
    testState.updateProvider.mockReturnValue(request.promise);
    renderHost();

    const prompt = promptToast();
    renderRows(prompt.description).props.onUpdate();
    expect(testState.toastClose).not.toHaveBeenCalled();
    prompt.data.onClose();

    const terminalProvider = provider(environmentId, "unchanged");
    setGroup(environmentId, terminalProvider);
    expect(renderRows(prompt.description).props.status.kind).toBe("unchanged");
    renderHost();
    expect(testState.addProviderUpdateToast).toHaveBeenCalledTimes(1);

    request.resolve(AsyncResult.success({ providers: [terminalProvider] }));
    await flushPromises();
    expect(testState.addProviderUpdateToast).toHaveBeenCalledTimes(1);
    expect(testState.addProviderUpdateToast).toHaveBeenCalledWith(
      expect.objectContaining({ view: expect.objectContaining({ phase: "unchanged" }) }),
    );
  });
});
