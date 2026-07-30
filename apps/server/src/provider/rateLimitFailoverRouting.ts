/**
 * Rate-limit failover routing — decides which provider instance a turn runs
 * on when the one the user picked is out of subscription usage.
 *
 * Fork-only. Extracted from `ProviderCommandReactor` so the (upstream-owned)
 * reactor keeps just a call to `resolveTurnRouting` plus a dispatch of the
 * activity this module builds, instead of carrying the whole decision inline.
 *
 * The decision is returned as one immutable `TurnRouting` record rather than
 * applied by mutating the caller's selection variables: the caller then has a
 * single unambiguous "the turn runs here" value (`bound`) and a separate
 * "compare against this when deciding whether to restart the session"
 * (`restartComparisonSelection`), which are genuinely different things once a
 * reroute is in play.
 *
 * @module provider/rateLimitFailoverRouting
 */
import type {
  ModelSelection,
  OrchestrationThreadActivity,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";

import type { ProviderServiceError } from "./Errors.ts";
import type { ProviderInstanceRoutingInfo } from "./Services/ProviderAdapterRegistry.ts";
import type { ProviderInstanceRateLimitState } from "./Services/ProviderInstanceHealth.ts";

/** Activity kind appended to a thread whenever routing moves between instances. */
const FAILOVER_ACTIVITY_KIND = "provider.instance.failover";

/**
 * What the caller last routed for this thread: the instance the user picked
 * (`preferred`) and the one the turn actually ran on (`effective`). They
 * differ exactly while a failover is in effect, which is how a later turn
 * knows to route back.
 */
export interface ThreadSelectionState {
  readonly preferred: ModelSelection;
  readonly effective: ModelSelection;
}

interface FailoverNoticeBase {
  readonly threadId: ThreadId;
  readonly fromInstanceId: ProviderInstanceId;
  readonly toInstanceId: ProviderInstanceId;
  readonly toDisplayName: string | undefined;
  readonly createdAt: string;
}

/**
 * A pending work-log notice describing a routing move. Discriminated on
 * `direction` so a limit reason can only ride along with a failover and a
 * return cause only with a return — the two carry disjoint evidence.
 */
export type FailoverNotice =
  | (FailoverNoticeBase & {
      readonly direction: "failover";
      readonly reason: string;
      readonly toDisplayNameIsUnique: boolean;
      /** Unix ms the limit is expected to lift, or null when unreported. */
      readonly until: number | null;
    })
  | (FailoverNoticeBase & {
      readonly direction: "return";
      readonly returnCause: "limit-lifted" | "failover-unavailable";
    });

export interface TurnRouting {
  /** The selection the turn actually runs on, after any reroute. */
  readonly bound: ModelSelection;
  /** Routing info for `bound.instanceId` — what continuation guards compare. */
  readonly boundInfo: ProviderInstanceRoutingInfo;
  /**
   * The selection restart detection compares against, or undefined to leave
   * an existing session alone. A reroute (or a route back) sets this even
   * when the caller supplied no selection, because the session must move.
   */
  readonly restartComparisonSelection: ModelSelection | undefined;
  /**
   * Selection state to persist for this thread, or undefined to leave the
   * stored state alone. Returned whole rather than as a "should record" flag
   * so the `{preferred, effective}` pairing — which route-back detection
   * depends on — stays owned by this module.
   */
  readonly selectionState: ThreadSelectionState | undefined;
  /** Work-log notice to append once the session settles on `bound`. */
  readonly notice: FailoverNotice | undefined;
}

export interface FailoverRoutingDeps {
  readonly getRateLimitState: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRateLimitState | undefined>;
  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>;
  readonly isDisplayNameUnique: (
    instanceId: ProviderInstanceId,
    displayName: string,
  ) => Effect.Effect<boolean>;
}

export interface ResolveTurnRoutingInput {
  readonly threadId: ThreadId;
  readonly createdAt: string;
  /** The instance the user picked (explicitly this turn, or the thread default). */
  readonly preferred: ModelSelection;
  /** Only set when this turn carried an explicit selection. */
  readonly requested: ModelSelection | undefined;
  readonly preferredInfo: ProviderInstanceRoutingInfo;
  readonly previousSelectionState: ThreadSelectionState | undefined;
  readonly activeInstanceId: ProviderInstanceId | undefined;
}

/**
 * Resolve the failover sibling for an instance that is out of usage.
 *
 * Returns undefined (no reroute) unless every condition holds: the preferred
 * instance is currently rate-limited, it names a failover sibling, and the
 * sibling is a configured, enabled instance of the same driver in the same
 * continuation group that is not itself rate-limited. Failing any check leaves
 * the turn on the preferred instance — the failure it hits there is more
 * diagnosable than a surprising reroute.
 */
const resolveFailoverTarget = Effect.fn("rateLimitFailover.resolveTarget")(function* (
  deps: FailoverRoutingDeps,
  preferredInstanceId: ProviderInstanceId,
  preferredInfo: ProviderInstanceRoutingInfo,
) {
  const failoverInstanceId = preferredInfo.failoverInstanceId;
  if (failoverInstanceId === undefined || failoverInstanceId === preferredInstanceId) {
    return undefined;
  }
  const limitState = yield* deps.getRateLimitState(preferredInstanceId);
  if (limitState === undefined) {
    return undefined;
  }
  const targetInfo = yield* deps.getInstanceInfo(failoverInstanceId).pipe(Effect.option);
  if (Option.isNone(targetInfo)) {
    yield* Effect.logWarning("Rate-limit failover target is not configured; staying put.", {
      preferredInstanceId,
      failoverInstanceId,
    });
    return undefined;
  }
  const info = targetInfo.value;
  if (
    !info.enabled ||
    info.driverKind !== preferredInfo.driverKind ||
    info.continuationIdentity.continuationKey !== preferredInfo.continuationIdentity.continuationKey
  ) {
    yield* Effect.logWarning(
      "Rate-limit failover target is not continuation-compatible; staying put.",
      {
        preferredInstanceId,
        failoverInstanceId,
        targetEnabled: info.enabled,
        targetDriverKind: info.driverKind,
      },
    );
    return undefined;
  }
  if ((yield* deps.getRateLimitState(failoverInstanceId)) !== undefined) {
    yield* Effect.logInfo("Rate-limit failover target is also rate-limited; staying put.", {
      preferredInstanceId,
      failoverInstanceId,
    });
    return undefined;
  }
  const displayNameIsUnique =
    info.displayName === undefined
      ? false
      : yield* deps.isDisplayNameUnique(info.instanceId, info.displayName);
  return { info, limitState, displayNameIsUnique };
});

/** Whether this thread's last turn ran somewhere other than the user's pick. */
function wasRoutedAway(state: ThreadSelectionState | undefined): state is ThreadSelectionState {
  return state !== undefined && !Equal.equals(state.preferred, state.effective);
}

/**
 * Decide where a turn runs. Exactly one of three outcomes:
 *
 *  - **stay** — `bound` is the picked instance and there is no notice. The
 *    common case: the instance is fine, or no usable sibling exists.
 *  - **reroute** — the pick is rate-limited and a compatible, healthy sibling
 *    is configured. `bound` is the sibling and `restartComparisonSelection` is
 *    set so the session moves; a notice is produced unless the thread already
 *    sits there and the user did not ask for the limited instance again.
 *  - **route back** — a previous turn was rerouted away from this same pick
 *    and the limit (or the failover setting) is gone. `bound` is the pick
 *    again, with a notice naming why.
 *
 * Never fails: every dependency error is absorbed into "stay", because a
 * diagnosable failure on the picked instance beats a surprising reroute.
 */
export const resolveTurnRouting = Effect.fn("rateLimitFailover.resolveTurnRouting")(function* (
  deps: FailoverRoutingDeps,
  input: ResolveTurnRoutingInput,
): Effect.fn.Return<TurnRouting> {
  const preferredInstanceId = input.preferred.instanceId;
  const failoverTarget = yield* resolveFailoverTarget(
    deps,
    preferredInstanceId,
    input.preferredInfo,
  );

  if (failoverTarget !== undefined) {
    const bound: ModelSelection = {
      ...input.preferred,
      instanceId: failoverTarget.info.instanceId,
    };
    yield* Effect.logInfo("Rerouting turn to rate-limit failover instance.", {
      threadId: input.threadId,
      fromInstanceId: preferredInstanceId,
      toInstanceId: bound.instanceId,
      reason: failoverTarget.limitState.reason,
    });
    // Announce only when the session actually moves — repeating the notice on
    // every turn while the thread already sits on the sibling is noise. The
    // exception is an explicit re-pick of the limited instance: silently
    // overriding the user's choice would leave them no feedback at all.
    const userRequestedLimitedInstance = input.requested?.instanceId === preferredInstanceId;
    const announce = input.activeInstanceId !== bound.instanceId || userRequestedLimitedInstance;
    return {
      bound,
      boundInfo: failoverTarget.info,
      restartComparisonSelection: bound,
      selectionState: { preferred: input.preferred, effective: bound },
      notice: announce
        ? {
            threadId: input.threadId,
            direction: "failover",
            fromInstanceId: preferredInstanceId,
            toInstanceId: bound.instanceId,
            toDisplayName: failoverTarget.info.displayName,
            toDisplayNameIsUnique: failoverTarget.displayNameIsUnique,
            reason: failoverTarget.limitState.reason,
            until: failoverTarget.limitState.until,
            createdAt: input.createdAt,
          }
        : undefined,
    };
  }

  // No reroute. If a previous turn was routed away from this same preferred
  // selection and the session still sits there, route it back — even when this
  // turn carried no explicit selection, and even if the failover setting was
  // cleared or changed while the session was away.
  const previous = input.previousSelectionState;
  const routingBack =
    wasRoutedAway(previous) &&
    input.activeInstanceId === previous.effective.instanceId &&
    preferredInstanceId === previous.preferred.instanceId;

  // Moving the session back needs a comparison selection even when the turn
  // supplied none; require full selection equality so an unrelated model
  // change is not mistaken for a route-back.
  const restartComparisonSelection =
    input.requested ??
    (routingBack && Equal.equals(previous?.preferred, input.preferred)
      ? input.preferred
      : undefined);

  // Close the loop the failover notice opened: without this the log ends on
  // "failing over" forever and the reader cannot tell which account later
  // turns ran on. Keyed on the outcome, so an explicitly-supplied selection
  // returns the thread just as visibly as an omitted one. The routing decision
  // is already made; this health read only picks accurate wording (the limit
  // lifting and the failover setting going away both land here).
  let notice: FailoverNotice | undefined;
  if (routingBack && previous !== undefined) {
    const preferredLimitState = yield* deps.getRateLimitState(preferredInstanceId);
    notice = {
      threadId: input.threadId,
      direction: "return",
      returnCause: preferredLimitState === undefined ? "limit-lifted" : "failover-unavailable",
      fromInstanceId: previous.effective.instanceId,
      toInstanceId: preferredInstanceId,
      toDisplayName: input.preferredInfo.displayName,
      createdAt: input.createdAt,
    };
  }

  return {
    bound: input.preferred,
    boundInfo: input.preferredInfo,
    restartComparisonSelection,
    selectionState:
      input.requested !== undefined || restartComparisonSelection !== undefined
        ? { preferred: input.preferred, effective: input.preferred }
        : undefined,
    notice,
  };
});

/**
 * Build the work-log activity for a routing move. Kept pure (the caller owns
 * ids and dispatch) so the rendered wording is testable on its own.
 *
 * The work log renders `summary` plus `payload.detail`; the structured payload
 * fields are for programmatic consumers, so anything the reader needs — the
 * limiting window, the reset time — has to be spelled out in `detail`.
 */
export function makeFailoverActivity(
  notice: FailoverNotice,
  activityId: OrchestrationThreadActivity["id"],
): OrchestrationThreadActivity {
  const target =
    notice.toDisplayName === undefined
      ? notice.toInstanceId
      : notice.direction === "failover" && !notice.toDisplayNameIsUnique
        ? `${notice.toDisplayName} (${notice.toInstanceId})`
        : notice.toDisplayName;
  if (notice.direction === "failover") {
    const detail =
      notice.until !== null
        ? `${notice.reason}; resets ${formatResetTime(notice.until, notice.createdAt)}`
        : notice.reason;
    return {
      id: activityId,
      tone: "info",
      kind: FAILOVER_ACTIVITY_KIND,
      summary: `Rate limited — failing over to ${target}`,
      payload: {
        direction: notice.direction,
        fromInstanceId: notice.fromInstanceId,
        toInstanceId: notice.toInstanceId,
        detail,
        reason: notice.reason,
        ...(notice.until !== null ? { limitedUntil: notice.until } : {}),
      },
      turnId: null,
      createdAt: notice.createdAt,
    };
  }
  const limitLifted = notice.returnCause === "limit-lifted";
  return {
    id: activityId,
    tone: "info",
    kind: FAILOVER_ACTIVITY_KIND,
    summary: limitLifted ? `Usage limit lifted — back on ${target}` : `Back on ${target}`,
    payload: {
      direction: notice.direction,
      returnCause: notice.returnCause,
      fromInstanceId: notice.fromInstanceId,
      toInstanceId: notice.toInstanceId,
      detail: limitLifted
        ? `Usage limit on ${notice.fromInstanceId} lifted.`
        : `Failover to ${notice.fromInstanceId} is no longer available.`,
    },
    turnId: null,
    createdAt: notice.createdAt,
  };
}

/**
 * Render a reset time for the persisted work-log detail.
 *
 * Formatted in the server's locale and zone, because the detail string is
 * written once and then read verbatim by every client. That makes the zone
 * ambiguous for a client elsewhere, so the zone name is always included;
 * `limitedUntil` stays in the payload as the authoritative instant for any
 * surface that would rather render it locally.
 */
function formatResetTime(resetAtMs: number, observedAt: string): string {
  const observedAtMs = Date.parse(observedAt);
  const withinDay =
    Number.isFinite(observedAtMs) && resetAtMs - observedAtMs < 24 * 60 * 60 * 1_000;
  return new Intl.DateTimeFormat(undefined, {
    ...(withinDay ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(DateTime.toDate(DateTime.makeUnsafe(resetAtMs)));
}
