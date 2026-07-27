import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ContextWindowMeter } from "./ContextWindowMeter";

describe("ContextWindowMeter", () => {
  it("names a quota-only numberless warning and renders its details", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={null}
        providerUsage={{
          providerLabel: "Claude",
          providerInstanceId: "claudeAgent",
          windows: [
            {
              id: "five_hour",
              group: "session",
              label: "Session (5h)",
              shortLabel: "5h",
              usedPercent: null,
              resetsAt: null,
              status: "warning",
            },
          ],
          status: "warning",
          constrainedWindow: {
            id: "five_hour",
            group: "session",
            label: "Session (5h)",
            shortLabel: "5h",
            usedPercent: null,
            resetsAt: null,
            status: "warning",
          },
          updatedAt: "2026-07-27T05:00:00.000Z",
        }}
      />,
    );

    expect(markup).toContain('aria-label="Claude Session (5h) limit warning"');
    expect(markup.match(/<circle/g)).toHaveLength(2);
  });

  it("still renders with only context-window usage", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={{
          usedTokens: 50_000,
          maxTokens: 200_000,
          usedPercentage: 25,
          remainingTokens: 150_000,
          remainingPercentage: 75,
          totalProcessedTokens: null,
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          reasoningOutputTokens: null,
          lastUsedTokens: null,
          lastInputTokens: null,
          lastCachedInputTokens: null,
          lastOutputTokens: null,
          lastReasoningOutputTokens: null,
          toolUses: null,
          durationMs: null,
          compactsAutomatically: true,
          updatedAt: "2026-07-27T05:00:00.000Z",
        }}
        providerUsage={null}
        providerDisplayName="Claude"
      />,
    );

    expect(markup).toContain('aria-label="Context window 25% used"');
    expect(markup.match(/<circle/g)).toHaveLength(2);
  });
});
