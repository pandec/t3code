import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProviderInstanceNotFoundError } from "./Errors.ts";
import {
  makeFailoverActivity,
  resolveTurnRouting,
  type FailoverRoutingDeps,
  type ThreadSelectionState,
} from "./rateLimitFailoverRouting.ts";
import type { ProviderInstanceRoutingInfo } from "./Services/ProviderAdapterRegistry.ts";
import type {
  ProviderInstanceHealthShape,
  ProviderInstanceRateLimitState,
} from "./Services/ProviderInstanceHealth.ts";

const THREAD_ID = ThreadId.make("thread-1");
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const MAIN = ProviderInstanceId.make("claude_main");
const SECOND = ProviderInstanceId.make("claude_second");
const SHARED_GROUP = "claude:home:/Users/x/.claude";

const selection = (instanceId: ProviderInstanceId, model = "opus"): ModelSelection => ({
  instanceId,
  model,
});

const info = (overrides: {
  readonly instanceId: ProviderInstanceId;
  readonly failoverInstanceId?: ProviderInstanceId;
  readonly enabled?: boolean;
  readonly continuationKey?: string;
  readonly driverKind?: ProviderDriverKind;
  readonly displayName?: string;
}): ProviderInstanceRoutingInfo => {
  const driverKind = overrides.driverKind ?? CLAUDE;
  return {
    instanceId: overrides.instanceId,
    driverKind,
    displayName: overrides.displayName,
    enabled: overrides.enabled ?? true,
    continuationIdentity: {
      driverKind,
      continuationKey: overrides.continuationKey ?? SHARED_GROUP,
    },
    ...(overrides.failoverInstanceId !== undefined
      ? { failoverInstanceId: overrides.failoverInstanceId }
      : {}),
  };
};

const limited = (until: number | null = 4_000_000_000_000): ProviderInstanceRateLimitState => ({
  until,
  reason: "usage limit reached (five_hour)",
  reportedAt: 0,
});

const makeDeps = (input: {
  readonly limits?: ReadonlyMap<ProviderInstanceId, ProviderInstanceRateLimitState>;
  readonly instances?: ReadonlyMap<ProviderInstanceId, ProviderInstanceRoutingInfo>;
  readonly missingInstances?: ReadonlySet<ProviderInstanceId>;
}): FailoverRoutingDeps => {
  const limits = input.limits ?? new Map();
  const instances = input.instances ?? new Map();
  const health: ProviderInstanceHealthShape = {
    reportRateLimitPayload: () => Effect.void,
    reportTurnOutcome: () => Effect.void,
    getRateLimitState: (instanceId) => Effect.succeed(limits.get(instanceId)),
  };
  return {
    health,
    getInstanceInfo: (instanceId) => {
      const found = instances.get(instanceId);
      if (found !== undefined) {
        return Effect.succeed(found);
      }
      return input.missingInstances?.has(instanceId) === true
        ? Effect.fail(new ProviderInstanceNotFoundError({ instanceId }))
        : Effect.die(new Error(`unexpected getInstanceInfo(${instanceId}) in test`));
    },
  };
};

const baseInput = {
  threadId: THREAD_ID,
  createdAt: CREATED_AT,
  preferred: selection(MAIN),
  requested: undefined,
  preferredInfo: info({ instanceId: MAIN, failoverInstanceId: SECOND }),
  previousSelectionState: undefined,
  activeInstanceId: undefined,
} as const;

