/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import { type ProviderAdapterError, ProviderValidationError } from "../Errors.ts";
import { readPersistedContinuationKey } from "../runtimeBindingContinuation.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { isExistingDirectory } from "../../pathExpansion.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
const isModelSelection = Schema.is(ModelSelection);

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
    readonly clearHasPendingWork?: boolean;
    readonly preserveCwdAuthority?: CwdAuthority;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(session.sessionGenerationId !== undefined
      ? { sessionGenerationId: session.sessionGenerationId }
      : {}),
    ...(extra?.clearHasPendingWork === true ? { hasPendingWork: false } : {}),
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
    ...(extra?.preserveCwdAuthority !== undefined
      ? { cwdAuthority: extra.preserveCwdAuthority }
      : {}),
  };
}

function readSessionGenerationId(runtimePayload: unknown | null | undefined): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const value = "sessionGenerationId" in runtimePayload ? runtimePayload.sessionGenerationId : null;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Why a binding's persisted cwd outranks the workspace the thread nominally
 * belongs to.
 *
 * `imported-session` — the conversation came from an external transcript that
 * ran somewhere else, so the import decided the directory.
 * `runtime-observed` — the live session moved itself (the agent entered or left
 * a worktree). The provider stores the resumable transcript under the project
 * directory derived from that cwd, so resuming anywhere else cannot find the
 * conversation.
 */
const CWD_AUTHORITIES = ["imported-session", "runtime-observed"] as const;
type CwdAuthority = (typeof CWD_AUTHORITIES)[number];

function readDurableCwdAuthority(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): CwdAuthority | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "cwdAuthority" in runtimePayload ? runtimePayload.cwdAuthority : undefined;
  return CWD_AUTHORITIES.find((authority) => authority === raw);
}

function shouldUsePersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): boolean {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return false;
  }
  return (
    readDurableCwdAuthority(runtimePayload) !== undefined ||
    ("lastRuntimeEvent" in runtimePayload &&
      runtimePayload.lastRuntimeEvent === "provider.importConversation")
  );
}

/**
 * How a persisted binding's conversation state relates to the instance a
 * session is starting on.
 *
 * `same-instance` and `continuation-group` are the reusable states. The
 * distinction that matters is which key is authoritative: the key persisted
 * with the binding wins over the live registry, because a renamed or deleted
 * owner can no longer answer for itself. Driver identity always comes from the
 * durable binding — an instance id is a user-authored slug and can be
 * recreated on a different driver.
 */
type BindingCompatibility =
  | "none"
  | "same-instance"
  | "continuation-group"
  | "incompatible"
  | "unprovable";

function classifyBindingCompatibility(input: {
  readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding | undefined;
  readonly bindingInstanceId: ProviderInstanceId | undefined;
  readonly bindingOwnerInfo: ProviderAdapterRegistry.ProviderInstanceRoutingInfo | undefined;
  readonly targetInstanceId: ProviderInstanceId;
  readonly targetProvider: ProviderDriverKind;
  readonly targetContinuationKey: string;
}): BindingCompatibility {
  const { binding, targetContinuationKey } = input;
  if (binding === undefined) return "none";
  if (binding.provider !== input.targetProvider) return "incompatible";
  if (input.bindingInstanceId === input.targetInstanceId) return "same-instance";
  const ownerKey =
    readPersistedContinuationKey(binding.runtimePayload) ??
    input.bindingOwnerInfo?.continuationIdentity.continuationKey;
  if (ownerKey === undefined) return "unprovable";
  return ownerKey === targetContinuationKey ? "continuation-group" : "incompatible";
}

/**
 * Where a session's resume cursor or cwd came from. `persisted-continuation-group`
 * separates a cross-instance carry from a same-instance restart, so a silently
 * dropped cursor can never be mistaken for "nothing was persisted".
 */
