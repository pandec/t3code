import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type ClientOrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  type CliLiveOrchestrationServer,
  dispatchLiveOrchestrationCommand,
  requireLiveOrchestrationServer,
  withCliOrchestrationSession,
} from "./orchestration.ts";
import { findActiveProjectTarget } from "./projectTarget.ts";

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const jsonOutput = (value: unknown) => JSON.stringify(value, null, 2);

export class ThreadCliNotFoundError extends Schema.TaggedErrorClass<ThreadCliNotFoundError>()(
  "ThreadCliNotFoundError",
  {
    operation: Schema.Literal("resolveThread"),
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `No active thread found for '${this.threadId}'.`;
  }
}

export class ThreadCliMessageEmptyError extends Schema.TaggedErrorClass<ThreadCliMessageEmptyError>()(
  "ThreadCliMessageEmptyError",
  {
    operation: Schema.Literal("validateMessage"),
  },
) {
  override get message(): string {
    return "Thread message cannot be empty.";
  }
}

export class ThreadCliTitleEmptyError extends Schema.TaggedErrorClass<ThreadCliTitleEmptyError>()(
  "ThreadCliTitleEmptyError",
  {
    operation: Schema.Literal("validateTitle"),
  },
) {
  override get message(): string {
    return "Thread title cannot be empty.";
  }
}

const randomUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.orDie,
);

const resolveThread = (
  live: CliLiveOrchestrationServer,
  rawThreadId: string,
): Effect.Effect<OrchestrationThreadShell, ThreadCliNotFoundError> => {
  const threadId = rawThreadId.trim();
  const thread = live.shell.threads.find(
    (candidate) => candidate.id === threadId && candidate.archivedAt === null,
  );
  return thread
    ? Effect.succeed(thread)
    : Effect.fail(
        new ThreadCliNotFoundError({ operation: "resolveThread", threadId: rawThreadId }),
      );
};

const requireTrimmedMessage = (message: string) => {
  const trimmed = message.trim();
  return trimmed.length > 0
    ? Effect.succeed(trimmed)
    : Effect.fail(new ThreadCliMessageEmptyError({ operation: "validateMessage" }));
};

const requireTrimmedTitle = (title: string) => {
  const trimmed = title.trim();
  return trimmed.length > 0
    ? Effect.succeed(trimmed)
    : Effect.fail(new ThreadCliTitleEmptyError({ operation: "validateTitle" }));
};

export const deriveThreadCliTitle = (message: string): string => {
  const compact = message.trim().replace(/\s+/g, " ");
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
};

const threadState = (thread: OrchestrationThreadShell) => thread.latestTurn?.state ?? "idle";

const threadSummary = (thread: OrchestrationThreadShell) => ({
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  state: threadState(thread),
  sessionStatus: thread.session?.status ?? null,
  activeTurnId: thread.session?.activeTurnId ?? null,
  hasPendingApprovals: thread.hasPendingApprovals,
  hasPendingUserInput: thread.hasPendingUserInput,
  latestUserMessageAt: thread.latestUserMessageAt,
  updatedAt: thread.updatedAt,
});

const runThreadCli = Effect.fn("runThreadCli")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly live: CliLiveOrchestrationServer;
    readonly environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"];
  }) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = config.logLevel;
  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const live = yield* requireLiveOrchestrationServer(environmentAuth, config, "t3 thread cli");
    return yield* run({ live, environmentAuth });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.runtimeLayer, WorkspacePaths.layer).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const dispatchThreadCommand = (
  input: {
    readonly live: CliLiveOrchestrationServer;
    readonly environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"];
  },
  command: ClientOrchestrationCommand,
) =>
  withCliOrchestrationSession(input.environmentAuth, "t3 thread cli", (token) =>
    dispatchLiveOrchestrationCommand(input.live.origin, token, command),
  );

const threadListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: Flag.string("project").pipe(
    Flag.withDescription("Filter by project id or workspace root."),
    Flag.optional,
  ),
  state: Flag.choice("state", ["idle", "running", "interrupted", "completed", "error"]).pipe(
    Flag.withDescription("Filter by latest turn state."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active threads."),
  Command.withHandler((flags) =>
    runThreadCli(flags, ({ live }) =>
      Effect.gen(function* () {
        const project = Option.isSome(flags.project)
          ? yield* findActiveProjectTarget({
              projects: live.shell.projects,
              identifier: flags.project.value,
            })
          : null;
        const requestedState = Option.getOrNull(flags.state);
        const threads = live.shell.threads
          .filter((thread) => thread.archivedAt === null)
          .filter((thread) => project === null || thread.projectId === project.id)
          .filter((thread) => requestedState === null || threadState(thread) === requestedState)
          .map(threadSummary);
        yield* Console.log(
          flags.json
            ? jsonOutput({ threads })
            : threads.length === 0
              ? "No matching threads."
              : threads
                  .map(
                    (thread) =>
                      `${thread.id}\t${thread.state}\t${thread.title}\t${thread.projectId}`,
                  )
                  .join("\n"),
        );
      }),
    ),
  ),
);

const threadNewCommand = Command.make("new", {
  ...projectLocationFlags,
  project: Flag.string("project").pipe(Flag.withDescription("Project id or workspace root.")),
  message: Flag.string("message").pipe(Flag.withDescription("Initial user message.")),
  title: Flag.string("title").pipe(Flag.withDescription("Optional thread title."), Flag.optional),
  runtimeMode: Flag.choice("runtime-mode", RuntimeMode.literals).pipe(
    Flag.withDefault(DEFAULT_RUNTIME_MODE),
  ),
  interactionMode: Flag.choice("interaction-mode", ProviderInteractionMode.literals).pipe(
    Flag.withDefault(DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a thread and start its first turn."),
  Command.withHandler((flags) =>
    runThreadCli(flags, (input) =>
      Effect.gen(function* () {
        const message = yield* requireTrimmedMessage(flags.message);
        const project = yield* findActiveProjectTarget({
          projects: input.live.shell.projects,
          identifier: flags.project,
        });
        const projectShell = input.live.shell.projects.find((item) => item.id === project.id)!;
        const title = Option.isSome(flags.title)
          ? yield* requireTrimmedTitle(flags.title.value)
          : deriveThreadCliTitle(message);
        const modelSelection =
          projectShell.defaultModelSelection ??
          ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection();
        const threadId = ThreadId.make(yield* randomUuid);
        const createCommandId = CommandId.make(yield* randomUuid);
        const commandId = CommandId.make(yield* randomUuid);
        const messageId = MessageId.make(yield* randomUuid);
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* dispatchThreadCommand(input, {
          type: "thread.create",
          commandId: createCommandId,
          threadId,
          projectId: project.id,
          title,
          modelSelection,
          runtimeMode: flags.runtimeMode,
          interactionMode: flags.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt,
        });
        const result = yield* dispatchThreadCommand(input, {
          type: "thread.turn.start",
          commandId,
          threadId,
          message: { messageId, role: "user", text: message, attachments: [] },
          modelSelection,
          titleSeed: title,
          runtimeMode: flags.runtimeMode,
          interactionMode: flags.interactionMode,
          createdAt,
        }).pipe(
          Effect.tapError(() =>
            Effect.gen(function* () {
              const cleanupCommandId = CommandId.make(yield* randomUuid);
              yield* dispatchThreadCommand(input, {
                type: "thread.delete",
                commandId: cleanupCommandId,
                threadId,
              }).pipe(Effect.ignore({ log: true }));
            }),
          ),
        );
        yield* Console.log(
          flags.json
            ? jsonOutput({
                threadId,
                projectId: project.id,
                createCommandId,
                commandId,
                messageId,
                sequence: result.sequence,
              })
            : `Created thread ${threadId} (${title}) and started its first turn.`,
        );
      }),
    ),
  ),
);

const threadSendCommand = Command.make("send", {
  ...projectLocationFlags,
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("Thread id.")),
  message: Flag.string("message").pipe(Flag.withDescription("User message.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Send a message to a thread, steering it when already running."),
  Command.withHandler((flags) =>
    runThreadCli(flags, (input) =>
      Effect.gen(function* () {
        const thread = yield* resolveThread(input.live, flags.threadId);
        const message = yield* requireTrimmedMessage(flags.message);
        const commandId = CommandId.make(yield* randomUuid);
        const messageId = MessageId.make(yield* randomUuid);
        const result = yield* dispatchThreadCommand(input, {
          type: "thread.turn.start",
          commandId,
          threadId: thread.id,
          message: { messageId, role: "user", text: message, attachments: [] },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* Console.log(
          flags.json
            ? jsonOutput({
                threadId: thread.id,
                commandId,
                messageId,
                sequence: result.sequence,
                action: threadState(thread) === "running" ? "steered" : "started",
              })
            : `${threadState(thread) === "running" ? "Steered" : "Started"} thread ${thread.id}.`,
        );
      }),
    ),
  ),
);

const threadRenameCommand = Command.make("rename", {
  ...projectLocationFlags,
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("Thread id.")),
  title: Argument.string("title").pipe(Argument.withDescription("New thread title.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Rename a thread."),
  Command.withHandler((flags) =>
    runThreadCli(flags, (input) =>
      Effect.gen(function* () {
        const thread = yield* resolveThread(input.live, flags.threadId);
        const title = yield* requireTrimmedTitle(flags.title);
        if (title === thread.title) {
          yield* Console.log(
            flags.json
              ? jsonOutput({ threadId: thread.id, title, action: "unchanged" })
              : `Thread ${thread.id} is already named ${title}.`,
          );
          return;
        }
        const commandId = CommandId.make(yield* randomUuid);
        const result = yield* dispatchThreadCommand(input, {
          type: "thread.meta.update",
          commandId,
          threadId: thread.id,
          title,
        });
        yield* Console.log(
          flags.json
            ? jsonOutput({
                threadId: thread.id,
                title,
                previousTitle: thread.title,
                commandId,
                sequence: result.sequence,
                action: "renamed",
              })
            : `Renamed thread ${thread.id} to ${title}.`,
        );
      }),
    ),
  ),
);

const threadInterruptCommand = Command.make("interrupt", {
  ...projectLocationFlags,
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("Thread id.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Interrupt the active turn in a thread."),
  Command.withHandler((flags) =>
    runThreadCli(flags, (input) =>
      Effect.gen(function* () {
        const thread = yield* resolveThread(input.live, flags.threadId);
        const commandId = CommandId.make(yield* randomUuid);
        const result = yield* dispatchThreadCommand(input, {
          type: "thread.turn.interrupt",
          commandId,
          threadId: thread.id,
          ...(thread.latestTurn?.state === "running" ? { turnId: thread.latestTurn.turnId } : {}),
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* Console.log(
          flags.json
            ? jsonOutput({
                threadId: thread.id,
                commandId,
                sequence: result.sequence,
                action: "interrupt-requested",
              })
            : `Requested interruption for thread ${thread.id}.`,
        );
      }),
    ),
  ),
);

const threadStatusCommand = Command.make("status", {
  ...projectLocationFlags,
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("Thread id.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show thread status."),
  Command.withHandler((flags) =>
    runThreadCli(flags, ({ live }) =>
      Effect.gen(function* () {
        const thread = yield* resolveThread(live, flags.threadId);
        const summary = threadSummary(thread);
        yield* Console.log(
          flags.json
            ? jsonOutput(summary)
            : [
                `${summary.id}\t${summary.state}\t${summary.title}`,
                `Project: ${summary.projectId}`,
                `Session: ${summary.sessionStatus ?? "not started"}`,
                `Pending approval: ${summary.hasPendingApprovals ? "yes" : "no"}`,
                `Pending input: ${summary.hasPendingUserInput ? "yes" : "no"}`,
              ].join("\n"),
        );
      }),
    ),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Manage threads and agent turns."),
  Command.withSubcommands([
    threadListCommand,
    threadNewCommand,
    threadSendCommand,
    threadRenameCommand,
    threadInterruptCommand,
    threadStatusCommand,
  ]),
);
