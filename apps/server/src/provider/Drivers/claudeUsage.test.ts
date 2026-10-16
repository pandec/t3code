import { describe, expect, it } from "@effect/vitest";

import { parseClaudeLine } from "./claudeUsage.ts";

function claudeLine(overrides: {
  messageId: string;
  contentType: string;
  model?: string;
  outputTokens?: number;
  speed?: string;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-07T04:05:13.944Z",
    sessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
    cwd: "/home/theo/project",
    message: {
      id: overrides.messageId,
      role: "assistant",
      model: overrides.model ?? "claude-fable-5",
      content: [{ type: overrides.contentType }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 66818,
        cache_read_input_tokens: 1000,
        output_tokens: overrides.outputTokens ?? 286,
        ...(overrides.speed === undefined ? {} : { speed: overrides.speed }),
      },
    },
  });
}

describe("parseClaudeLine", () => {
  it("extracts token totals and a dedupe key", () => {
    const record = parseClaudeLine(claudeLine({ messageId: "msg_1", contentType: "text" }));

    expect(record).not.toBeNull();
    expect(record?.provider).toBe("claude");
    expect(record?.model).toBe("claude-fable-5");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 66818,
      outputTokens: 286,
      reasoningTokens: 0,
    });
    expect(record?.dedupeKey).toBe("msg_1:");
    expect(record?.speed).toBe("standard");
  });

  it("marks fast-mode requests", () => {
    const line = (speed: string) =>
      parseClaudeLine(claudeLine({ messageId: "msg_1", contentType: "text", speed }));

    expect(line("fast")?.speed).toBe("fast");
    expect(line("standard")?.speed).toBe("standard");
  });

  it("gives every content block of one message the same dedupe key", () => {
    // Claude Code writes one record per content block, each repeating the
    // parent message's usage. Summing them would overcount ~2.4x on real data.
    const text = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "text" }));
    const toolUse = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "tool_use" }));

    expect(text?.dedupeKey).toBe(toolUse?.dedupeKey);
    expect(text?.totals).toEqual(toolUse?.totals);
  });

  it("marks a proxied stream's placeholder usage provisional and counts it as cache reads", () => {
    // CLIProxyAPI reports Codex usage only at completion. Claude Code writes
    // the earlier blocks with its own prompt estimate and no cache fields.
    const line = (usage: Record<string, number>) =>
      parseClaudeLine(
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-10-10T12:00:00.000Z",
          sessionId: "s",
          message: { id: "resp_084e", model: "gpt-6.1-sol", usage },
        }),
      );

    const placeholder = line({ input_tokens: 37610, output_tokens: 0 });
    expect(placeholder?.provisional).toBe(true);
    expect(placeholder?.totals).toMatchObject({
      uncachedInputTokens: 0,
      cachedInputTokens: 37610,
      outputTokens: 0,
    });

    const final = line({
      input_tokens: 3010,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 90112,
      output_tokens: 312,
    });
    expect(final?.provisional).toBeUndefined();
    expect(final?.dedupeKey).toBe(placeholder?.dedupeKey);
    expect(final?.totals).toMatchObject({ uncachedInputTokens: 3010, cachedInputTokens: 90112 });

    // A backend that never reports cache fields still reports output.
    expect(line({ input_tokens: 500, output_tokens: 20 })?.provisional).toBeUndefined();
  });

  it("reads thinking tokens and one-hour cache writes", () => {
    const record = parseClaudeLine(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-10-10T12:00:00.000Z",
        message: {
          id: "msg_3",
          model: "claude-opus-5-5",
          usage: {
            input_tokens: 4,
            cache_creation_input_tokens: 6927,
            cache_read_input_tokens: 222513,
            cache_creation: { ephemeral_5m_input_tokens: 927, ephemeral_1h_input_tokens: 6000 },
            output_tokens: 526,
            output_tokens_details: { thinking_tokens: 106 },
          },
        },
      }),
    );

    expect(record?.totals.reasoningTokens).toBe(106);
    expect(record?.oneHourCacheCreationTokens).toBe(6000);
    expect(parseClaudeLine(claudeLine({ messageId: "m", contentType: "text" }))).not.toHaveProperty(
      "oneHourCacheCreationTokens",
    );
  });

  it("ignores records that are not assistant messages", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "user", message: {} }))).toBeNull();
    expect(parseClaudeLine("not json")).toBeNull();
  });
});
