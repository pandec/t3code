import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

const baseProps = {
  compact: false,
  pendingAction: null,
  showPlanFollowUpPrompt: false,
  promptHasText: true,
  isSendBusy: false,
  isConnecting: false,
  isEnvironmentUnavailable: false,
  isPreparingWorktree: false,
  hasSendableContent: true,
  onPreviousPendingQuestion: () => {},
  onInterrupt: () => {},
  onQueue: () => {},
  onImplementPlanInNewThread: () => {},
};

describe("ComposerPrimaryActions", () => {
  it("keeps the running-turn queue action off the form's submit path", () => {
    // Submitting steers by default, so "Queue for later" has to be a plain
    // button with its own handler — a `type="submit"` here would silently turn
    // every Enter into a queue again.
    const markup = renderToStaticMarkup(
      <form>
        <ComposerPrimaryActions {...baseProps} isRunning />
      </form>,
    );

    expect(markup).toContain("Queue for later");
    expect(markup).not.toContain('type="submit"');
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
