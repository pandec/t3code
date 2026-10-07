import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { readCaller, readFullAccessCaller, readWritableThread } from "../../threadAccess.ts";
import * as ThreadGroupsMcpService from "../../ThreadGroupsMcpService.ts";
import { ThreadGroupsToolkit } from "./tools.ts";

const missing = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export const ThreadGroupsToolkitHandlersLive = ThreadGroupsToolkit.toLayer({
  t3_thread_groups: (input) =>
    Effect.gen(function* () {
      const service = yield* ThreadGroupsMcpService.ThreadGroupsMcpService;
      switch (input.action) {
        case "list": {
          yield* readCaller();
          return { action: input.action, ...(yield* service.list()) };
        }
        case "create": {
          if (input.name === undefined) return yield* missing("create needs a name.");
          yield* readFullAccessCaller(
            "Creating a thread group changes environment settings, so it needs a full-access agent in default mode.",
          );
          return { action: input.action, ...(yield* service.create(input.name)) };
        }
        case "move_thread": {
          if (input.groupId === undefined)
            return yield* missing("move_thread needs groupId: a group id, or null for Active.");
          const { projection } = yield* readWritableThread(input.threadId);
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
});