describe("resolveTurnRouting — staying on the picked instance", () => {
  it.effect("does not reroute when the instance is not rate limited", () =>
    Effect.gen(function* () {
      const deps = makeDeps({});
      const routing = yield* resolveTurnRouting(deps, baseInput);
      expect(routing.bound.instanceId).toBe(MAIN);
      expect(routing.notice).toBeUndefined();
    }),
  );

  it.effect("keeps an explicit request as the restart comparison and records it", () =>
    Effect.gen(function* () {
      const requested = selection(MAIN, "sonnet");
      const routing = yield* resolveTurnRouting(makeDeps({}), {
        ...baseInput,
        preferred: requested,
        requested,
      });
      expect(routing.bound).toEqual(requested);
      expect(routing.restartComparisonSelection).toEqual(requested);
      expect(routing.recordSelectionState).toBe(true);
      expect(routing.notice).toBeUndefined();
    }),
  );

  it.effect("does not reroute when no failover sibling is configured", () =>
    Effect.gen(function* () {
      const deps = makeDeps({ limits: new Map([[MAIN, limited()]]) });
      const routing = yield* resolveTurnRouting(deps, {
        ...baseInput,
        preferredInfo: info({ instanceId: MAIN }),
      });
      expect(routing.bound.instanceId).toBe(MAIN);
    }),
  );

  it.effect("stays put when the configured failover instance is missing", () =>
    Effect.gen(function* () {
      const routing = yield* resolveTurnRouting(
        makeDeps({
          limits: new Map([[MAIN, limited()]]),
          missingInstances: new Set([SECOND]),
        }),
        baseInput,
      );
      expect(routing.bound.instanceId).toBe(MAIN);
      expect(routing.notice).toBeUndefined();
    }),
  );

  it.effect("does not reroute to itself", () =>
    Effect.gen(function* () {
      const deps = makeDeps({ limits: new Map([[MAIN, limited()]]) });
      const routing = yield* resolveTurnRouting(deps, {
        ...baseInput,
        preferredInfo: info({ instanceId: MAIN, failoverInstanceId: MAIN }),
      });
      expect(routing.bound.instanceId).toBe(MAIN);
    }),
  );

  it.effect("stays put when the target cannot resume the conversation", () =>
    Effect.gen(function* () {
      // Disabled, a different continuation group, and a different driver each
      // mean the sibling cannot take the thread over.
      const incompatible: ReadonlyArray<ProviderInstanceRoutingInfo> = [
        info({ instanceId: SECOND, enabled: false }),
        info({ instanceId: SECOND, continuationKey: "claude:home:/Users/x/.other" }),
        info({ instanceId: SECOND, driverKind: ProviderDriverKind.make("codex") }),
      ];
      for (const target of incompatible) {
        const routing = yield* resolveTurnRouting(
          makeDeps({
            limits: new Map([[MAIN, limited()]]),
            instances: new Map([[SECOND, target]]),
          }),
          baseInput,
        );
        expect(routing.bound.instanceId).toBe(MAIN);
        expect(routing.notice).toBeUndefined();
      }
    }),
  );

  it.effect("stays put when the target is rate limited too", () =>
    Effect.gen(function* () {
      const deps = makeDeps({
        limits: new Map([
          [MAIN, limited()],
          [SECOND, limited()],
        ]),
        instances: new Map([[SECOND, info({ instanceId: SECOND })]]),
      });
      const routing = yield* resolveTurnRouting(deps, baseInput);
      expect(routing.bound.instanceId).toBe(MAIN);
    }),
  );
});

describe("resolveTurnRouting — rerouting", () => {
  const rerouteDeps = makeDeps({
    limits: new Map([[MAIN, limited()]]),
    instances: new Map([[SECOND, info({ instanceId: SECOND, displayName: "Claude Personal" })]]),
  });

  it.effect("routes to the sibling, keeping the model, and announces the move", () =>
    Effect.gen(function* () {
      const routing = yield* resolveTurnRouting(rerouteDeps, baseInput);
      expect(routing.bound).toEqual({ instanceId: SECOND, model: "opus" });
      expect(routing.boundInfo.instanceId).toBe(SECOND);
      // The session must move, so restart detection needs a comparison even
      // though the turn supplied no selection.
      expect(routing.restartComparisonSelection).toEqual(routing.bound);
      expect(routing.recordSelectionState).toBe(true);
      expect(routing.notice).toMatchObject({
        direction: "failover",
        fromInstanceId: MAIN,
        toInstanceId: SECOND,
        toDisplayName: "Claude Personal",
      });
    }),
  );

  it.effect("stays quiet on later turns that are already on the sibling", () =>
    Effect.gen(function* () {
      const routing = yield* resolveTurnRouting(rerouteDeps, {
        ...baseInput,
        activeInstanceId: SECOND,
      });
      expect(routing.bound.instanceId).toBe(SECOND);
      expect(routing.notice).toBeUndefined();
    }),
  );

  it.effect("announces again when the user explicitly re-picks the limited instance", () =>
    Effect.gen(function* () {
      const routing = yield* resolveTurnRouting(rerouteDeps, {
        ...baseInput,
        requested: selection(MAIN),
        activeInstanceId: SECOND,
      });
      expect(routing.bound.instanceId).toBe(SECOND);
      expect(routing.notice).toMatchObject({ direction: "failover" });
    }),
  );
});

