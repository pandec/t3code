import * as Effect from "effect/Effect";

import { TelegramService } from "../../../telegram/TelegramService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { TelegramToolkit } from "./tools.ts";

export const TelegramToolkitHandlersLive = McpToolAccess.toLayer(TelegramToolkit, {
  // Dispatches go to the calling thread's own topic, so only thread callers get them.
  telegram_send: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "telegram_send");
      const telegram = yield* TelegramService;
      return yield* telegram.dispatch({ ...input, threadId: thread.threadId });
    }),
  ),
});
