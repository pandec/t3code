import { CommandId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  resolveWorktreeSwitchTarget,
  WorktreeSwitchError,
} from "../../../orchestration/worktreeSwitch.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { WorktreeToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const readThread = Effect.gen(function* () {
    const scope = yield* McpInvocationContext;
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(
        Effect.mapError(() => new WorktreeSwitchError({ message: "Could not read this thread." })),
      );
    if (Option.isNone(thread))
      return yield* new WorktreeSwitchError({ message: "This thread no longer exists." });
    if (thread.value.session?.providerInstanceId !== scope.providerInstanceId)
      return yield* new WorktreeSwitchError({
        message: "This provider no longer owns the thread.",
      });
    return thread.value;
  });
  const status = readThread.pipe(
    Effect.map((thread) => ({ request: thread.worktreeSwitch ?? null })),
  );
  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine
      .dispatch(command)
      .pipe(Effect.mapError((cause) => new WorktreeSwitchError({ message: cause.message })));
  return WorktreeToolkit.of({
    switch_worktree: (input) =>
      Effect.gen(function* () {
        const thread = yield* readThread;
        if (thread.session?.providerName !== "codex" || thread.latestTurn?.state !== "running")
          return yield* new WorktreeSwitchError({
            message: "Call this from a running Codex turn. Claude can use EnterWorktree.",
          });
        const project = yield* snapshots
          .getProjectShellById(thread.projectId)
          .pipe(
            Effect.mapError(
              () => new WorktreeSwitchError({ message: "Could not read the project." }),
            ),
          );
        if (Option.isNone(project))
          return yield* new WorktreeSwitchError({ message: "This project no longer exists." });
        const target = yield* resolveWorktreeSwitchTarget(project.value.workspaceRoot, input.path);
        yield* dispatch({
          type: "thread.worktree-switch.schedule",
          commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
          threadId: thread.id,
          turnId: thread.latestTurn.turnId,
          targetPath: target.targetPath,
        });
        return yield* status;
      }),
    cancel_worktree_switch: () =>
      Effect.gen(function* () {
        const thread = yield* readThread;
        if (thread.worktreeSwitch?.status === "pending")
          yield* dispatch({
            type: "thread.worktree-switch.cancel",
            commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
            threadId: thread.id,
          });
        return yield* status;
      }),
    worktree_switch_status: () => status,
  });
});
export const WorktreeToolkitHandlersLive = WorktreeToolkit.toLayer(make);
