import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Fork: the `telegram_send` MCP tool. Everything lands in the calling thread's own topic. */
export const TELEGRAM_SUMMARY_MAX_CHARS = 4_000;
export const TELEGRAM_REPORT_MAX_CHARS = 200_000;
export const TELEGRAM_AUDIO_SCRIPT_MAX_CHARS = 20_000;
export const TELEGRAM_TOPIC_TITLE_MAX_CHARS = 128;

export const TelegramDispatchInput = Schema.Struct({
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(TELEGRAM_SUMMARY_MAX_CHARS)).annotate({
    description:
      "Skimmable markdown digest that leads with the answer: short bullets, about 1,500 characters ideal.",
  }),
  report: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(TELEGRAM_REPORT_MAX_CHARS)).annotate({
      description: "Optional full markdown write-up. Tables are fine; long text is split.",
    }),
  ),
  audioScript: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(TELEGRAM_AUDIO_SCRIPT_MAX_CHARS)).annotate({
      description:
        "Optional spoken version written for the ear: conversational, no markdown, code or URLs.",
    }),
  ),
  title: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(TELEGRAM_TOPIC_TITLE_MAX_CHARS)).annotate({
      description: "Topic title override. Defaults to the thread title.",
    }),
  ),
});
export type TelegramDispatchInput = typeof TelegramDispatchInput.Type;

export const TelegramDispatchResult = Schema.Struct({
  topic: Schema.String,
  reportParts: NonNegativeInt,
  audioSeconds: Schema.NullOr(Schema.Number),
});
export type TelegramDispatchResult = typeof TelegramDispatchResult.Type;

export class TelegramDispatchError extends Schema.TaggedError<TelegramDispatchError>()(
  "TelegramDispatchError",
  {
    reason: Schema.Literals(["not_configured", "not_linked", "telegram_failed", "speech_failed"]),
    detail: Schema.String,
  },
) {
  /** The tool error text the agent sees, so it can tell the user what went wrong. */
  override get message(): string {
    switch (this.reason) {
      case "not_configured":
        return "Telegram is not configured on this server. Ask the user to add a bot token in Settings → Integrations → Telegram.";
      case "not_linked":
        return "The Telegram bot is not linked to a chat yet. Ask the user to press Link chat in Settings → Integrations → Telegram.";
      case "telegram_failed":
        return `Telegram rejected the dispatch: ${this.detail}`;
      case "speech_failed":
        return `The voice note failed: ${this.detail}`;
    }
  }
}
