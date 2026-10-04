import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  EnvironmentAuthorizationError,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type OrchestrationV2Command,
  OrchestrationV2DispatchCommandError,
  type OrchestrationV2ThreadLaunchInput,
  OrchestrationV2ThreadLaunchError,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ShellStreamItem,
  type ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import {
  CliOrchestrationOutcomeUnknownError,
  type CliLiveServerReadTimeouts,
  issueLiveWebSocketTicket,
} from "./orchestration.ts";

// Thread commands have no HTTP route on orchestration v2; the CLI dispatches
// them over the same WebSocket RPC the clients use, so the server applies
// one code path (user provenance, startup queueing, receipts) for every surface.

const makeLiveRpcClient = RpcClient.make(WsRpcGroup);
export type CliLiveRpcClient = Effect.Success<typeof makeLiveRpcClient>;

const CLI_LIVE_RPC_ACKNOWLEDGEMENT_TIMEOUT = Duration.seconds(30);
const CLI_LIVE_RPC_OPEN_TIMEOUT = Duration.seconds(10);

export class CliOrchestrationCommandRejectedError extends Schema.TaggedError<CliOrchestrationCommandRejectedError>()(
  "CliOrchestrationCommandRejectedError",
  {
    operation: Schema.Literal("dispatchLiveServer"),
    commandType: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const isDispatchCommandError = Schema.is(OrchestrationV2DispatchCommandError);
const isThreadLaunchError = Schema.is(OrchestrationV2ThreadLaunchError);
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

/**
 * Declared server rejections prove the command was not applied. Anything else
 * (a dropped socket, an undecodable reply) leaves the outcome unknown.
 */
export const liveRpcCommandError =
  (commandType: string) =>
  (cause: unknown): CliOrchestrationCommandRejectedError | CliOrchestrationOutcomeUnknownError => {
    if (isDispatchCommandError(cause)) {
      return new CliOrchestrationCommandRejectedError({
        operation: "dispatchLiveServer",
        commandType,
        detail: cause.detail ?? cause.message,
        cause,
      });
    }
    if (isThreadLaunchError(cause) || isEnvironmentAuthorizationError(cause)) {
      return new CliOrchestrationCommandRejectedError({
        operation: "dispatchLiveServer",
        commandType,
        detail: cause.message,
        cause,
      });
    }
    return new CliOrchestrationOutcomeUnknownError({ operation: "dispatchLiveServer", cause });
  };

const withAcknowledgementTimeout =
  (timeout: Duration.Duration) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            new CliOrchestrationOutcomeUnknownError({
              operation: "dispatchLiveServer",
              cause: new Error("Server acknowledgement timed out."),
            }),
          ),
      }),
    );

export const liveServerWebSocketUrl = (origin: string, ticket: string): string => {
  const url = new URL("/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
};

export interface CliLiveRpcConnectionInput {
  readonly origin: string;
  readonly token: string;
  readonly timeouts: CliLiveServerReadTimeouts;
}

/** Opens a WebSocket RPC client to the live server that lives as long as the current scope. */
const makeScopedLiveRpcClient = Effect.fn("makeScopedLiveRpcClient")(function* (
  input: CliLiveRpcConnectionInput,
) {
  const ticket = yield* issueLiveWebSocketTicket(input.origin, input.token, input.timeouts);
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Socket.layerWebSocket(liveServerWebSocketUrl(input.origin, ticket), {
          openTimeout: CLI_LIVE_RPC_OPEN_TIMEOUT,
        }).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor)),
      ),
      Layer.provide(RpcSerialization.layerJson),
    ),
  );
  return yield* makeLiveRpcClient.pipe(Effect.provideContext(protocol));
});

/** Opens one WebSocket RPC client to the live server for the duration of `use`. */
export const withLiveOrchestrationRpc = <A, E, R>(
  input: CliLiveRpcConnectionInput,
  use: (client: CliLiveRpcClient) => Effect.Effect<A, E, R>,
) => Effect.scoped(Effect.flatMap(makeScopedLiveRpcClient(input), use));

/**
 * The live shell stream over its own connection, starting with a full
 * snapshot. Each run opens a fresh connection, so rerunning it reconnects.
 */
