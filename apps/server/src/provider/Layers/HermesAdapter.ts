import {
  ApprovalRequestId,
  type HermesSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest, type AcpToolCallState } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyHermesAcpModeSelection,
  applyHermesAcpModelSelection,
  currentHermesModeIdFromSessionSetup,
  currentHermesModelIdFromSessionSetup,
  makeHermesAcpRuntime,
  resolveHermesAcpModelId,
} from "../acp/HermesAcpSupport.ts";
import {
  isPrunedHermesSessionLoad,
  settleHermesOpenToolCalls,
  updateHermesOpenToolCalls,
} from "../acp/HermesAcpExtension.ts";
import { collectComposerSkillTokens } from "@t3tools/shared/composerInlineTokens";

import { rewriteHermesPrompt } from "../acp/HermesPromptRewrite.ts";
import { readHermesSkillsSnapshot } from "../hermesSkillsSnapshot.ts";
import { type HermesAdapterShape } from "../Services/HermesAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("hermes");
const HERMES_LEGACY_RESUME_VERSION = 1 as const;
const HERMES_RESUME_VERSION = 2 as const;
const HERMES_DEFAULT_MODEL_SELECTION = "default";

/**
 * `ProviderSession.model` lives in the client selection namespace, so it must
 * echo whatever the user picked — including the `"default"` sentinel. A turn
 * that carries no Hermes selection must leave the existing selection alone
 * rather than collapse it back to the sentinel.
 */
function hermesSelectionModelId(
  requestedModelId: string | undefined,
  currentSelectionModelId: string | undefined,
): string {
  return (
    requestedModelId?.trim() || currentSelectionModelId?.trim() || HERMES_DEFAULT_MODEL_SELECTION
  );
}

function hermesRestorableDefaultModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") return undefined;
  const trimmed = modelId.trim();
  return trimmed && trimmed !== HERMES_DEFAULT_MODEL_SELECTION ? trimmed : undefined;
}

/**
 * Which concrete Hermes model the `"default"` sentinel resolves to for this
 * session, or `undefined` when that identity is not recoverable.
 *
 * - **Fresh session** (no resume cursor): Hermes reports its configured model
 *   before T3 applies any override, so the setup model *is* the default.
 *   Always trustworthy.
 * - **Resume from a v2 cursor**: the identity was captured at session creation
 *   and is authoritative — including the explicit "Hermes exposed no restorable
 *   default" case, which the cursor stores as `null` and which must never be
 *   re-inferred later.
 * - **Resume from a v1 cursor** (pre-dates this field): `session/load` reports
 *   the model *persisted* for the Hermes session, which equals the configured
 *   default only when T3 never overrode it. A v1 cursor carries no record of
 *   the selection that was in force when it was written, so the only signal
 *   available is the selection the caller is making *right now*.
 *
 *   That makes the inference correct for the threads the sentinel bug actually
 *   broke: a pre-fix `"default"` thread never issued `session/set_model` at all
 *   (`resolveHermesAcpModelId` maps the sentinel to `undefined`), so its
 *   persisted model really is Hermes's configured one.
 *
 *   Residual known-wrong case, accepted rather than fixed because v1 cursors
 *   cannot distinguish it: a pre-fix thread pinned to a *concrete* model,
 *   resumed cold after upgrading, where the user picks `"default"` on that
 *   first turn. The stale concrete override is then inferred as the default and
 *   frozen into the upgraded v2 cursor. The consequence is a wrong target model
 *   for that one thread — no context loss — and it cannot affect any thread
 *   created after this fix. Do not widen this inference.
 */
