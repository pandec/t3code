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
    // A numberless window still has to paint: a zero-length arc would leave
    // the ring visually identical to "no quota data at all".
    expect(markup).toContain('stroke-dashoffset="0"');
    expect(markup).toContain("var(--color-warning)");
  });

  it("keeps the quota ring on the session window and renders Fable as a centre pie", () => {
    const sessionWindow = {
      id: "session",
      group: "session" as const,
      label: "Session (5h)",
      shortLabel: "5h",
      usedPercent: 3,
      resetsAt: null,
      status: "ok" as const,
    };
    const fableWindow = {
      id: "seven_day_fable",
      group: "weekly" as const,
      label: "Weekly (Fable)",
      shortLabel: "Fable",
      usedPercent: 100,
      resetsAt: null,
      status: "critical" as const,
    };
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={null}
        providerUsage={{
          providerLabel: "Claude",
          providerInstanceId: "claudeAgent",
          windows: [sessionWindow, fableWindow],
          status: "critical",
          constrainedWindow: fableWindow,
          updatedAt: "2026-07-27T05:00:00.000Z",
        }}
        fableUsage={fableWindow}
        fableAccountName="fable-next.json"
      />,
    );

    expect(markup).toContain(
      'r="6" fill="none" stroke="color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)"',
    );
    expect(markup).toContain('r="2.5" fill="var(--color-destructive)"');
    expect(markup).toContain("Weekly Fable on fable-next.json at 100%");
  });

  it("renders a known context window at zero usage", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={{
          usedTokens: 0,
          maxTokens: 200_000,
          usedPercentage: 0,
          remainingTokens: 200_000,
          remainingPercentage: 100,
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
      />,
    );

    expect(markup).toContain('aria-label="Context window 0% used"');
    expect(markup).toContain('stroke-dashoffset="64.40264939859075"');
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
