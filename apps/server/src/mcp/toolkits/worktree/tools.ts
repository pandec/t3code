import { ThreadWorktreeSwitch, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { WorktreeSwitchError } from "../../../orchestration/worktreeSwitch.ts";

const result = Schema.Struct({ request: Schema.NullOr(ThreadWorktreeSwitch) });

const SwitchWorktree = Tool.make("switch_worktree", {
  description:
    "For Codex: after creating a git worktree, call this with its absolute path to move this thread there AFTER your current turn and final checkpoint finish. Your cwd does NOT change during this turn: finish your response after requesting the move. T3's checkout display and the next turn will use the target, preserving this conversation. You can pass the project checkout path to return there. A later call replaces the pending target. Failed/interrupted turns or concurrent checkout changes cancel the move. Use worktree_switch_status to inspect the request.",
  parameters: Schema.Struct({ path: TrimmedNonEmptyString }),
  success: result,
  failure: WorktreeSwitchError,
  dependencies: [McpInvocationContext, FileSystem.FileSystem, Path.Path],
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const CancelWorktreeSwitch = Tool.make("cancel_worktree_switch", {
  description:
    "Cancel this thread's pending worktree switch. Does not undo an already completed move; use switch_worktree with the previous checkout path to move back after the current turn.",
  success: result,
  failure: WorktreeSwitchError,
  dependencies: [McpInvocationContext, FileSystem.FileSystem, Path.Path],
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const WorktreeSwitchStatus = Tool.make("worktree_switch_status", {
  description:
    "Read this thread's latest worktree switch request, including whether it is pending, completed, cancelled, or failed and the reason. Null means no switch has been requested.",
  success: result,
  failure: WorktreeSwitchError,
  dependencies: [McpInvocationContext, FileSystem.FileSystem, Path.Path],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.OpenWorld, false);

export const WorktreeToolkit = Toolkit.make(
  SwitchWorktree,
  CancelWorktreeSwitch,
  WorktreeSwitchStatus,
);
