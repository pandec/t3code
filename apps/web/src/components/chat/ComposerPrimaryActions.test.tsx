import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const stageArtworkState = vi.hoisted(() => ({
  mode: "none" as "artwork" | "none",
  variant: null as "nightly" | "dev" | null,
}));

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => stageArtworkState.mode,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: ({ variant }: { variant: string }) => `stage-${variant}`,
  useSidebarStageBackdropVariant: (enabled = true) => (enabled ? stageArtworkState.variant : null),
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

const baseProps = {
  compact: false,
  pendingAction: null,
  showPlanFollowUpPrompt: false,
  promptHasText: true,
  isSendBusy: false,
  sendDisabledReason: null,
  isConnecting: false,
  isEnvironmentUnavailable: false,
  isPreparingWorktree: false,
  hasSendableContent: true,
  onPreviousPendingQuestion: () => {},
  onInterrupt: () => {},
  onQueue: () => {},
  onImplementPlanInNewThread: () => {},
};

describe("ComposerPrimaryActions running-turn actions", () => {
  it("puts steering on the form's submit path and queueing beside it", () => {
    // Submitting steers, so the steer action carries the submit button and
    // Enter takes the identical path. "Queue for later" has to be a plain
    // button with its own handler — a `type="submit"` there would silently
    // turn every Enter into a queue again.
    const markup = renderToStaticMarkup(
      <form>
        <ComposerPrimaryActions {...baseProps} isRunning />
      </form>,
    );

    expect(markup).toContain("Queue for later");
    expect(markup).toContain("Steer");
    // Exactly one submit button, and it is the steer action.
    expect(markup.match(/type="submit"/g)).toHaveLength(1);
    const queueIndex = markup.indexOf("Queue for later");
    const submitIndex = markup.indexOf('type="submit"');
    expect(submitIndex).toBeGreaterThan(queueIndex);
  });

  it("keeps the idle send button on the form's submit path", () => {
    const markup = renderToStaticMarkup(
      <form>
        <ComposerPrimaryActions {...baseProps} isRunning={false} />
      </form>,
    );

    expect(markup).toContain('aria-label="Send message"');
    expect(markup).toContain('type="submit"');
  });
});

function renderPendingActions(isRunning: boolean) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
      isRunning,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onQueue: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderSendButton(sendDisabledReason: string | null = null) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: false,
      showPlanFollowUpPrompt: false,
      promptHasText: true,
      isSendBusy: false,
      sendDisabledReason,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: true,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onQueue: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

afterEach(() => {
  stageArtworkState.mode = "none";
  stageArtworkState.variant = null;
});

describe("ComposerPrimaryActions", () => {
  it("disables and labels the send button while feedback is uploading", () => {
    const markup = renderSendButton("Sending feedback");

    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-label="Sending feedback"');
  });

  it("offers Stop generation while a running turn is waiting for user input", () => {
    expect(renderPendingActions(true)).toContain('aria-label="Stop generation"');
  });

  it("does not offer Stop generation for a pending request without a running turn", () => {
    expect(renderPendingActions(false)).not.toContain('aria-label="Stop generation"');
  });

  it("renders stage artwork inside the send button when artwork identification is active", () => {
    stageArtworkState.mode = "artwork";
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).toContain("stage-nightly");
  });

  it("hides stage artwork when artwork identification is inactive", () => {
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).not.toContain("stage-nightly");
  });
});
