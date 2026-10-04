import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadWorktreeSwitchScheduler from "../../../orchestration-v2/ThreadWorktreeSwitchScheduler.ts";
import type { WorktreeSwitchError } from "../../../orchestration-v2/worktreeSwitch.ts";
import { readOwnedCaller } from "../../threadAccess.ts";
import { WorktreeSwitchToolkit } from "./tools.ts";

const failure = (error: WorktreeSwitchError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/** Fork: deferred worktree switch tools, acting on the credential's own thread. */
export const WorktreeSwitchToolkitHandlersLive = WorktreeSwitchToolkit.toLayer({
  switch_worktree: (input) =>
    Effect.gen(function* () {
      const thread = yield* readOwnedCaller();
      const scheduler = yield* ThreadWorktreeSwitchScheduler.ThreadWorktreeSwitchScheduler;
      return yield* scheduler
        .request({ threadId: thread.id, targetPath: input.path })
        .pipe(Effect.mapError(failure));
    }),
  cancel_worktree_switch: () =>
    Effect.gen(function* () {
      const thread = yield* readOwnedCaller();
      const scheduler = yield* ThreadWorktreeSwitchScheduler.ThreadWorktreeSwitchScheduler;
      return yield* scheduler.cancel({ threadId: thread.id }).pipe(Effect.mapError(failure));
    }),
  worktree_switch_status: () =>
    Effect.gen(function* () {
      const thread = yield* readOwnedCaller();
      const scheduler = yield* ThreadWorktreeSwitchScheduler.ThreadWorktreeSwitchScheduler;
      return yield* scheduler.status(thread.id).pipe(Effect.mapError(failure));
    }),
});