export const subscribeLiveShell = (input: CliLiveRpcConnectionInput) =>
  Stream.unwrap(
    Effect.map(makeScopedLiveRpcClient(input), (client) =>
      client["orchestration.subscribeShell"]({}),
    ),
  ).pipe(Stream.mapError(liveRpcCommandError("orchestration.subscribeShell")));

/** Reads a thread's projection: full request entities plus a recent timeline window. */
export const fetchLiveThreadProjection = (
  client: CliLiveRpcClient,
  threadId: ThreadId,
  timeouts: CliLiveServerReadTimeouts,
) =>
  client["orchestration.getThreadProjection"]({ threadId }).pipe(
    Effect.mapError(liveRpcCommandError("orchestration.getThreadProjection")),
    withAcknowledgementTimeout(timeouts.read),
  );

export const dispatchLiveThreadCommand = (
  client: CliLiveRpcClient,
  command: OrchestrationV2Command,
) =>
  client["orchestration.dispatchCommand"](command).pipe(
    Effect.mapError(liveRpcCommandError(command.type)),
    withAcknowledgementTimeout(CLI_LIVE_RPC_ACKNOWLEDGEMENT_TIMEOUT),
  );

export const launchLiveThread = (
  client: CliLiveRpcClient,
  input: OrchestrationV2ThreadLaunchInput,
) =>
  client["orchestration.launchThread"](input).pipe(
    Effect.mapError(liveRpcCommandError("thread.launch")),
    withAcknowledgementTimeout(CLI_LIVE_RPC_ACKNOWLEDGEMENT_TIMEOUT),
  );

/** Reads archived thread shells, which the HTTP shell snapshot omits. */
export const fetchLiveArchivedThreads = (
  client: CliLiveRpcClient,
  timeouts: CliLiveServerReadTimeouts,
) =>
  client["orchestration.getArchivedShellSnapshot"]({}).pipe(
    Effect.map((snapshot) => snapshot.threads),
    Effect.mapError(liveRpcCommandError("orchestration.getArchivedShellSnapshot")),
    withAcknowledgementTimeout(timeouts.read),
  );

export interface LaunchedThreadObservation {
  readonly thread: OrchestrationV2ThreadShell;
  readonly sequence: number;
}

/** The launched thread's shell in one shell stream item, if the item carries it. */
export const observeLaunchedThread = (
  item: OrchestrationV2ShellStreamItem,
  threadId: ThreadId,
): LaunchedThreadObservation | null => {
  if (item.kind === "snapshot") {
    const thread = item.snapshot.threads.find((candidate) => candidate.id === threadId);
    return thread === undefined ? null : { thread, sequence: item.snapshot.snapshotSequence };
  }
  if (item.kind === "thread.updated" && item.thread.id === threadId) {
    return { thread: item.thread, sequence: item.sequence };
  }
  return null;
};

const PREPARATION_FAILED_STATUSES = new Set(["failed", "cancelled", "interrupted"]);

/** Whether the CLI can report the launch: the workspace is bound, or preparation ended. */
export const launchedThreadIsReportable = (
  thread: OrchestrationV2ThreadShell,
  options: { readonly awaitWorktree: boolean },
): boolean =>
  !options.awaitWorktree ||
  thread.worktreePath !== null ||
  PREPARATION_FAILED_STATUSES.has(thread.status);

/**
 * Follows the shell stream until the launched thread is reportable. A new
 * worktree is prepared after the launch acknowledgement, so `thread new`
 * waits for its path like the fork's bootstrap acknowledgement did.
 */
export const awaitLaunchedThread = (
  client: CliLiveRpcClient,
  input: {
    readonly threadId: ThreadId;
    readonly awaitWorktree: boolean;
    readonly timeout: Duration.Duration;
  },
) =>
  client["orchestration.subscribeShell"]({}).pipe(
    Stream.map((item) => observeLaunchedThread(item, input.threadId)),
    Stream.filter(
      (observation): observation is LaunchedThreadObservation =>
        observation !== null &&
        launchedThreadIsReportable(observation.thread, { awaitWorktree: input.awaitWorktree }),
    ),
    Stream.runHead,
    Effect.mapError(liveRpcCommandError("orchestration.subscribeShell")),
    Effect.timeoutOrElse({
      duration: input.timeout,
      orElse: () => Effect.succeed(Option.none<LaunchedThreadObservation>()),
    }),
  );
