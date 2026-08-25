import {
  AgentVoiceReplyError,
  AgentVoiceReplyInput,
  AgentVoiceReplyResult,
  PreviewAutomationUnavailableError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { AgentVoiceReply } from "../../../voice/AgentVoiceReply.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const VoiceReplyTool = Tool.make("voice_reply", {
  description:
    "Deliver your reply for this turn as a spoken recording. Use it only when the user asked to hear the answer (in this message or as a standing request for the conversation) — not as a default for every turn; when in doubt, reply in text. The audio is generated from your script and attached to your final message, where the user hears it as the primary form of your reply (your written text stays available behind a toggle). Write the script for the ear, not the eye: conversational tone, short sentences, no markdown, no code, no URLs or file paths — describe such things in words instead. Still write your normal text reply after calling this. Call it shortly before you finish; calling it again in the same turn appends another segment, and the segments play in call order as one recording. The recording is published only when the turn completes normally.",
  parameters: AgentVoiceReplyInput,
  success: AgentVoiceReplyResult,
  failure: Schema.Union([AgentVoiceReplyError, PreviewAutomationUnavailableError]),
  dependencies: [McpInvocationContext.McpInvocationContext, AgentVoiceReply],
})
  .annotate(Tool.Title, "Reply with a voice recording")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const VoiceToolkit = Toolkit.make(VoiceReplyTool);
