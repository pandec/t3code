import {
  OrchestrationV2ThreadWorktreeSwitch,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadWorktreeSwitchScheduler from "../../../orchestration-v2/ThreadWorktreeSwitchScheduler.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Fork: deferred worktree switch tools for the credential's own thread. */
export const WorktreeSwitchToolResult = Schema.Struct({
  request: Schema.NullOr(OrchestrationV2ThreadWorktreeSwitch),
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ThreadWorktreeSwitchScheduler.ThreadWorktreeSwitchScheduler,
];

const SwitchWorktree = Tool.make("switch_worktree", {
  description:
    "For Codex: when the user asks to work in a new worktree, create the worktree and use this tool to move the current thread there. Pass its absolute path. The move happens AFTER your current turn and final checkpoint finish. Your cwd does NOT change during this turn: finish your response after requesting the move. T3's checkout display and the next turn will use the target, preserving this conversation. You can pass the project checkout path to return there. A later call replaces the pending target. Failed/interrupted turns, new work, archiving, or concurrent checkout changes cancel the move. Use worktree_switch_status to inspect the request.",
  parameters: Schema.Struct({
    path: TrimmedNonEmptyString.annotate({
      description: "Absolute path of an existing checkout of this thread's repository.",
    }),
  }),
  success: WorktreeSwitchToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Switch this thread to a worktree after the turn")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const CancelWorktreeSwitch = Tool.make("cancel_worktree_switch", {
  description:
    "Cancel this thread's pending worktree switch. Does not undo an already completed move; use switch_worktree with the previous checkout path to move back after the current turn. Returns the current state when there is no pending request.",
  success: WorktreeSwitchToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel worktree switch")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const WorktreeSwitchStatus = Tool.make("worktree_switch_status", {
  description:
    "Read this thread's latest worktree switch request, including whether it is pending, completed, cancelled, or failed and the reason. Null means no switch has been requested.",
  success: WorktreeSwitchToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get worktree switch status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const WorktreeSwitchToolkit = Toolkit.make(
  SwitchWorktree,
  CancelWorktreeSwitch,
  WorktreeSwitchStatus,
);