describe("resolveTurnRouting — routing back", () => {
  const routedAway: ThreadSelectionState = {
    preferred: selection(MAIN),
    effective: selection(SECOND),
  };

  it.effect("returns to the picked instance once its limit lifts", () =>
    Effect.gen(function* () {
      const routing = yield* resolveTurnRouting(makeDeps({}), {
        ...baseInput,
        previousSelectionState: routedAway,
        activeInstanceId: SECOND,
      });
      expect(routing.bound.instanceId).toBe(MAIN);
      // Without a comparison selection the session would stay on the sibling.
      expect(routing.restartComparisonSelection).toEqual(selection(MAIN));
      expect(routing.recordSelectionState).toBe(true);
      expect(routing.notice).toMatchObject({
        direction: "return",
        returnCause: "limit-lifted",
        fromInstanceId: SECOND,
        toInstanceId: MAIN,
      });
    }),
  );

  it.effect("returns and says so when the failover setting went away mid-limit", () =>
    Effect.gen(function* () {
      const routing = yield* resolveTurnRouting(
        makeDeps({ limits: new Map([[MAIN, limited()]]) }),
        {
          ...baseInput,
          // No failover sibling configured any more, but MAIN is still limited.
          preferredInfo: info({ instanceId: MAIN }),
          previousSelectionState: routedAway,
          activeInstanceId: SECOND,
        },
      );
      expect(routing.bound.instanceId).toBe(MAIN);
      expect(routing.notice).toMatchObject({
        direction: "return",
        returnCause: "failover-unavailable",
      });
    }),
  );

  it.effect("does not treat an unrelated thread state as a route-back", () =>
    Effect.gen(function* () {
      const routing = yield* resolveTurnRouting(makeDeps({}), {
        ...baseInput,
        // Never routed away: preferred and effective agree.
        previousSelectionState: { preferred: selection(MAIN), effective: selection(MAIN) },
        activeInstanceId: MAIN,
      });
      expect(routing.notice).toBeUndefined();
      expect(routing.restartComparisonSelection).toBeUndefined();
      expect(routing.recordSelectionState).toBe(false);
    }),
  );

  it.effect("announces an instance return without restarting for a different preferred model", () =>
    Effect.gen(function* () {
      const routing = yield* resolveTurnRouting(makeDeps({}), {
        ...baseInput,
        preferred: selection(MAIN, "sonnet"),
        previousSelectionState: routedAway,
        activeInstanceId: SECOND,
      });
      // The old notice block matched instance ids, while the old implicit
      // restart branch required the full preferred selection to match.
      expect(routing.notice).toMatchObject({
        direction: "return",
        fromInstanceId: SECOND,
        toInstanceId: MAIN,
      });
      expect(routing.restartComparisonSelection).toBeUndefined();
      expect(routing.recordSelectionState).toBe(false);
    }),
  );
});

describe("makeFailoverActivity", () => {
  const activityId = EventId.make("11111111-1111-4111-8111-111111111111");

  it("spells the window and reset time into the rendered detail", () => {
    const activity = makeFailoverActivity(
      {
        threadId: THREAD_ID,
        direction: "failover",
        fromInstanceId: MAIN,
        toInstanceId: SECOND,
        toDisplayName: "Claude Personal",
        reason: "usage limit reached (five_hour)",
        until: 1_800_000_000_000,
        createdAt: CREATED_AT,
      },
      activityId,
    );
    expect(activity.summary).toBe("Rate limited — failing over to Claude Personal");
    expect(activity.turnId).toBeNull();
    const payload = activity.payload as { detail: string; limitedUntil?: number };
    expect(payload.detail).toContain("five_hour");
    expect(payload.detail).toContain("2027-01-15T08:00:00.000Z");
    expect(payload.limitedUntil).toBe(1_800_000_000_000);
  });

  it("falls back to the instance id when the target has no display name", () => {
    const activity = makeFailoverActivity(
      {
        threadId: THREAD_ID,
        direction: "return",
        returnCause: "limit-lifted",
        fromInstanceId: SECOND,
        toInstanceId: MAIN,
        toDisplayName: undefined,
        reason: undefined,
        until: null,
        createdAt: CREATED_AT,
      },
      activityId,
    );
    expect(activity.summary).toBe(`Usage limit lifted — back on ${MAIN}`);
    expect((activity.payload as { detail: string }).detail).toContain(SECOND);
  });
});
