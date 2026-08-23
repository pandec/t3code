import type { Dispatch, ReactElement, SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  type EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { Cause } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";

import type {
  LocalEnvironmentUpdateGroup,
  ProviderUpdateCandidate,
  ProviderUpdateRowStatus,
  ProviderUpdateToastView,
} from "./ProviderUpdateLaunchNotification.logic";

const testState = vi.hoisted(() => ({
  groups: [] as LocalEnvironmentUpdateGroup[],
  updateProvider: vi.fn(),
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];

  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useCallback<T>(callback: T): T {
      nextIndex();
      return callback;
    },
    useMemo<T>(factory: () => T): T {
      nextIndex();
      return factory();
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: hooks.useMemoCache,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: { updateProvider: Symbol("updateProvider") },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateProvider,
}));

vi.mock("./ProviderUpdateLaunchNotification.environments", () => ({
  useLocalEnvironmentUpdateGroups: () => ({
    groups: testState.groups,
    isAnySettling: false,
  }),
}));

import {
  createProviderUpdateResultDelivery,
  ProviderUpdateEnvironmentRows,
  type ProviderUpdateResultClaim,
} from "./ProviderUpdateEnvironmentRows";

const environmentId = "env-wsl" as EnvironmentId;
const pendingExpiryMs = 6 * 60_000;

function provider(
  updateStatus?: "failed" | "succeeded" | "unchanged",
  timestamps: {
    readonly startedAt?: string;
    readonly finishedAt?: string;
  } = {},
): ServerProvider {
  const succeeded = updateStatus === "succeeded";
  const result: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex-wsl"),
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
          startedAt: timestamps.startedAt ?? "2026-06-26T12:00:01.000Z",
          finishedAt: timestamps.finishedAt ?? "2026-06-26T12:00:02.000Z",
          message: updateStatus === "failed" ? "Provider update failed." : "Provider updated.",
          output: null,
        },
      }
    : result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

type RowElement = ReactElement<{
  readonly status: ProviderUpdateRowStatus;
  readonly onUpdate: () => void;
}>;

function renderRow(
  callbacks: {
    readonly onUpdateFinished?: (
      environmentId: EnvironmentId,
      generation: number,
      view: ProviderUpdateToastView,
    ) => void;
    readonly onUpdateStarted?: (claim: ProviderUpdateResultClaim) => void;
  } = {},
): RowElement {
  hooks.beginRender();
  const output = ProviderUpdateEnvironmentRows(callbacks) as ReactElement<{
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

describe("ProviderUpdateEnvironmentRows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T12:00:00.000Z"));
    hooks.reset();
    testState.updateProvider.mockReset();
    const candidate = provider() as ProviderUpdateCandidate;
    testState.groups = [
      {
        environmentId,
        label: "WSL",
        isPrimary: false,
        isSettling: false,
        candidates: [candidate],
        providers: [candidate],
      },
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a successor pending when an expired request resolves late, then shows its success", async () => {
    const firstRequest =
      deferred<ReturnType<typeof AsyncResult.success<{ providers: ServerProvider[] }>>>();
    const successorRequest =
      deferred<ReturnType<typeof AsyncResult.success<{ providers: ServerProvider[] }>>>();
    testState.updateProvider
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(successorRequest.promise);

    renderRow().props.onUpdate();
    expect(renderRow().props.status.kind).toBe("loading");

    await vi.advanceTimersByTimeAsync(pendingExpiryMs);
    expect(renderRow().props.status.kind).toBe("failed");

    renderRow().props.onUpdate();
    expect(testState.updateProvider).toHaveBeenCalledTimes(2);
    expect(renderRow().props.status.kind).toBe("loading");

    firstRequest.resolve(AsyncResult.success({ providers: [provider("succeeded")] }));
    await flushPromises();

    expect(renderRow().props.status.kind).toBe("loading");

    successorRequest.resolve(
      AsyncResult.success({
        providers: [
          provider("succeeded", {
            startedAt: "2026-06-26T12:06:01.000Z",
            finishedAt: "2026-06-26T12:06:02.000Z",
          }),
        ],
      }),
    );
    await flushPromises();

    expect(renderRow().props.status.kind).toBe("success");
  });

  it("keeps a live terminal result when the command response hangs", async () => {
    const request =
      deferred<ReturnType<typeof AsyncResult.success<{ providers: ServerProvider[] }>>>();
    const onUpdateFinished = vi.fn();
    testState.updateProvider.mockReturnValue(request.promise);

    renderRow({ onUpdateFinished }).props.onUpdate();
    testState.groups = [
      {
        ...testState.groups[0]!,
        candidates: [],
        providers: [provider("succeeded")],
      },
    ];
    expect(renderRow({ onUpdateFinished }).props.status.kind).toBe("success");

    await vi.advanceTimersByTimeAsync(pendingExpiryMs);
    expect(renderRow({ onUpdateFinished }).props.status.kind).toBe("success");
    expect(onUpdateFinished).toHaveBeenCalledTimes(1);
    expect(onUpdateFinished).toHaveBeenCalledWith(
      environmentId,
      1,
      expect.objectContaining({ phase: "succeeded" }),
    );
  });

  it("turns an interrupted dispatch into a retryable result", async () => {
    const onUpdateFinished = vi.fn();
    testState.updateProvider.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));

    renderRow({ onUpdateFinished }).props.onUpdate();
    await flushPromises();

    expect(renderRow({ onUpdateFinished }).props.status.kind).toBe("failed");
    expect(onUpdateFinished).toHaveBeenCalledTimes(1);
    expect(onUpdateFinished).toHaveBeenCalledWith(
      environmentId,
      1,
      expect.objectContaining({
        phase: "failed",
        description: "Provider update was interrupted. Try again.",
      }),
    );
  });
});

