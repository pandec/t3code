import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, readThread } from "../../threadAccess.ts";
import * as ThreadGroupsMcpService from "../../ThreadGroupsMcpService.ts";
import { ThreadGroupsToolkit } from "./tools.ts";

const missing = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export const ThreadGroupsToolkitHandlersLive = McpToolAccess.toLayer(ThreadGroupsToolkit, {
  // Listing reads; creating a group changes environment settings; moving a
  // thread writes that thread.
  t3_thread_groups: McpToolAccess.dependsOnParams(
    (input): McpToolAccess.CallAccess =>
      input.action === "list"
        ? { _tag: "reads" }
        : input.action === "create"
          ? { _tag: "writesEnvironment" }
          : { _tag: "writesThreads", threads: [input.threadId] },
    (input) =>
      Effect.gen(function* () {
        const service = yield* ThreadGroupsMcpService.ThreadGroupsMcpService;
        switch (input.action) {
          case "list": {
            yield* readCaller();
            return { action: input.action, ...(yield* service.list()) };
          }
          case "create": {
            if (input.name === undefined) return yield* missing("create needs a name.");
            // Fork: re-check the caller under its thread lock, held while create waits for its own.
            return {
              action: input.action,
              ...(yield* McpToolAccess.recheckedWrite(
                McpToolAccess.environmentCheck,
                service.create(input.name),
              )),
            };
          }
          case "move_thread": {
            if (input.groupId === undefined)
              return yield* missing("move_thread needs groupId: a group id, or null for Active.");
            const { projection } = yield* readThread(input.threadId);
            return {
              action: input.action,
              ...(yield* service.moveThread({
                threadId: projection.thread.id,
                groupId: input.groupId,
              })),
            };
          }
        }
      }),
  ),
});
