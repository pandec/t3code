import {
  OrchestratorMcpFailure,
  TelegramDispatchError,
  TelegramDispatchInput,
  TelegramDispatchResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { TelegramService } from "../../../telegram/TelegramService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const TelegramSendTool = Tool.make("telegram_send", {
  description:
    "Send a dispatch to the user's Telegram. Use it only when the user asks to send or deliver something to Telegram, in this message or as a standing request. `summary` is a skimmable markdown digest that leads with the answer: short bullets, about 1,500 characters ideal. `report` is an optional full markdown write-up; tables are fine and long text is split automatically. `audioScript` is an optional spoken version written for the ear: conversational, no markdown, code or URLs, 1 to 10 minutes long. Everything lands in this thread's own Telegram topic, and the user's replies there come back to this thread as new messages.",
  parameters: TelegramDispatchInput,
  success: TelegramDispatchResult,
  failure: Schema.Union([TelegramDispatchError, OrchestratorMcpFailure]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    TelegramService,
  ],
})
  .annotate(Tool.Title, "Send to Telegram")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const TelegramToolkit = Toolkit.make(TelegramSendTool);
