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
