import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { tryResolveLiveOrchestrationServer } from "./orchestration.ts";
import { threadCliState } from "./threadState.ts";

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

export const statusCommand = Command.make("status", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show local T3 Code server and orchestration status."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const minimumLogLevel = flags.json ? "None" : config.logLevel;
      return yield* Effect.gen(function* () {
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const live = yield* tryResolveLiveOrchestrationServer(
          environmentAuth,
          config,
          "t3 status cli",
        );
        if (Option.isNone(live)) {
          yield* Console.log(
            flags.json
              ? // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON is a presentation DTO.
                JSON.stringify({ running: false }, null, 2)
              : "T3 Code server is not running for this data directory.",
          );
          return;
        }

        const activeThreads = live.value.shell.threads.filter(
          (thread) => thread.archivedAt === null,
        );
        const status = {
          running: true,
          origin: live.value.origin,
          pid: live.value.pid,
          startedAt: live.value.startedAt,
          snapshotSequence: live.value.shell.snapshotSequence,
          projectCount: live.value.shell.projects.length,
          threadCount: activeThreads.length,
          runningThreadCount: activeThreads.filter((thread) => threadCliState(thread) === "running")
            .length,
          pendingApprovalCount: activeThreads.filter((thread) => thread.hasPendingApprovals).length,
          pendingUserInputCount: activeThreads.filter((thread) => thread.hasPendingUserInput)
            .length,
        };
        yield* Console.log(
          flags.json
            ? // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON is a presentation DTO.
              JSON.stringify(status, null, 2)
            : [
                `T3 Code server is running at ${status.origin} (pid ${status.pid}).`,
                `Projects: ${status.projectCount}`,
                `Threads: ${status.threadCount} (${status.runningThreadCount} running)`,
                `Pending approvals: ${status.pendingApprovalCount}`,
                `Pending user input: ${status.pendingUserInputCount}`,
              ].join("\n"),
        );
      }).pipe(
        Effect.provide(
          EnvironmentAuth.runtimeLayer.pipe(
            Layer.provideMerge(FetchHttpClient.layer),
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
          ),
        ),
        Effect.provideService(References.MinimumLogLevel, minimumLogLevel),
      );
    }),
  ),
);
