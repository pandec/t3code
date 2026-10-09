import {
  NonNegativeInt,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadGroupsMcpService from "../../ThreadGroupsMcpService.ts";

/** Fork: custom sidebar thread groups for agents. */
const ThreadGroupRef = Schema.Struct({ id: Schema.String, name: Schema.String });

export const ThreadGroupsToolResult = Schema.Struct({
  action: Schema.Literals(["list", "create", "move_thread"]),
  /** list: sidebar order; Active is the entry with id null. */
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.NullOr(Schema.String),
        name: Schema.String,
        threadCount: NonNegativeInt,
      }),
    ),
  ),
  /** create: the new or existing group. move_thread: the destination, null for Active. */
  group: Schema.optional(Schema.NullOr(ThreadGroupRef)),
  /** create: false when a group with this exact name already existed. */
  created: Schema.optional(Schema.Boolean),
  threadId: Schema.optional(ThreadId),
  /** move_thread: where the thread was, null for Active. */
  previousGroup: Schema.optional(Schema.NullOr(ThreadGroupRef)),
  /** move_thread: false when the thread was already there. */
  changed: Schema.optional(Schema.Boolean),
});

const ThreadGroups = Tool.make("t3_thread_groups", {
  description:
    "Work with the user's custom sidebar thread groups, which span every project in this environment. action='list' returns groups in sidebar order with their ids, names, and counts of unarchived top-level threads (all members, including pinned, settled, and snoozed ones); Active (ungrouped threads) is the entry with id null and may sit between groups. action='create' with name adds a group at the bottom of the sidebar and returns {id,name}; if a group with that exact name exists it is returned with created=false instead of duplicated. action='move_thread' with groupId (a group id from list or create, or null for Active) moves threadId, or this thread when omitted, and returns the destination, previousGroup, and whether anything changed. Creating and moving need this thread's live run; creating also needs a full-access agent in default mode, and the moved thread must run within this thread's permission modes. To start new threads in a group, pass groupId to t3_thread_launch or create_threads instead of moving them afterwards. Only list, create, and move are available: leave renaming, deleting, and reordering groups to the user.",
  parameters: Schema.Struct({
    action: Schema.Literals(["list", "create", "move_thread"]),
    name: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(80)).annotate({
        description: "create: the group name, compared exactly with existing names.",
      }),
    ),
    threadId: Schema.optional(
      ThreadId.annotate({ description: "move_thread: thread to move. Omit for this thread." }),
    ),
    groupId: Schema.optional(
      Schema.NullOr(TrimmedNonEmptyString).annotate({
        description: "move_thread: required. Destination group id, or null to move to Active.",
      }),
    ),
  }),
  success: ThreadGroupsToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadGroupsMcpService.ThreadGroupsMcpService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
})
  .annotate(Tool.Title, "Manage thread groups")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const ThreadGroupsToolkit = Toolkit.make(ThreadGroups);
