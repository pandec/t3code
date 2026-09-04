import { EventId, TurnId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveLatestContextWindowSnapshot, type ContextWindowSnapshot } from "~/lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ closeDelay, render }: { closeDelay: number; render: ReactNode }) => (
    <div data-close-delay={closeDelay}>{render}</div>
  ),
}));

const compactUsage = deriveLatestContextWindowSnapshot([
  {
    id: EventId.make("activity-1"),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context updated",
    payload: { usedTokens: 100_000, maxTokens: 1_000_000 },
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-08-24T12:00:00.000Z",
  },
]);

if (!compactUsage) {
  throw new Error("The context window test fixture did not produce a snapshot.");
}

function contextUsage(usedTokens: number, usedPercentage: number): ContextWindowSnapshot {
  const maxTokens = 200_000;
  return {
    usedTokens,
    maxTokens,
    usedPercentage,
    remainingTokens: maxTokens - usedTokens,
    remainingPercentage: 100 - usedPercentage,
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
  };
}

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
          updatedAt: "2026-07-27T05:00:00.000Z",
        }}
        fableUsage={fableWindow}
        fableAccountName="fable-next.json"
      />,
    );

    // An exhausted Fable must colour its own pie and leave the outer ring
    // calm: repainting the ring for it is the hijacking this design removed.
    expect(markup).toContain(
      'r="6" fill="none" stroke="color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)"',
    );
    expect(markup).toContain('r="2.5" fill="var(--color-destructive)"');
    expect(markup).toContain("Claude Session (5h) at 3%");
    expect(markup).toContain("Weekly Fable on fable-next.json at 100%");
  });

  it("colours the ring for an exhausted window that has no sub-ring of its own", () => {
    const sessionWindow = {
      id: "session",
      label: "Session (5h)",
      shortLabel: "Session",
      group: "session" as const,
      usedPercent: 3,
      resetsAt: null,
      status: "ok" as const,
    };
    // A spent weekly is not covered by the Fable pie, so the ring is its only
    // passive signal.
    const weeklyWindow = {
      id: "seven_day",
      label: "Weekly (all models)",
      shortLabel: "Weekly",
      group: "weekly" as const,
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
          windows: [sessionWindow, weeklyWindow],
          status: "critical",
          updatedAt: "2026-07-27T05:00:00.000Z",
        }}
      />,
    );

    expect(markup).toContain('r="6" fill="none" stroke="var(--color-destructive)"');
    expect(markup).toContain("Claude Session (5h) at 3%");
  });

  it("renders a visible and accessible OpenRouter-only indicator", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={null}
        openRouterCredits={{
          configured: true,
          balanceUsd: 12.34,
          observedAt: Date.now(),
          error: null,
          unavailable: false,
        }}
      />,
    );

    expect(markup).toContain('aria-label="OpenRouter credits $12.34 left"');
    expect(markup).toContain('data-testid="openrouter-credits-indicator"');
  });

  it("renders a known context window at zero usage", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter usage={contextUsage(0, 0)} providerUsage={null} />,
    );

    expect(markup).toContain('aria-label="Context window 0% used"');
  });

  it("still renders with only context-window usage", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={contextUsage(50_000, 25)}
        providerUsage={null}
        modelDisplayName="Claude"
      />,
    );

    expect(markup).toContain('aria-label="Context window 25% used"');
    expect(markup.match(/<circle/g)).toHaveLength(2);
  });

  it("keeps the hover popover open while the pointer moves to the compact button", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter usage={compactUsage} onCompact={() => {}} />,
    );

    expect(markup).toContain('data-close-delay="150"');
    expect(markup).toContain("Compact context");
  });

  it("closes an informational hover popover without delay", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={compactUsage} />);

    expect(markup).toContain('data-close-delay="0"');
    expect(markup).not.toContain("Compact context");
  });

  it("explains why the compact action is disabled", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={compactUsage}
        onCompact={() => {}}
        compactDisabled
        compactDisabledReason="Send or clear your draft before compacting"
      />,
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain(">Send or clear your draft before compacting<");
    expect(markup).not.toContain('aria-label="Send or clear your draft before compacting"');
  });
});
