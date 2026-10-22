import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type OrchestrationV2SearchThreadInput } from "@t3tools/contracts";
import { act, render } from "../../../test/render";
import { useThreadFind } from "./useThreadFind";
import { requestThreadFindOpen } from "./threadFindActionBus";
import { ThreadPaneContext } from "../thread-split/threadPaneContext";
import { type ThreadPaneId, useThreadSplitStore } from "../thread-split/threadSplitStore";

vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: {
    threadFindProgressive: vi.fn(
      (input: { environmentId: EnvironmentId; input: OrchestrationV2SearchThreadInput }) => input,
    ),
    threadFind: vi.fn(
      (input: { environmentId: EnvironmentId; input: OrchestrationV2SearchThreadInput }) => input,
    ),
  },
}));
vi.mock("~/state/queries", () => ({ useDebouncedValue: <T,>(value: T) => value }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, isPending: false, error: null, refresh: vi.fn() }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

const threadId = ThreadId.make("shared-thread");

// Fork: the open event is window-wide, so split panes must not both react.
describe("split pane find", () => {
  it("opens only the targeted pane, or the active one when untargeted", async () => {
    const open = new Map<ThreadPaneId, boolean>();
    function PaneProbe({ paneId }: { paneId: ThreadPaneId }) {
      const state = useThreadFind({
        thread: {
          environmentId: EnvironmentId.make(`environment:${paneId}`),
          threadId,
        },
        enabled: true,
        content: undefined,
      });
      useLayoutEffect(() => {
        open.set(paneId, state.isOpen);
      });
      return null;
    }
    useThreadSplitStore.setState({ splitMounted: true, activePaneId: "secondary" });
    await using _split = {
      [Symbol.asyncDispose]: async () =>
        useThreadSplitStore.setState({ splitMounted: false, activePaneId: "primary" }),
    };
    await using _screen = await render(
      <>
        <ThreadPaneContext value="primary">
          <PaneProbe paneId="primary" />
        </ThreadPaneContext>
        <ThreadPaneContext value="secondary">
          <PaneProbe paneId="secondary" />
        </ThreadPaneContext>
      </>,
      { router: false },
    );
    await act(() => requestThreadFindOpen());
    expect(open.get("primary")).toBe(false);
    expect(open.get("secondary")).toBe(true);
    await act(() => requestThreadFindOpen("primary"));
    expect(open.get("primary")).toBe(true);
  });
});