function resolveHermesDefaultModelId(input: {
  readonly resume: ReturnType<typeof parseHermesResume>;
  readonly selectionIsSentinel: boolean;
  readonly sessionSetupModelId: string | undefined;
}): string | undefined {
  const setupDefaultModelId = hermesRestorableDefaultModelId(input.sessionSetupModelId);
  if (input.resume === undefined) return setupDefaultModelId;
  if (input.resume.defaultModelId !== undefined) return input.resume.defaultModelId;
  return input.resume.inferDefaultModelIdFromSetup && input.selectionIsSentinel
    ? setupDefaultModelId
    : undefined;
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface HermesAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface HermesTurnItem {
  readonly prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>;
  readonly result: EffectAcpSchema.PromptResponse;
  readonly promptSequence: number;
}

interface HermesSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  readonly sessionGenerationId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  turns: Array<{ id: TurnId; items: Array<HermesTurnItem> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted; late prompt RPCs must not resurrect them. */
  interruptedTurnIds: Set<TurnId>;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  /** First prompt failure retained until every prompt in the merged turn settles. */
  promptFailureMessage: string | undefined;
  /** A cancelled prompt makes the merged turn cancelled unless another prompt failed. */
  promptWasCancelled: boolean;
  nextPromptSequence: number;
  openToolCalls: ReadonlyMap<string, AcpToolCallState>;
  currentModelId: string | undefined;
  /** Concrete model Hermes itself was configured with, observed at session
   * setup. This is what the `"default"` sentinel resolves to. */
  readonly defaultModelId: string | undefined;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function appendPromptResultToTurn(
  ctx: HermesSessionContext,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
  promptSequence: number,
): void {
  const item = { prompt: promptParts, result, promptSequence } satisfies HermesTurnItem;
  const existingTurnRecord = ctx.turns.find((turn) => turn.id === turnId);
  ctx.turns = existingTurnRecord
    ? ctx.turns.map((turn) =>
        turn.id === turnId
          ? {
              ...turn,
              items: [...turn.items, item].sort(
                (left, right) => left.promptSequence - right.promptSequence,
              ),
            }
          : turn,
      )
    : [...ctx.turns, { id: turnId, items: [item] }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const resolveNotificationTurnId = (ctx: HermesSessionContext): TurnId | undefined =>
  ctx.activeTurnId;

const resolveCallbackTurnId = (ctx: HermesSessionContext): TurnId | undefined => ctx.activeTurnId;

const resolveSessionCallbackTurnId = (
  sessions: ReadonlyMap<ThreadId, HermesSessionContext>,
  threadId: ThreadId,
): TurnId | undefined => {
  const ctx = sessions.get(threadId);
  return ctx ? resolveCallbackTurnId(ctx) : undefined;
};

function parseHermesResume(raw: unknown):
  | {
      sessionId: string;
      defaultModelId?: string;
      inferDefaultModelIdFromSetup: boolean;
    }
  | undefined {
  if (!isRecord(raw)) return undefined;
  if (
    raw.schemaVersion !== HERMES_LEGACY_RESUME_VERSION &&
    raw.schemaVersion !== HERMES_RESUME_VERSION
  ) {
    return undefined;
  }
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  const defaultModelId = hermesRestorableDefaultModelId(raw.defaultModelId);
  return {
    sessionId: raw.sessionId.trim(),
    ...(defaultModelId ? { defaultModelId } : {}),
    // Version 1 predates explicit known/unknown default identity. For backward
    // compatibility, its setup model is the only recoverable migration signal.
    // Version 2 writes `null` when Hermes did not expose a restorable default,
    // so that state must never be inferred later.
    inferDefaultModelIdFromSetup:
      raw.schemaVersion === HERMES_LEGACY_RESUME_VERSION && defaultModelId === undefined,
  };
}

export function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  // Hermes never offers an acceptAlways option today, but the decision union
  // is provider-agnostic: a client sending it must land on the closest
  // accept-shaped option, never fall through to a silent rejection.
  const kind =
    decision === "acceptForSession" || decision === "acceptAlways"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() || undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

function completedStopReasonFromPromptResponse(
  response: EffectAcpSchema.PromptResponse | undefined,
): EffectAcpSchema.StopReason | null {
  return response?.stopReason ?? null;
}

export function hermesPromptSettlementBelongsToContext(input: {
  readonly liveAcpSessionId: string;
  readonly expectedAcpSessionId: string;
  readonly liveSessionGenerationId: string;
  readonly originatingSessionGenerationId: string;
  readonly liveActiveTurnId: TurnId | undefined;
  readonly liveSessionActiveTurnId: TurnId | undefined;
  readonly turnId: TurnId;
}): boolean {
  return (
    input.liveAcpSessionId === input.expectedAcpSessionId &&
    input.liveSessionGenerationId === input.originatingSessionGenerationId &&
    (input.liveActiveTurnId === input.turnId || input.liveSessionActiveTurnId === input.turnId)
  );
}

export function makeHermesAdapter(
  hermesSettings: HermesSettings,
  options?: HermesAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("hermes");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, HermesSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Hermes runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Hermes ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const settleOpenToolCalls = (
      ctx: HermesSessionContext,
      turnId: TurnId,
      status: "completed" | "failed",
    ) =>
      Effect.gen(function* () {
        const pending = settleHermesOpenToolCalls(ctx.openToolCalls, status);
        ctx.openToolCalls = new Map();
        yield* Effect.forEach(
          pending,
          (toolCall) =>
            makeEventStamp().pipe(
              Effect.flatMap((stamp) =>
                offerRuntimeEvent(
                  makeAcpToolCallEvent({
                    stamp,
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId,
                    toolCall,
                    rawPayload: { synthesizedBy: "hermes-tool-settle" },
                  }),
                ),
              ),
            ),
          { discard: true },
        );
      });

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const settlePromptInFlight = (
      threadId: ThreadId,
      turnId: TurnId,
      expectedAcpSessionId: string,
      originatingSessionGenerationId: string,
      options?: {
        readonly errorMessage?: string;
        readonly completedStopReason?: EffectAcpSchema.StopReason | null;
        readonly emitTurnCompletion?: boolean;
        /** Interrupt/cancel: drop every outstanding prompt slot and settle once. */
        readonly settleAllPrompts?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const liveCtx = sessions.get(threadId);
        if (!liveCtx) {
          return;
        }
        const settlementBelongsToLiveContext = hermesPromptSettlementBelongsToContext({
          liveAcpSessionId: liveCtx.acpSessionId,
          expectedAcpSessionId,
          liveSessionGenerationId: liveCtx.sessionGenerationId,
          originatingSessionGenerationId,
          liveActiveTurnId: liveCtx.activeTurnId,
          liveSessionActiveTurnId: liveCtx.session.activeTurnId,
          turnId,
        });
        if (!settlementBelongsToLiveContext) {
          // interruptTurn already consumed every prompt slot for this turn. A
          // late prompt result must neither emit a second terminal event nor
          // consume a slot belonging to a newer turn on the same ACP session.
          if (
            liveCtx.acpSessionId !== expectedAcpSessionId ||
            liveCtx.interruptedTurnIds.has(turnId)
          ) {
            return;
          }
          if (options?.emitTurnCompletion !== false) {
            if (options?.errorMessage !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: options.errorMessage,
                  sessionGenerationId: originatingSessionGenerationId,
                },
              });
            } else if (options?.completedStopReason !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: options.completedStopReason ?? null,
                  sessionGenerationId: originatingSessionGenerationId,
                },
              });
            }
          }
          return;
        }
        if (options?.settleAllPrompts && options.completedStopReason === "cancelled") {
          liveCtx.promptFailureMessage = undefined;
          liveCtx.promptWasCancelled = true;
        } else {
          liveCtx.promptFailureMessage ??= options?.errorMessage;
          liveCtx.promptWasCancelled ||= options?.completedStopReason === "cancelled";
        }
        let settleTurnId = turnId;
        if (options?.settleAllPrompts) {
          liveCtx.promptsInFlight = 0;
          if (liveCtx.activeTurnId !== turnId && liveCtx.session.activeTurnId !== turnId) {
            const fallbackTurnId = liveCtx.activeTurnId ?? liveCtx.session.activeTurnId;
            if (!fallbackTurnId) {
              if (liveCtx.session.status === "running" || liveCtx.session.status === "connecting") {
                const updatedAt = yield* nowIso;
                const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
                liveCtx.activeTurnId = undefined;
                liveCtx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt,
                };
              }
              return;
            }
            settleTurnId = fallbackTurnId;
          }
        } else {
          const remainingPrompts = Math.max(0, liveCtx.promptsInFlight - 1);
          if (
            remainingPrompts > 0 ||
            liveCtx.activeTurnId !== settleTurnId ||
            liveCtx.session.activeTurnId !== settleTurnId
          ) {
            liveCtx.promptsInFlight = remainingPrompts;
            return;
          }
          liveCtx.promptsInFlight = remainingPrompts;
        }
        const updatedAt = yield* nowIso;
        const canEmitTurnCompletion =
          liveCtx.session.status === "running" || liveCtx.session.status === "connecting";
        const shouldEmitFailedTurn =
          liveCtx.promptFailureMessage !== undefined && canEmitTurnCompletion;
        const shouldEmitCompletedTurn =
          (options?.completedStopReason !== undefined || liveCtx.promptWasCancelled) &&
          canEmitTurnCompletion;
        const completedStopReason = liveCtx.promptWasCancelled
          ? "cancelled"
          : options?.completedStopReason;
        const promptFailureMessage = liveCtx.promptFailureMessage;
        const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
        liveCtx.activeTurnId = undefined;
        liveCtx.promptFailureMessage = undefined;
        liveCtx.promptWasCancelled = false;
        liveCtx.session = {
          ...readySession,
          status: "ready",
          updatedAt,
        };
        if (options?.emitTurnCompletion === false) {
          return;
        }
        if (shouldEmitFailedTurn || shouldEmitCompletedTurn) {
          yield* settleOpenToolCalls(
            liveCtx,
            settleTurnId,
            shouldEmitFailedTurn || completedStopReason === "cancelled" ? "failed" : "completed",
          );
        }
        if (shouldEmitFailedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: "failed",
              errorMessage: promptFailureMessage,
              sessionGenerationId: originatingSessionGenerationId,
            },
          });
        } else if (shouldEmitCompletedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: completedStopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: completedStopReason ?? null,
              sessionGenerationId: originatingSessionGenerationId,
            },
          });
        }
      });

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Hermes notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const emitPlanUpdate = (
      ctx: HermesSessionContext,
      turnId: TurnId | undefined,
      stamp: { readonly eventId: EventId; readonly createdAt: string },
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${turnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<HermesSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: HermesSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: {
            exitKind: "graceful",
            sessionGenerationId: ctx.sessionGenerationId,
          },
        });
      });

    const startSession: HermesAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const hermesModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const hermesResume = parseHermesResume(input.resumeCursor);
          const resumeSessionId = hermesResume?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeHermesAcpRuntime({
            hermesSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          const replayUpdateCountRef = yield* Ref.make(0);
          if (resumeSessionId) {
            yield* acp.handleSessionUpdate(() =>
              Ref.update(replayUpdateCountRef, (count) => count + 1),
            );
          }
          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/request_permission", params);
                  if (input.runtimeMode === "full-access") {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                  pendingApprovals.set(requestId, { decision });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const selectedOptionId =
                    resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
                  return {
                    outcome: selectedOptionId
                      ? {
                          outcome: "selected" as const,
                          optionId: selectedOptionId,
                        }
                      : ({ outcome: "cancelled" } as const),
                  };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const replayUpdateCount = yield* Ref.get(replayUpdateCountRef);
          if (
            isPrunedHermesSessionLoad({
              resumeSessionId,
              replayUpdateCount,
              sessionSetupResult: started.sessionSetupResult,
            })
          ) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/load",
              detail: "Hermes no longer has this session; start a new thread.",
            });
          }

          yield* applyHermesAcpModeSelection({
            runtime: acp,
            sessionId: started.sessionId,
            currentModeId: currentHermesModeIdFromSessionSetup(started.sessionSetupResult),
            runtimeMode: input.runtimeMode,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
          });

          const requestedStartModelId = hermesModelSelection?.model?.trim() || undefined;
          // An explicit `"default"` is a request to use Hermes's own configured
          // model. NO selection at all is a different thing: ProviderService
          // recovery legitimately omits `modelSelection` when the persisted
          // binding carries none, and that must leave the model untouched
          // rather than be read as a sentinel request — otherwise recovery
          // either resets a concrete pin or hard-fails a thread that never
          // asked for the default. This mirrors sendTurn's carry-over rule.
          const startSelectionIsSentinel = requestedStartModelId === HERMES_DEFAULT_MODEL_SELECTION;
          const sessionSetupModelId = currentHermesModelIdFromSessionSetup(
            started.sessionSetupResult,
          );
          const selectedStartModelId =
            requestedStartModelId ?? sessionSetupModelId ?? HERMES_DEFAULT_MODEL_SELECTION;
          const defaultModelId = resolveHermesDefaultModelId({
            resume: hermesResume,
            selectionIsSentinel: startSelectionIsSentinel,
            sessionSetupModelId,
          });
          if (
            resumeSessionId !== undefined &&
            startSelectionIsSentinel &&
            defaultModelId === undefined
          ) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/load",
              detail:
                "Hermes did not report a restorable default model for this saved session. Select a concrete model or start a new thread.",
            });
          }
          // No selection carried => `undefined` => applyHermesAcpModelSelection
          // no-ops, leaving Hermes on whatever model it already has.
          const acpStartModelId = startSelectionIsSentinel ? defaultModelId : requestedStartModelId;
          const boundModelId = yield* applyHermesAcpModelSelection({
            runtime: acp,
            currentModelId: sessionSetupModelId,
            requestedModelId: acpStartModelId,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
          });

          const now = yield* nowIso;
          const sessionGenerationId = yield* randomUUIDv4;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: selectedStartModelId,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: HERMES_RESUME_VERSION,
              sessionId: started.sessionId,
              defaultModelId: defaultModelId ?? null,
            },
            sessionGenerationId,
            createdAt: now,
            updatedAt: now,
          };

          const ctx: HermesSessionContext = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            sessionGenerationId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            promptsInFlight: 0,
            promptFailureMessage: undefined,
            promptWasCancelled: false,
            nextPromptSequence: 0,
            openToolCalls: new Map(),
            currentModelId: boundModelId,
            defaultModelId,
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                }
                if (
                  event._tag === "PlanUpdated" ||
                  event._tag === "ToolCallUpdated" ||
                  event._tag === "ContentDelta"
                ) {
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                }

                if (event._tag === "ModeChanged") {
                  return;
                }

                const notificationTurnId = resolveNotificationTurnId(ctx);
                if (
                  notificationTurnId === undefined ||
                  ctx.interruptedTurnIds.has(notificationTurnId)
                ) {
                  return;
                }
                const stamp = yield* makeEventStamp();

                switch (event._tag) {
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* emitPlanUpdate(
                      ctx,
                      notificationTurnId,
                      stamp,
                      event.payload,
                      event.rawPayload,
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    ctx.openToolCalls = updateHermesOpenToolCalls(
                      ctx.openToolCalls,
                      event.toolCall,
                    );
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Hermes runtime notification.", { cause }),
            ),
            Effect.forkChild,
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Hermes ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    /**
     * Lowercased command names of the enabled skills Hermes reports, used to
     * decide which mid-message `$name` references are safe to rewrite.
     *
     * Read only when the message actually carries a reference, so an ordinary
     * turn never touches the filesystem and there is nothing to cache: a skill
     * added a moment ago is picked up on the next message. An unreadable
     * snapshot yields `undefined`, which keeps the leading-token rewrite the
     * only behaviour — never a failed turn.
     */
    const resolveKnownSkillNames = Effect.fn("resolveHermesKnownSkillNames")(function* (
      text: string | undefined,
    ) {
      if (!text || collectComposerSkillTokens(text).length === 0) {
        return undefined;
      }
      const skills = yield* listSkills({ cwd: "" }).pipe(Effect.orElseSucceed(() => []));
      const names = new Set(
        skills.filter((skill) => skill.enabled).map((skill) => skill.name.toLowerCase()),
      );
      return names.size > 0 ? names : undefined;
    });

    const sendTurn: HermesAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const semaphore = yield* getThreadSemaphore(input.threadId);
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const prepared = yield* Effect.acquireUseRelease(
              restore(semaphore.take(1)),
              () =>
                Effect.gen(function* () {
                  const ctx = yield* requireSession(input.threadId);
                  // A sendTurn while a prompt is in flight is a steer: the agent
                  // folds the new prompt into the ongoing work, so the active turn
                  // id is reused instead of opening a new turn.
                  const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
                  const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
                  const turnModelSelection =
                    input.modelSelection?.instanceId === boundInstanceId
                      ? input.modelSelection
                      : undefined;
                  const requestedTurnModelId = turnModelSelection?.model?.trim() || undefined;
                  const knownSkillNames = yield* resolveKnownSkillNames(input.input);
                  const text = input.input
                    ? rewriteHermesPrompt(input.input, knownSkillNames)
                    : undefined;
                  const imagePromptParts = yield* restore(
                    Effect.forEach(input.attachments ?? [], (attachment) =>
                      Effect.gen(function* () {
                        const attachmentPath = resolveAttachmentPath({
                          attachmentsDir: serverConfig.attachmentsDir,
                          attachment,
                        });
                        if (!attachmentPath) {
                          return yield* new ProviderAdapterRequestError({
                            provider: PROVIDER,
                            method: "session/prompt",
                            detail: `Invalid attachment id '${attachment.id}'.`,
                          });
                        }
                        const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                          Effect.mapError(
                            (cause) =>
                              new ProviderAdapterRequestError({
                                provider: PROVIDER,
                                method: "session/prompt",
                                detail: cause.message,
                                cause,
                              }),
                          ),
                        );
                        return {
                          type: "image",
                          data: Buffer.from(bytes).toString("base64"),
                          mimeType: attachment.mimeType,
                        } satisfies EffectAcpSchema.ContentBlock;
                      }),
                    ),
                  );
                  const promptParts: Array<EffectAcpSchema.ContentBlock> = [
                    ...(text ? [{ type: "text" as const, text }] : []),
                    ...imagePromptParts,
                  ];

                  if (promptParts.length === 0) {
                    return yield* new ProviderAdapterValidationError({
                      provider: PROVIDER,
                      operation: "sendTurn",
                      issue: "Turn requires non-empty text or attachments.",
                    });
                  }

                  if (
                    requestedTurnModelId === HERMES_DEFAULT_MODEL_SELECTION &&
                    ctx.defaultModelId === undefined &&
                    ctx.currentModelId !== undefined
                  ) {
                    return yield* new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session/set_model",
                      detail:
                        "Hermes did not report the configured default model for this session, so T3 Code cannot safely restore it. Start a new thread to use the Hermes default.",
                    });
                  }
                  // Selecting the sentinel mid-thread must actually put Hermes
                  // back on its own configured model, not silently keep the
                  // concrete model a previous turn switched to.
                  const acpTurnModelId =
                    requestedTurnModelId === HERMES_DEFAULT_MODEL_SELECTION
                      ? ctx.defaultModelId
                      : requestedTurnModelId;

                  // NOT dead code. Inside `uninterruptibleMask`, `restore` flips
                  // the fiber back to interruptible, and Effect observes any
                  // already-pending interrupt at exactly that moment. Yielding
                  // this is therefore an interruption CHECKPOINT. Deleting these
                  // two yields silently removes the cancellation-safety of the
                  // model switch below.
                  const interruptionCheckpoint = restore(Effect.void);

                  // Checkpoint 1: abort before touching anything remote, so an
                  // interrupt that is already pending cannot trigger the
                  // teardown finalizer below.
                  yield* interruptionCheckpoint;

                  const selectedTurnModelId = hermesSelectionModelId(
                    requestedTurnModelId,
                    ctx.session.model,
                  );
                  // Only a real `session/set_model` RPC can leave the remote
                  // model unknowable under cancellation, so only that case gets
                  // the teardown finalizer. A turn that changes no model must
                  // not destroy the ACP session on an unlucky interrupt. This
                  // mirrors applyHermesAcpModelSelection's own no-op condition.
                  const acpModelIdToApply = resolveHermesAcpModelId(acpTurnModelId);
                  const willIssueSetModel =
                    acpModelIdToApply !== undefined && acpModelIdToApply !== ctx.currentModelId;
                  // Selection order is serialized by the thread semaphore. If
                  // cancellation races the RPC response, the remote model is
                  // unknowable, so discard the ACP session rather than reuse a
                  // possibly divergent local projection. Once Hermes answers,
                  // the surrounding mask commits local state before observing a
                  // pending interruption.
                  const applyTurnModelSelection = restore(
                    applyHermesAcpModelSelection({
                      runtime: ctx.acp,
                      currentModelId: ctx.currentModelId,
                      requestedModelId: acpTurnModelId,
                      mapError: (cause) =>
                        mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
                    }),
                  );
                  const currentModelId = yield* willIssueSetModel
                    ? applyTurnModelSelection.pipe(
                        Effect.onInterrupt(() => stopSessionInternal(ctx)),
                      )
                    : applyTurnModelSelection;
                  ctx.currentModelId = currentModelId;
                  ctx.session = {
                    ...ctx.session,
                    model: selectedTurnModelId,
                    updatedAt: yield* nowIso,
                  };
                  // Checkpoint 2: the successful switch is now committed to local
                  // state, so an interrupt observed here leaves Hermes and T3
                  // agreeing on the model and simply skips the prompt.
                  yield* interruptionCheckpoint;

                  const promptHandle = yield* ctx.acp
                    .promptStart({ prompt: promptParts })
                    .pipe(
                      Effect.mapError((error) =>
                        mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
                      ),
                    );
                  if (steeringTurnId === undefined) {
                    ctx.nextPromptSequence = 0;
                    ctx.lastPlanFingerprint = undefined;
                    ctx.openToolCalls = new Map();
                    ctx.promptFailureMessage = undefined;
                    ctx.promptWasCancelled = false;
                  }
                  const promptSequence = ctx.nextPromptSequence;
                  ctx.nextPromptSequence += 1;
                  ctx.promptsInFlight += 1;
                  ctx.activeTurnId = turnId;
                  ctx.session = {
                    ...ctx.session,
                    status: "running",
                    activeTurnId: turnId,
                    updatedAt: yield* nowIso,
                  };

                  if (steeringTurnId === undefined) {
                    yield* offerRuntimeEvent({
                      type: "turn.started",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      payload: { model: selectedTurnModelId },
                    });
                  }
                  yield* promptHandle.start;

                  return {
                    acp: ctx.acp,
                    acpSessionId: ctx.acpSessionId,
                    sessionGenerationId: ctx.sessionGenerationId,
                    promptHandle,
                    promptParts,
                    promptSequence,
                    resumeCursor: ctx.session.resumeCursor,
                    scope: ctx.scope,
                    turnId,
                  };
                }),
              () => semaphore.release(1),
            );
            const completePrompt = Effect.gen(function* () {
              const outcome = yield* prepared.promptHandle.awaitResult.pipe(
                Effect.map((result) => ({ _tag: "Success" as const, result })),
                Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
              );
              yield* prepared.acp.drainEvents;
              yield* withThreadLock(
                input.threadId,
                Effect.gen(function* () {
                  const ctx = yield* requireSession(input.threadId);
                  if (
                    ctx.acpSessionId !== prepared.acpSessionId ||
                    ctx.sessionGenerationId !== prepared.sessionGenerationId
                  ) {
                    yield* settlePromptInFlight(
                      input.threadId,
                      prepared.turnId,
                      prepared.acpSessionId,
                      prepared.sessionGenerationId,
                      outcome._tag === "Failure"
                        ? {
                            errorMessage: mapAcpToAdapterError(
                              PROVIDER,
                              input.threadId,
                              "session/prompt",
                              outcome.error,
                            ).message,
                          }
                        : {
                            completedStopReason: completedStopReasonFromPromptResponse(
                              outcome.result,
                            ),
                          },
                    );
                    return;
                  }
                  if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                    return;
                  }
                  if (
                    ctx.promptsInFlight <= 0 ||
                    ctx.activeTurnId !== prepared.turnId ||
                    ctx.session.activeTurnId !== prepared.turnId
                  ) {
                    return;
                  }
                  if (outcome._tag === "Failure") {
                    yield* settlePromptInFlight(
                      input.threadId,
                      prepared.turnId,
                      prepared.acpSessionId,
                      prepared.sessionGenerationId,
                      {
                        errorMessage: mapAcpToAdapterError(
                          PROVIDER,
                          input.threadId,
                          "session/prompt",
                          outcome.error,
                        ).message,
                      },
                    );
                    return;
                  }

                  yield* Effect.uninterruptible(
                    Effect.gen(function* () {
                      appendPromptResultToTurn(
                        ctx,
                        prepared.turnId,
                        prepared.promptParts,
                        outcome.result,
                        prepared.promptSequence,
                      );
                      ctx.promptWasCancelled ||= outcome.result.stopReason === "cancelled";
                      ctx.session = {
                        ...ctx.session,
                        status: "running",
                        activeTurnId: prepared.turnId,
                        updatedAt: yield* nowIso,
                      };
                      const remainingPrompts = Math.max(0, ctx.promptsInFlight - 1);
                      ctx.promptsInFlight = remainingPrompts;

                      // Only the last remaining prompt settles the turn. A steer-
                      // superseded prompt resolving while another is in flight or
                      // pending must leave the merged turn running.
                      if (
                        remainingPrompts === 0 &&
                        ctx.activeTurnId === prepared.turnId &&
                        ctx.session.activeTurnId === prepared.turnId
                      ) {
                        if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                          return;
                        }
                        const completedAt = yield* nowIso;
                        const { activeTurnId: _completedTurnId, ...readySession } = ctx.session;
                        ctx.activeTurnId = undefined;
                        ctx.session = {
                          ...readySession,
                          status: "ready",
                          updatedAt: completedAt,
                        };
                        const completedStopReason = completedStopReasonFromPromptResponse(
                          outcome.result,
                        );
                        const promptFailureMessage = ctx.promptFailureMessage;
                        const promptWasCancelled = ctx.promptWasCancelled;
                        ctx.promptFailureMessage = undefined;
                        ctx.promptWasCancelled = false;
                        yield* settleOpenToolCalls(
                          ctx,
                          prepared.turnId,
                          promptFailureMessage !== undefined || promptWasCancelled
                            ? "failed"
                            : "completed",
                        );
                        yield* offerRuntimeEvent(
                          promptFailureMessage !== undefined
                            ? {
                                type: "turn.completed",
                                ...(yield* makeEventStamp()),
                                provider: PROVIDER,
                                threadId: input.threadId,
                                turnId: prepared.turnId,
                                payload: {
                                  state: "failed",
                                  errorMessage: promptFailureMessage,
                                  sessionGenerationId: prepared.sessionGenerationId,
                                },
                              }
                            : {
                                type: "turn.completed",
                                ...(yield* makeEventStamp()),
                                provider: PROVIDER,
                                threadId: input.threadId,
                                turnId: prepared.turnId,
                                payload: {
                                  state: promptWasCancelled ? "cancelled" : "completed",
                                  stopReason: promptWasCancelled
                                    ? "cancelled"
                                    : completedStopReason,
                                  sessionGenerationId: prepared.sessionGenerationId,
                                },
                              },
                        );
                        ctx.interruptedTurnIds.delete(prepared.turnId);
                      }
                    }),
                  );
                }),
              );
            });
            yield* completePrompt.pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Failed to settle Hermes prompt.", {
                  cause,
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                }),
              ),
              Effect.forkIn(prepared.scope, {
                startImmediately: true,
                uninterruptible: false,
              }),
            );
            return {
              threadId: input.threadId,
              turnId: prepared.turnId,
              resumeCursor: prepared.resumeCursor,
            };
          }),
        );
      });

    const interruptTurn: HermesAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const observed = yield* Effect.sync(() => {
            const ctx = sessions.get(threadId);
            if (!ctx || ctx.stopped) {
              return {
                _tag: "Proceed" as const,
                acpSessionId: undefined,
                interruptedTurnId: turnId,
              };
            }
            const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
            if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
              return { _tag: "Ignore" as const };
            }
            const interruptedTurnId = turnId ?? activeTurnId;
            if (interruptedTurnId !== undefined) {
              ctx.interruptedTurnIds.add(interruptedTurnId);
            }
            return {
              _tag: "Proceed" as const,
              acpSessionId: ctx.acpSessionId,
              interruptedTurnId,
            };
          });
          if (observed._tag === "Ignore") {
            return;
          }

          yield* withThreadLock(
            threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(threadId);
              if (
                observed.acpSessionId !== undefined &&
                ctx.acpSessionId !== observed.acpSessionId
              ) {
                return;
              }
              const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
              if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
                return;
              }
              if (
                observed.interruptedTurnId !== undefined &&
                activeTurnId !== undefined &&
                activeTurnId !== observed.interruptedTurnId
              ) {
                return;
              }
              const interruptedTurnId =
                observed.interruptedTurnId ?? turnId ?? activeTurnId ?? ctx.session.activeTurnId;
              yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
              yield* Effect.ignore(
                ctx.acp.cancel.pipe(
                  Effect.mapError((error) =>
                    mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
                  ),
                ),
              );
              if (interruptedTurnId) {
                ctx.interruptedTurnIds.add(interruptedTurnId);
                yield* settlePromptInFlight(
                  threadId,
                  interruptedTurnId,
                  ctx.acpSessionId,
                  ctx.sessionGenerationId,
                  {
                    completedStopReason: "cancelled",
                    settleAllPrompts: true,
                  },
                ).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      ctx.interruptedTurnIds.delete(interruptedTurnId);
                    }),
                  ),
                );
              } else if (
                ctx.promptsInFlight > 0 ||
                ctx.session.status === "running" ||
                ctx.session.status === "connecting"
              ) {
                const updatedAt = yield* nowIso;
                ctx.promptsInFlight = 0;
                ctx.activeTurnId = undefined;
                const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
                ctx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt,
                };
              }
            }),
          );
        }),
      );

    const respondToRequest: HermesAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: HermesAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      _answers,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/elicitation",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      });

    const readThread: HermesAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          turns: ctx.turns.map((turn) => ({
            ...turn,
            items: turn.items.map(({ promptSequence: _promptSequence, ...item }) => item),
          })),
        };
      });

    const rollbackThread: HermesAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Hermes ACP sessions do not support provider-side rollback yet.",
        });
      });

    const stopSession: HermesAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: HermesAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const listSkills: NonNullable<HermesAdapterShape["listSkills"]> = (_input) =>
      readHermesSkillsSnapshot(
        options?.environment ? { environment: options.environment } : {},
      ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));

    const hasSession: HermesAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: HermesAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      listSkills,
      listSkillsTimeoutMillis: 5_000,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies HermesAdapterShape;
  });
}
