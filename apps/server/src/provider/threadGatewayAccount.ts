/**
 * Which pooled gateway account serves a thread's provider session, read from the
 * gateway's sticky session-affinity binding rather than account priorities.
 * Claude only: other providers carry no session id the gateway recognizes.
 * Every unsupported or failed path answers null.
 */
import type {
  OrchestrationV2AppThread,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  ProviderInstanceId,
  ProviderUsageThreadAccountInput,
  ProviderUsageThreadAccountResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";

import type {
  ProjectionStoreV2Error,
  ProjectionThreadProviderContext,
} from "../orchestration-v2/ProjectionStore.ts";
import {
  probeCliProxyApiSessionAccount,
  resolveCliProxyApiUsageProbeTarget,
} from "./cliProxyApiUsage.ts";
import type { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";

const CLAUDE_DRIVER = "claudeAgent";

/**
 * A session idle longer than this is treated as absent. The gateway's
 * session-affinity TTL (an hour, sliding) has certainly lapsed by then, so a
 * probe would not read an existing binding — it would create a fresh one for
 * a session that may never run again, and report the cold pick as "current".
 */
const SESSION_FRESHNESS_MS = 60 * 60 * 1_000;

/** Claude session ids are UUIDs; anything else is never sent to the gateway. */
function isClaudeSessionUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * The Claude session UUID of a thread's live root provider session, or null
 * when there is none worth probing: no active provider thread, a non-Claude
 * driver, no bound session, a stopped or errored session, a session idle past
 * the gateway's affinity TTL, or a native id that is not a session UUID.
 */
export function liveClaudeSessionId(input: {
  readonly providerThread: OrchestrationV2ProviderThread | undefined;
  readonly providerSession: OrchestrationV2ProviderSession | undefined;
  readonly nowMs: number;
}): string | null {
  const { providerThread, providerSession } = input;
  if (providerThread === undefined || providerSession === undefined) return null;
  if (providerThread.driver !== CLAUDE_DRIVER || providerThread.ownerNodeId !== null) return null;
  if (providerSession.id !== providerThread.providerSessionId) return null;
  // A stopped or errored runtime has no live session to read a binding for —
  // probing one would bind a dead session to a pooled account.
  if (providerSession.status === "stopped" || providerSession.status === "error") return null;
  const lastActivityMs = Math.max(
    DateTime.toEpochMillis(providerSession.updatedAt),
    DateTime.toEpochMillis(providerThread.updatedAt),
  );
  if (input.nowMs - lastActivityMs > SESSION_FRESHNESS_MS) return null;
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  return typeof nativeId === "string" && isClaudeSessionUuid(nativeId) ? nativeId : null;
}

/** The projection reads the reader needs; `ProjectionStoreV2Shape` satisfies it. */
export interface ThreadGatewayAccountProjections {
  readonly getThread: (
    threadId: ThreadId,
  ) => Effect.Effect<
    Pick<OrchestrationV2AppThread, "activeProviderThreadId" | "providerInstanceId">,
    ProjectionStoreV2Error
  >;
  readonly getThreadProviderContext: (
    threadId: ThreadId,
    targetInstanceId: ProviderInstanceId,
  ) => Effect.Effect<
    Pick<ProjectionThreadProviderContext, "providerSessions" | "providerThreads">,
    ProjectionStoreV2Error
  >;
}

export interface ThreadGatewayAccountDependencies {
  readonly projections: ThreadGatewayAccountProjections;
  readonly instanceRegistry: Pick<ProviderInstanceRegistry["Service"], "getInstanceConfig">;
  readonly httpClient: HttpClient.HttpClient;
}

/**
 * Build the `providerUsage.threadAccount` reader. Never fails: a thread
 * without a live session, a non-Claude provider, a non-gateway instance, and
 * a probe error all answer `{ authIndex: null }`.
 */
export function makeThreadGatewayAccountReader(dependencies: ThreadGatewayAccountDependencies) {
  const none: ProviderUsageThreadAccountResult = { authIndex: null };
  const readLiveSession = Effect.fn("ThreadGatewayAccount.readLiveSession")(
    function* (input: ProviderUsageThreadAccountInput) {
      const thread = yield* dependencies.projections.getThread(input.threadId);
      const activeProviderThreadId = thread.activeProviderThreadId;
      if (activeProviderThreadId === null) return undefined;
      const context = yield* dependencies.projections.getThreadProviderContext(
        input.threadId,
        thread.providerInstanceId,
      );
      const providerThread = context.providerThreads.find(
        (candidate) => candidate.id === activeProviderThreadId,
      );
      const providerSession = context.providerSessions.find(
        (candidate) => candidate.id === providerThread?.providerSessionId,
      );
      const sessionId = liveClaudeSessionId({
        providerThread,
        providerSession,
        nowMs: yield* Clock.currentTimeMillis,
      });
      return sessionId === null || providerThread === undefined
        ? undefined
        : {
            sessionId,
            instanceId: providerThread.providerInstanceId,
            driver: providerThread.driver,
          };
    },
    Effect.orElseSucceed(() => undefined),
  );

  return (
    input: ProviderUsageThreadAccountInput,
  ): Effect.Effect<ProviderUsageThreadAccountResult> =>
    Effect.gen(function* () {
      const live = yield* readLiveSession(input);
      if (live === undefined) return none;
      const envelope = yield* (
        dependencies.instanceRegistry.getInstanceConfig?.(live.instanceId) ?? Effect.undefined
      );
      if (envelope === undefined) return none;
      const target = resolveCliProxyApiUsageProbeTarget(envelope, live.driver);
      if (target === null) return none;
      const authIndex = yield* probeCliProxyApiSessionAccount(target, {
        sessionId: live.sessionId,
        model: input.model,
      }).pipe(Effect.provideService(HttpClient.HttpClient, dependencies.httpClient));
      return { authIndex };
    });
}
