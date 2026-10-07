import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadWorktreeSwitchScheduler from "../../../orchestration-v2/ThreadWorktreeSwitchScheduler.ts";
import type { WorktreeSwitchError } from "../../../orchestration-v2/worktreeSwitch.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readOwnedCaller } from "../../threadAccess.ts";
import { WorktreeSwitchToolkit } from "./tools.ts";

const failure = (error: WorktreeSwitchError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/** Fork: deferred worktree switch tools, acting on the credential's own thread. */
export const WorktreeSwitchToolkitHandlersLive = McpToolAccess.toLayer(WorktreeSwitchToolkit, {
  switch_worktree: McpToolAccess.actsOnOwnThread((input) =>
    Effect.gen(function* () {
      const thread = yield* readOwnedCaller();
      const scheduler = yield* ThreadWorktreeSwitchScheduler.ThreadWorktreeSwitchScheduler;
      return yield* scheduler
        .request({ threadId: thread.id, targetPath: input.path })
        .pipe(Effect.mapError(failure));
    }),
  ),
  cancel_worktree_switch: McpToolAccess.actsOnOwnThread(() =>
    Effect.gen(function* () {
      const thread = yield* readOwnedCaller();
      const scheduler = yield* ThreadWorktreeSwitchScheduler.ThreadWorktreeSwitchScheduler;
      return yield* scheduler.cancel({ threadId: thread.id }).pipe(Effect.mapError(failure));
    }),
  ),
  // A read: the handler still requires owning the thread.
  worktree_switch_status: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const thread = yield* readOwnedCaller();
      const scheduler = yield* ThreadWorktreeSwitchScheduler.ThreadWorktreeSwitchScheduler;
      return yield* scheduler.status(thread.id).pipe(Effect.mapError(failure));
    }),
  ),
});
