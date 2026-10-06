import type { OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { withCliJsonErrorOutput } from "./errorOutput.ts";
import {
  resolveCliLiveServerReadTimeouts,
  withResolvedLiveOrchestrationServer,
} from "./orchestration.ts";

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

/** Thread totals over the live shell's active (unarchived) threads. */
export const summarizeShellStatus = (shell: OrchestrationV2ShellSnapshot) => {
  const threads = shell.threads.filter((thread) => thread.archivedAt === null);
  return {
    snapshotSequence: shell.snapshotSequence,
    projectCount: shell.projects.length,
    threadCount: threads.length,
    runningThreadCount: threads.filter((thread) => thread.activeRunId !== null).length,
    pendingApprovalCount: threads.filter(
      (thread) =>
        thread.pendingRuntimeRequest !== null &&
        thread.pendingRuntimeRequest.kind !== "user_input" &&
        thread.pendingRuntimeRequest.kind !== "auth_refresh",
    ).length,
    pendingUserInputCount: threads.filter(
      (thread) => thread.pendingRuntimeRequest?.kind === "user_input",
    ).length,
  };
};

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
        const timeouts = yield* resolveCliLiveServerReadTimeouts(flags.timeoutMs);
        const live = yield* withResolvedLiveOrchestrationServer(
          { environmentAuth, config, label: "t3 status cli", timeouts },
          (resolved) => Effect.succeed(resolved),
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

        const status = {
          running: true,
          origin: live.value.origin,
          pid: live.value.pid,
          startedAt: live.value.startedAt,
          ...summarizeShellStatus(live.value.shell),
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
          EnvironmentAuth.layerRuntime.pipe(
            Layer.provideMerge(FetchHttpClient.layer),
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
          ),
        ),
        Effect.provideService(References.MinimumLogLevel, minimumLogLevel),
      );
    }).pipe(withCliJsonErrorOutput(flags.json)),
  ),
);
