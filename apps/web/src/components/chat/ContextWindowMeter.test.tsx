import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { formatProviderUsageEmail } from "~/providerUsageEmail";
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

  it("colours the ring by the worst window, not just the featured one", () => {
    const criticalWindow = {
      id: "session",
      group: "session" as const,
      label: "Session (5h)",
      shortLabel: "5h",
      usedPercent: 97,
      resetsAt: null,
      status: "critical" as const,
    };
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={null}
        providerUsage={{
          providerLabel: "Claude",
          providerInstanceId: "claudeAgent",
          windows: [
            criticalWindow,
            {
              id: "weekly_scoped:Fable",
              group: "weekly",
              label: "Weekly (Fable)",
              shortLabel: "Fable",
              usedPercent: 85,
              resetsAt: null,
              status: "warning",
            },
          ],
          status: "critical",
          // A snapshot whose featured window is milder than its worst window
          // must still read as critical on the ring.
          constrainedWindow: {
            id: "weekly_scoped:Fable",
            group: "weekly",
            label: "Weekly (Fable)",
            shortLabel: "Fable",
            usedPercent: 85,
            resetsAt: null,
            status: "warning",
          },
          updatedAt: "2026-07-27T05:00:00.000Z",
        }}
      />,
    );

    expect(markup).toContain("var(--color-destructive)");
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

  it("shows provider emails by default and masks them when requested", () => {
    expect(formatProviderUsageEmail("bartosz@gmail.com")).toBe("bartosz@gmail.com");
    expect(formatProviderUsageEmail("bartosz@gmail.com", true)).toBe("b•••@gmail.com");
  });
});