describe("provider update result delivery", () => {
  const unchangedView: ProviderUpdateToastView = {
    phase: "unchanged",
    type: "warning",
    title: "Provider still needs an update",
    description: "Codex still appears outdated.",
  };

  function claim(
    generation = 1,
    startedAfterIso = "2026-06-26T12:00:00.000Z",
  ): ProviderUpdateResultClaim {
    return {
      environmentId,
      generation,
      providerCount: 1,
      providerInstanceIds: new Set([ProviderInstanceId.make("codex-wsl")]),
      startedAfterIso,
    };
  }

  function groupWith(providerSnapshot: ServerProvider): LocalEnvironmentUpdateGroup {
    return {
      ...testState.groups[0]!,
      candidates: [provider() as ProviderUpdateCandidate],
      providers: [providerSnapshot],
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    testState.groups = [
      {
        environmentId,
        label: "WSL",
        isPrimary: false,
        isSettling: false,
        candidates: [provider() as ProviderUpdateCandidate],
        providers: [provider()],
      },
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a dismissed popover's result exactly once", () => {
    let isPopoverOpen = true;
    const onResult = vi.fn();
    const delivery = createProviderUpdateResultDelivery({
      isPopoverOpen: () => isPopoverOpen,
      onResult,
    });
    delivery.startUpdate(claim());
    isPopoverOpen = false;

    expect(delivery.finishUpdate(environmentId, 1, unchangedView)).toBe(true);
    expect(delivery.finishUpdate(environmentId, 1, unchangedView)).toBe(false);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(unchangedView);
  });

  it("keeps a terminal result in the open popover", () => {
    const onResult = vi.fn();
    const delivery = createProviderUpdateResultDelivery({
      isPopoverOpen: () => true,
      onResult,
    });
    delivery.startUpdate(claim());

    expect(delivery.finishUpdate(environmentId, 1, unchangedView)).toBe(true);
    expect(onResult).not.toHaveBeenCalled();
  });

  it("lets a fresh live unchanged state claim before the RPC result", () => {
    const onResult = vi.fn();
    const delivery = createProviderUpdateResultDelivery({
      isPopoverOpen: () => false,
      onResult,
    });
    delivery.startUpdate(claim());

    delivery.observeGroups([groupWith(provider("unchanged"))]);
    expect(delivery.finishUpdate(environmentId, 1, unchangedView)).toBe(false);

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ phase: "unchanged" }));
  });

  it("rejects stale terminal state and an older attempt's completion", () => {
    const onResult = vi.fn();
    const delivery = createProviderUpdateResultDelivery({
      isPopoverOpen: () => false,
      onResult,
    });
    delivery.startUpdate(claim(1, "2026-06-26T12:00:00.000Z"));
    delivery.startUpdate(claim(2, "2026-06-26T12:00:03.000Z"));

    delivery.observeGroups([
      groupWith(
        provider("unchanged", {
          startedAt: "2026-06-26T12:00:01.000Z",
          finishedAt: "2026-06-26T12:00:04.000Z",
        }),
      ),
    ]);
    expect(delivery.finishUpdate(environmentId, 1, unchangedView)).toBe(false);
    expect(onResult).not.toHaveBeenCalled();

    delivery.observeGroups([
      groupWith(
        provider("unchanged", {
          startedAt: "2026-06-26T12:00:04.000Z",
          finishedAt: "2026-06-26T12:00:05.000Z",
        }),
      ),
    ]);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it("reports expiry once after the popover is dismissed", async () => {
    const onResult = vi.fn();
    const delivery = createProviderUpdateResultDelivery({
      isPopoverOpen: () => false,
      onResult,
    });
    delivery.startUpdate(claim());

    await vi.advanceTimersByTimeAsync(pendingExpiryMs);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "failed", description: "Update timed out. Try again." }),
    );
    expect(delivery.finishUpdate(environmentId, 1, unchangedView)).toBe(false);
    expect(onResult).toHaveBeenCalledTimes(1);
  });
});