function describeStateSource(input: {
  readonly fromRequest: boolean;
  readonly fromPersisted: boolean;
  readonly bindingCompatibility: BindingCompatibility;
}): string {
  if (input.fromRequest) return "request";
  if (!input.fromPersisted) return "none";
  return input.bindingCompatibility === "same-instance"
    ? "persisted"
    : "persisted-continuation-group";
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService.AnalyticsService);
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const threadLocksRef = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());
  const getThreadLock = Effect.fn("ProviderService.getThreadLock")(function* (threadId: ThreadId) {
    const existing = (yield* Ref.get(threadLocksRef)).get(threadId);
    if (existing) return existing;
    const created = yield* Semaphore.make(1);
    return yield* Ref.modify(threadLocksRef, (locks) => {
      const current = locks.get(threadId);
      if (current) return [current, locks] as const;
      const next = new Map(locks);
      next.set(threadId, created);
      return [created, next] as const;
    });
  });
  const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadLock(threadId), (lock) => lock.withPermit(effect));

  // Upgrade pre-continuation-key bindings while their owning instances still
  // resolve. This keeps a later rename/deletion recoverable without changing
  // lastSeenAt (which would interfere with idle-session reaping).
  yield* directory.listBindings().pipe(
    Effect.flatMap((bindings) =>
      Effect.forEach(
        bindings,
        (binding) =>
          Effect.gen(function* () {
            if (readPersistedContinuationKey(binding.runtimePayload) !== undefined) return;
            const providerInstanceId = binding.providerInstanceId;
            if (providerInstanceId === undefined) return;
            const ownerInfo = Option.getOrUndefined(
              yield* registry.getInstanceInfo(providerInstanceId).pipe(Effect.option),
            );
            // An instance id is a user-authored slug and can be recreated on a
            // different driver. Only stamp when the live owner still matches
            // the driver that produced the persisted cursor.
            if (ownerInfo === undefined || ownerInfo.driverKind !== binding.provider) return;
            yield* directory.refreshIfUnchanged({
              binding,
              touchLastSeenAt: false,
              runtimePayloadPatch: {
                continuationKey: ownerInfo.continuationIdentity.continuationKey,
              },
            });
          }),
        { concurrency: "unbounded", discard: true },
      ),
    ),
    Effect.catch((error) =>
      Effect.logWarning("provider.session.continuation-key-backfill-failed", { error }),
    ),
  );

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const prepareMcpSession = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) =>
    McpSessionRegistry.issueActiveMcpCredential({ threadId, providerInstanceId }).pipe(
      Effect.tap((credential) =>
        credential
          ? Effect.sync(() => McpProviderSession.setMcpProviderSession(credential.config))
          : Effect.void,
      ),
    );
  const clearMcpSession = (threadId: ThreadId) =>
    McpSessionRegistry.revokeActiveMcpThread(threadId).pipe(
      Effect.tap(() => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger
          ? canonicalEventLogger.write(canonicalEvent, canonicalEvent.threadId)
          : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const refreshBindingFromRuntimeEvent = Effect.fn(
    "ProviderService.refreshBindingFromRuntimeEvent",
  )(function* (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ) {
    if (
      event.type !== "turn.completed" &&
      event.type !== "session.exited" &&
      event.type !== "session.cwd.changed"
    ) {
      return;
    }

    // A cwd observation is one-shot and cannot be reconstructed from a later
    // event: if it is dropped, the binding keeps a directory the session has
    // already left. `refreshIfUnchanged` reports a lost compare-and-swap by
    // returning false rather than failing, so `Effect.retry` never sees it —
    // re-read the binding and reapply instead.
    const conflictAttempts = event.type === "session.cwd.changed" ? 3 : 1;

    for (let attempt = 1; attempt <= conflictAttempts; attempt += 1) {
      const binding = Option.getOrUndefined(yield* directory.getBinding(event.threadId));
      if (!binding) {
        return;
      }
      const eventGenerationId = event.payload.sessionGenerationId;
      const bindingGenerationId = readSessionGenerationId(binding.runtimePayload);
      if (
        binding.provider !== source.provider ||
        binding.providerInstanceId !== source.instanceId ||
        bindingGenerationId !== eventGenerationId
      ) {
        yield* Effect.logDebug("provider.session.runtime-event-binding-mismatch", {
          threadId: event.threadId,
          eventProvider: source.provider,
          eventProviderInstanceId: source.instanceId,
          bindingProvider: binding.provider,
          bindingProviderInstanceId: binding.providerInstanceId,
          bindingGenerationId,
          eventGenerationId,
        });
        return;
      }

      if (binding.status === "stopped") return;

      const hasPendingWork = event.type === "turn.completed" ? event.payload.hasPendingWork : false;
      const runtimePayloadPatch =
        event.type === "session.exited"
          ? { hasPendingWork: false, activeTurnId: null }
          : event.type === "session.cwd.changed"
            ? // Claim authority over the cwd so a later resume follows the
              // session into the directory it actually ran in, instead of
              // resetting to the thread's workspace root.
              { cwd: event.payload.cwd, cwdAuthority: "runtime-observed" }
            : hasPendingWork !== undefined
              ? { hasPendingWork }
              : undefined;
      const refreshed = yield* directory
        .refreshIfUnchanged({
          binding,
          ...(event.type === "session.exited" ? { status: "stopped" as const } : {}),
          ...(runtimePayloadPatch !== undefined ? { runtimePayloadPatch } : {}),
        })
        .pipe(Effect.retry({ times: 2 }));
      if (refreshed) {
        return;
      }

      yield* Effect.logDebug("provider.session.runtime-event-binding-changed", {
        threadId: event.threadId,
        eventProvider: source.provider,
        eventProviderInstanceId: source.instanceId,
        expectedLastSeenAt: binding.lastSeenAt,
        attempt,
        remainingAttempts: conflictAttempts - attempt,
      });
    }
  });

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
      readonly clearHasPendingWork?: boolean;
      readonly preserveCwdAuthority?: CwdAuthority;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      const previousBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      // Stamp the owner's continuation key into the payload so compatibility
      // can still be proven after the instance is renamed or deleted, when
      // the registry can no longer answer for its id.
      const previousInstanceId = previousBinding?.providerInstanceId;
      const instanceChanged =
        previousBinding !== undefined && previousInstanceId !== providerInstanceId;
      const previousOwnerInfo =
        instanceChanged && previousInstanceId !== undefined
          ? Option.getOrUndefined(
              yield* registry.getInstanceInfo(previousInstanceId).pipe(Effect.option),
            )
          : undefined;
      const previousContinuationKey =
        readPersistedContinuationKey(previousBinding?.runtimePayload) ??
        previousOwnerInfo?.continuationIdentity.continuationKey;
      const ownerContinuationKey =
        (!instanceChanged ? previousContinuationKey : undefined) ??
        Option.getOrUndefined(
          yield* registry.getInstanceInfo(providerInstanceId).pipe(Effect.option),
        )?.continuationIdentity.continuationKey;
      const continuationCompatible =
        instanceChanged &&
        previousBinding?.provider === session.provider &&
        ownerContinuationKey !== undefined &&
        previousContinuationKey !== undefined &&
        previousContinuationKey === ownerContinuationKey;
      const preserveCwdAuthority =
        previousBinding?.provider === session.provider &&
        (previousInstanceId === providerInstanceId || continuationCompatible)
          ? readDurableCwdAuthority(previousBinding.runtimePayload)
          : undefined;
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        ...(instanceChanged ? { continuationCompatible } : {}),
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: {
          ...toRuntimePayloadFromSession(session, {
            ...extra,
            ...(preserveCwdAuthority !== undefined ? { preserveCwdAuthority } : {}),
          }),
          ...(ownerContinuationKey !== undefined ? { continuationKey: ownerContinuationKey } : {}),
        },
      });
    });

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.sync(() => correlateRuntimeEventWithInstance(source, event)).pipe(
      Effect.flatMap((canonicalEvent) =>
        refreshBindingFromRuntimeEvent(source, canonicalEvent).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.runtime-event-refresh-failed", {
              threadId: canonicalEvent.threadId,
              provider: canonicalEvent.provider,
              providerInstanceId: source.instanceId,
              cause,
            }),
          ),
          Effect.andThen(
            increment(providerRuntimeEventsTotal, {
              provider: canonicalEvent.provider,
              eventType: canonicalEvent.type,
            }),
          ),
          Effect.andThen(publishRuntimeEvent(canonicalEvent)),
        ),
      ),
    );

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          processRuntimeEvent(
            {
              instanceId: id,
              provider: adapter.provider,
            },
            event,
          ),
        ).pipe(Effect.forkScoped);
      }
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(bindingInstanceId);
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          yield* upsertSessionBinding(
            { ...existing, providerInstanceId: bindingInstanceId },
            input.binding.threadId,
          );
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          return { adapter, session: existing } as const;
        }
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);

      yield* prepareMcpSession(input.binding.threadId, bindingInstanceId);
      const resumed = yield* adapter
        .startSession({
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          providerInstanceId: bindingInstanceId,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
          ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
          runtimeMode: input.binding.runtimeMode ?? "full-access",
        })
        .pipe(Effect.onError(() => clearMcpSession(input.binding.threadId)));
      if (resumed.provider !== adapter.provider) {
        yield* clearMcpSession(input.binding.threadId);
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      yield* upsertSessionBinding(
        { ...resumed, providerInstanceId: bindingInstanceId },
        input.binding.threadId,
        // A resumed session runs in a fresh provider subprocess: any wakeups
        // or background tasks armed by the previous process are gone.
        { clearHasPendingWork: true },
      );
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return { adapter, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  /**
   * The turn `stopAll` recorded as still running when it tore this thread's
   * session down, if the marker survives and no turn has been sent since.
   *
   * Only shutdown writes it, from the adapter's own live session state, so it
   * cannot be confused with a turn that finished or one the user stopped.
   */
  const bindingStrandedTurnId = (runtimePayload: unknown | null | undefined): string | null => {
    if (
      runtimePayload === null ||
      runtimePayload === undefined ||
      typeof runtimePayload !== "object" ||
      Array.isArray(runtimePayload) ||
      !("strandedTurnId" in runtimePayload)
    ) {
      return null;
    }
    const value = runtimePayload.strandedTurnId;
    return typeof value === "string" && value.length > 0 ? value : null;
  };

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);

    // A turn was live when this thread's session was last torn down, and
    // nothing has been sent since. Read before any recovery, which rewrites
    // the binding from the fresh session, and reported on every branch: a
    // caller usually restarts the session itself before routing here, so the
    // marker must not depend on this call being the one that recovers.
    const strandedPriorTurn = bindingStrandedTurnId(binding.runtimePayload) !== null;

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        runtimeMode: binding.runtimeMode,
        isActive: true,
        strandedPriorTurn,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        runtimeMode: binding.runtimeMode,
        isActive: false,
        strandedPriorTurn,
      } as const;
    }

    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
    });
    return {
      adapter: recovered.adapter,
      instanceId,
      threadId: input.threadId,
      runtimeMode: recovered.session.runtimeMode,
      isActive: true,
      strandedPriorTurn,
    } as const;
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        instanceId === input.currentInstanceId
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* adapter.stopSession(input.threadId).pipe(
                Effect.tap(() =>
                  analytics.record("provider.session.stopped", {
                    provider: adapter.provider,
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause,
                  }),
                ),
              );
            }),
      { discard: true },
    );
  });

  const startSession: ProviderServiceMethod<"startSession"> = Effect.fn("startSession")(
    function* (threadId, rawInput, options) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );
      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
        const resolvedProvider = instanceInfo.driverKind;
        metricProvider = resolvedProvider;
        if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
          );
        }
        const input = {
          ...parsed,
          threadId,
          provider: resolvedProvider,
        };
        if (!instanceInfo.enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' is disabled in T3 Code settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const persistedBindingInstanceId =
          persistedBinding === undefined
            ? undefined
            : yield* requireBindingInstanceId("ProviderService.startSession", persistedBinding);
        // Continuation compatibility of the persisted binding's owner with
        // the instance being started. Compatibility spans instance ids: two
        // instances sharing a continuation key (e.g. Claude shadow accounts
        // over one config dir) continue each other's conversations, so the
        // persisted cursor must be gated on the key, not on exact-id
        // equality. When the owner no longer resolves in the registry
        // (renamed/deleted instance), fall back to the key persisted
        // alongside the binding.
        const persistedOwnerInfo =
          persistedBinding !== undefined &&
          persistedBindingInstanceId !== undefined &&
          persistedBindingInstanceId !== resolvedInstanceId
            ? Option.getOrUndefined(
                yield* registry.getInstanceInfo(persistedBindingInstanceId).pipe(Effect.option),
              )
            : undefined;
        const bindingCompatibility = classifyBindingCompatibility({
          binding: persistedBinding,
          bindingInstanceId: persistedBindingInstanceId,
          bindingOwnerInfo: persistedOwnerInfo,
          targetInstanceId: resolvedInstanceId,
          targetProvider: resolvedProvider,
          targetContinuationKey: instanceInfo.continuationIdentity.continuationKey,
        });
        const reusePersistedState =
          bindingCompatibility === "same-instance" || bindingCompatibility === "continuation-group";
        const persistedCursorPresent =
          persistedBinding?.resumeCursor !== null && persistedBinding?.resumeCursor !== undefined;
        const persistedStateIncompatible = persistedCursorPresent && !reusePersistedState;
        // A persisted cursor is the thread's conversation. When it cannot be
        // carried, either the caller deliberately replaces the provider
        // (`start-fresh`, only valid when incompatibility is provable) or the
        // start must fail rather than silently reset the model's context
        // behind a full history.
        const rejectIncompatiblePersistedState =
          persistedStateIncompatible &&
          (input.resumeCursor !== undefined ||
            options?.onIncompatiblePersistedState === "fail" ||
            bindingCompatibility === "unprovable");
        if (persistedStateIncompatible && persistedBinding !== undefined) {
          yield* Effect.logWarning("provider.session.resume-state-not-carried", {
            threadId,
            requestedInstanceId: resolvedInstanceId,
            bindingInstanceId: persistedBindingInstanceId,
            bindingProvider: persistedBinding.provider,
            bindingCompatibility,
            rejected: rejectIncompatiblePersistedState,
          });
        }
        if (rejectIncompatiblePersistedState && persistedBinding !== undefined) {
          return yield* toValidationError(
            "ProviderService.startSession",
            bindingCompatibility === "unprovable"
              ? `Thread '${threadId}' has persisted conversation state owned by unavailable provider instance '${persistedBindingInstanceId}', and its continuation compatibility with instance '${resolvedInstanceId}' cannot be verified. Starting here would discard the conversation context; restore or re-add instance '${persistedBindingInstanceId}' with the same account/config to continue this thread, or start a new thread.`
              : `Thread '${threadId}' has persisted conversation state owned by provider instance '${persistedBindingInstanceId}' and is not continuation-compatible with instance '${resolvedInstanceId}'. Starting here would discard the conversation context; switch the thread to a compatible instance or start a new thread.`,
          );
        }
        const effectiveResumeCursor =
          input.resumeCursor ?? (reusePersistedState ? persistedBinding?.resumeCursor : undefined);
        const persistedCwd = reusePersistedState
          ? readPersistedCwd(persistedBinding?.runtimePayload)
          : undefined;
        const persistedCwdOutranksRequest =
          persistedCwd !== undefined &&
          persistedBinding !== undefined &&
          shouldUsePersistedCwd(persistedBinding.runtimePayload);
        // A directory the session wandered into only outranks the requested one
        // while it still exists: an agent-created worktree can be removed
        // between sessions, and nothing downgrades the authority on its own, so
        // the thread would keep being started somewhere that is gone. The
        // imported-session authority keeps its existing behavior — there the
        // recorded directory is the whole point of the import.
        const persistedCwdMissing =
          persistedCwdOutranksRequest &&
          readDurableCwdAuthority(persistedBinding?.runtimePayload) === "runtime-observed" &&
          !isExistingDirectory(persistedCwd);
        if (persistedCwdMissing) {
          yield* Effect.logWarning("provider.session.observed-cwd-missing", {
            threadId,
            persistedCwd,
            fallbackCwd: input.cwd ?? null,
          });
        }
        const effectiveCwd =
          persistedCwdOutranksRequest && !persistedCwdMissing
            ? persistedCwd
            : (input.cwd ?? persistedCwd);
        yield* Effect.annotateCurrentSpan({
          "provider.kind": resolvedProvider,
          "provider.resume_cursor.source": describeStateSource({
            fromRequest: input.resumeCursor !== undefined,
            fromPersisted: effectiveResumeCursor !== undefined,
            bindingCompatibility,
          }),
          "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
          "provider.cwd.source": describeStateSource({
            fromRequest: input.cwd !== undefined,
            fromPersisted: effectiveCwd !== undefined,
            bindingCompatibility,
          }),
          "provider.cwd.effective": effectiveCwd ?? "",
        });
        const adapter = yield* registry.getByInstance(resolvedInstanceId);
        yield* prepareMcpSession(threadId, resolvedInstanceId);
        const session = yield* adapter
          .startSession({
            ...input,
            providerInstanceId: resolvedInstanceId,
            ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
            ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
          })
          .pipe(Effect.onError(() => clearMcpSession(threadId)));

        if (session.provider !== adapter.provider) {
          yield* clearMcpSession(threadId);
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }
        const sessionWithInstance = {
          ...session,
          providerInstanceId: resolvedInstanceId,
        };

        yield* stopStaleSessionsForThread({
          threadId,
          currentInstanceId: resolvedInstanceId,
        });
        yield* upsertSessionBinding(sessionWithInstance, threadId, {
          modelSelection: input.modelSelection,
          clearHasPendingWork: true,
        });
        yield* analytics.record("provider.session.started", {
          provider: sessionWithInstance.provider,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
          hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
          hasModel:
            typeof input.modelSelection?.model === "string" &&
            input.modelSelection.model.trim().length > 0,
        });

        // Changing runtime mode restarts the session, so the transition is only
        // observable here, by diffing against the mode the previous session for
        // this thread was bound to. Recording it separately is what makes the
        // "started supervised, switched to full access" funnel answerable.
        const previousRuntimeMode = persistedBinding?.runtimeMode;
        if (previousRuntimeMode !== undefined && previousRuntimeMode !== input.runtimeMode) {
          yield* analytics.record("provider.runtime_mode.changed", {
            provider: sessionWithInstance.provider,
            from: previousRuntimeMode,
            to: input.runtimeMode,
          });
        }

        return sessionWithInstance;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "start",
            }),
        }),
      );
    },
  );

  const forkConversation: ProviderServiceMethod<"forkConversation"> = Effect.fn("forkConversation")(
    function* (input) {
      const operation = "ProviderService.forkConversation";
      const binding = Option.getOrUndefined(yield* directory.getBinding(input.sourceThreadId));
      if (!binding) {
        return yield* toValidationError(
          operation,
          `Cannot fork thread '${input.sourceThreadId}' because no persisted provider binding exists.`,
        );
      }
      if (binding.resumeCursor === null || binding.resumeCursor === undefined) {
        return yield* toValidationError(
          operation,
          `Cannot fork thread '${input.sourceThreadId}' because no provider resume state is persisted.`,
        );
      }

      const providerInstanceId = yield* requireBindingInstanceId(operation, binding);
      const adapter = yield* registry.getByInstance(providerInstanceId);
      if (!adapter.forkSession) {
        return yield* toValidationError(
          operation,
          `Provider '${adapter.provider}' does not support conversation forks.`,
        );
      }

      if (yield* adapter.hasSession(input.sourceThreadId)) {
        const sourceSession = (yield* adapter.listSessions()).find(
          (session) => session.threadId === input.sourceThreadId,
        );
        if (sourceSession && sourceSession.status !== "ready") {
          return yield* toValidationError(
            operation,
            `Cannot fork thread '${input.sourceThreadId}' while its provider session is ${sourceSession.status}.`,
          );
        }
      }

      const modelSelection = readPersistedModelSelection(binding.runtimePayload);
      const cwd = readPersistedCwd(binding.runtimePayload);
      // The destination continues the same native conversation store as the
      // source, so it inherits the source binding's continuation key.
      const sourceContinuationKey =
        readPersistedContinuationKey(binding.runtimePayload) ??
        Option.getOrUndefined(
          yield* registry.getInstanceInfo(providerInstanceId).pipe(Effect.option),
        )?.continuationIdentity.continuationKey;
      const result = yield* adapter.forkSession({
        sourceThreadId: input.sourceThreadId,
        destinationThreadId: input.destinationThreadId,
        sourceResumeCursor: binding.resumeCursor,
        ...(cwd ? { cwd } : {}),
        ...(modelSelection ? { modelSelection } : {}),
        runtimeMode: binding.runtimeMode ?? "full-access",
      });

      yield* directory.upsert({
        threadId: input.destinationThreadId,
        provider: binding.provider,
        providerInstanceId,
        runtimeMode: binding.runtimeMode ?? "full-access",
        status: "stopped",
        resumeCursor: result.resumeCursor,
        runtimePayload: {
          ...(cwd ? { cwd } : {}),
          ...(modelSelection ? { modelSelection } : {}),
          activeTurnId: null,
          lastRuntimeEvent: "provider.forkConversation",
          lastRuntimeEventAt: yield* nowIso,
          ...(sourceContinuationKey !== undefined
            ? { continuationKey: sourceContinuationKey }
            : {}),
        },
      });
      return result;
    },
  );

  const sendTurn: ProviderServiceMethod<"sendTurn"> = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      // A turn is the clearest sign a session is still alive. The MCP
      // credential is minted once at session start and cannot be rotated into
      // an already-spawned agent process, so we keep the existing token valid
      // rather than issuing a new one: sessions that go a long time between
      // browser tool calls used to lose the toolkit outright.
      yield* McpSessionRegistry.touchActiveMcpThread(input.threadId);
      const turn = yield* routed.adapter.sendTurn(
        routed.strandedPriorTurn ? { ...input, priorTurnEndedUnrequested: true } : input,
      );
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          activeTurnId: turn.turnId,
          // The turn carrying the notice has been sent, so the marker is
          // spent. `upsert` merges runtime payloads, so it has to be cleared
          // by name — omitting it would leave it set forever.
          strandedTurnId: null,
          lastRuntimeEvent: "provider.sendTurn",
          lastRuntimeEventAt: yield* nowIso,
        },
      });
      yield* analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
        // Session-start events alone skew runtime mode toward users who toggle
        // often, since every toggle restarts the session. Recording it per turn
        // gives a usage-weighted view and lets it cross with interactionMode.
        runtimeMode: routed.runtimeMode,
        attachmentCount: input.attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const interruptTurn: ProviderServiceMethod<"interruptTurn"> = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const respondToRequest: ProviderServiceMethod<"respondToRequest"> = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceMethod<"respondToUserInput"> = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceMethod<"stopSession"> = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* clearMcpSession(input.threadId);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            // Stopping kills the provider subprocess, so any armed wakeups or
            // background tasks die with it — the binding must not keep the
            // pending-work reaper extension.
            hasPendingWork: false,
          },
        });
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const stopSessionIfUnchanged: ProviderServiceMethod<"stopSessionIfUnchanged"> = (observed) =>
    withThreadLock(
      observed.threadId,
      Effect.gen(function* () {
        const current = Option.getOrUndefined(yield* directory.getBinding(observed.threadId));
        if (
          !current ||
          current.revision !== observed.revision ||
          current.provider !== observed.provider ||
          current.providerInstanceId !== observed.providerInstanceId ||
          current.status === "stopped"
        ) {
          return false;
        }

        const runtimePayload =
          current.runtimePayload &&
          typeof current.runtimePayload === "object" &&
          !Array.isArray(current.runtimePayload)
            ? current.runtimePayload
            : {};
        const originalHasPendingWork =
          "hasPendingWork" in runtimePayload && typeof runtimePayload.hasPendingWork === "boolean"
            ? runtimePayload.hasPendingWork
            : null;
        const originalActiveTurnId =
          "activeTurnId" in runtimePayload ? (runtimePayload.activeTurnId ?? null) : null;

        const claimed = yield* directory
          .refreshIfUnchanged({
            binding: current,
            status: "stopped",
            touchLastSeenAt: false,
            runtimePayloadPatch: { hasPendingWork: false, activeTurnId: null },
          })
          .pipe(Effect.retry({ times: 2 }));
        if (!claimed) return false;

        const rollbackClaim = Effect.gen(function* () {
          const claimedBinding = Option.getOrUndefined(
            yield* directory.getBinding(observed.threadId),
          );
          if (!claimedBinding || claimedBinding.status !== "stopped") return;
          yield* directory.refreshIfUnchanged({
            binding: claimedBinding,
            status: current.status ?? "running",
            touchLastSeenAt: false,
            runtimePayloadPatch: {
              hasPendingWork: originalHasPendingWork,
              activeTurnId: originalActiveTurnId,
            },
          });
        }).pipe(Effect.ignore);

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const providerInstanceId = yield* requireBindingInstanceId(
              "ProviderService.stopSessionIfUnchanged",
              current,
            );
            const adapter = yield* registry.getByInstance(providerInstanceId);
            if (yield* adapter.hasSession(current.threadId)) {
              yield* adapter.stopSession(current.threadId);
            }
          }).pipe(Effect.tapCause(() => rollbackClaim));
          yield* clearMcpSession(current.threadId);
          yield* analytics.record("provider.session.stopped", {
            provider: current.provider,
          });
          return true;
        });
      }),
    );

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(
                  Effect.orElseSucceed(() =>
                    Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
                  ),
                ),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(
          () => [] as Array<Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>>,
        ),
      );
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }
        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const getCapabilities: ProviderServiceMethod<"getCapabilities"> = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceMethod<"getInstanceInfo"> = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const rollbackConversation: ProviderServiceMethod<"rollbackConversation"> = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const currentAdapters = yield* getAdapterEntries;
    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    // Shutting down cancels whatever a running turn was doing, and the agent
    // is told its tool call was rejected. Remember the turns that were live
    // here — before the adapters tear their sessions down — so the next
    // message on those threads can explain it. The sessions are the only
    // trustworthy source: a binding keeps naming the last turn it started
    // long after that turn finished.
    const strandedTurnIdByThread = new Map<ThreadId, string>();
    for (const session of activeSessions) {
      if (session.activeTurnId !== undefined) {
        strandedTurnIdByThread.set(session.threadId, session.activeTurnId);
      }
    }
    yield* Effect.forEach(activeSessions, (session) =>
      Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
        upsertSessionBinding(session, session.threadId, {
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt,
        }),
      ),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(currentAdapters, ([, adapter]) => adapter.stopAll()).pipe(Effect.asVoid);
    yield* McpSessionRegistry.revokeAllActiveMcpCredentials();
    McpProviderSession.clearAllMcpProviderSessions();
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        const providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.stopAll",
          binding,
        );
        const strandedTurnId = strandedTurnIdByThread.get(binding.threadId);
        return yield* directory.upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            hasPendingWork: false,
            ...(strandedTurnId !== undefined ? { strandedTurnId } : {}),
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
      }),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  );

  return {
    startSession: (threadId, input, options) =>
      withThreadLock(threadId, startSession(threadId, input, options)),
    // Forks read the source binding's resume cursor; lock the source thread so
    // a concurrent stop/start cannot swap the session out mid-fork.
    forkConversation: (input) => withThreadLock(input.sourceThreadId, forkConversation(input)),
    sendTurn: (input) => withThreadLock(input.threadId, sendTurn(input)),
    interruptTurn: (input) => withThreadLock(input.threadId, interruptTurn(input)),
    respondToRequest: (input) => withThreadLock(input.threadId, respondToRequest(input)),
    respondToUserInput: (input) => withThreadLock(input.threadId, respondToUserInput(input)),
    stopSession: (input) => withThreadLock(input.threadId, stopSession(input)),
    stopSessionIfUnchanged,
    listSessions,
    getCapabilities,
    getInstanceInfo,
    rollbackConversation: (input) => withThreadLock(input.threadId, rollbackConversation(input)),
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceMethod<"streamEvents"> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderService.ProviderService["Service"];
});

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  makeProviderService(),
);

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService.ProviderService, makeProviderService(options));
}
