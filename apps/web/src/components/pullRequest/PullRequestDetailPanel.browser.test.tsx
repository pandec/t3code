import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type PullRequestDetailView,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useRightPanelStore } from "~/rightPanelStore";

import "~/index.css";
import { act, render as renderUi } from "../../../test/render";

const {
  newThread,
  prepareThread,
  refresh,
  copied,
  update,
  addToast,
  updateToast,
  checkoutState,
  hostCommand,
  queries,
} = vi.hoisted(() => ({
  hostCommand: vi.fn(),
  queries: { diff: undefined as unknown },
  newThread: vi.fn(),
  prepareThread: vi.fn(),
  refresh: vi.fn(),
  copied: vi.fn(),
  update: vi.fn(),
  addToast: vi.fn(),
  updateToast: vi.fn(),
  checkoutState: { error: null as Error | null },
}));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => undefined) as never,
}));
vi.mock(import("~/hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  useCopyToClipboard: (() => ({ copyToClipboard: copied, isCopied: false })) as never,
}));
vi.mock(import("~/hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => newThread) as never,
}));
vi.mock(import("~/state/sourceControlActions"), async (original) => ({
  ...(await original()),
  usePreparePullRequestThreadAction: (() => ({
    run: prepareThread,
    isAllowed: true,
    error: checkoutState.error,
  })) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => (command === "update" ? update : hostCommand)) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const cannotWriteGuides = Atom.make(false);
  const diff = Atom.make(null);
  queries.diff = diff;
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      detail: (() => "detail") as never,
      diff: (() => diff) as never,
      activity: (() => "activity") as never,
      update: "update" as never,
      reviewGuide: (() => "review-guide") as never,
      generateReviewGuide: {
        ...actual.pullRequestEnvironment.generateReviewGuide,
        permissionAtom: () => cannotWriteGuides,
      },
    },
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((query: unknown) => ({
    data:
      query === "detail"
        ? (activityDetail ?? currentDetail)
        : query === "activity"
          ? activityDetail
          : query === queries.diff
            ? diff
            : null,
    dataUpdatedAt: 0,
    failure: null,
    isPending: false,
    isSuccess: true,
    error: null,
    refresh,
  })) as never,
}));
vi.mock(import("~/state/usePullRequestStack"), async (original) => ({
  ...(await original()),
  usePullRequestStack: (() => ({
    data: null,
    isSuccess: true,
    isPending: false,
    error: null,
    refresh,
  })) as never,
}));
// Action and scroll tests use stand-ins; activity tests render the real Summary.
vi.mock(import("./PullRequestSummaryTab"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    PullRequestSummaryTab: ((props: ComponentProps<typeof actual.PullRequestSummaryTab>) => {
      if (activityDetail !== null) return <actual.PullRequestSummaryTab {...props} />;
      const { onFixFinding, scrollerRef } = props;
      return (
        <div ref={scrollerRef} data-testid="summary-scroller" className="h-full overflow-y-auto">
          <button
            type="button"
            onClick={() =>
              onFixFinding?.({
                kind: "check",
                check: {
                  name: "Unit tests",
                  status: "failure",
                  description: "Test failed",
                  url: null,
                },
              })
            }
          >
            Fix check
          </button>
          <div data-testid="nested-scroller" className="h-40 overflow-y-auto">
            <div className="h-[2000px]" />
          </div>
          <div className="h-[3000px]" />
        </div>
      );
    }) as never,
  };
});
// The Code tab waits for the diff worker pool, and a cold pool starts real Shiki workers that
// a loaded runner can keep past Pierre's 10s startup limit. These tests are about the panel,
// so the pool falls back to main-thread highlighting at once.
vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({
  default: function UnavailableDiffsWorker() {
    throw new Error("Diff workers are disabled in panel tests");
  },
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: addToast, update: updateToast } as never,
  };
});

import { PullRequestDetailPanel } from "./PullRequestDetailPanel";
import { ThreadPaneContext } from "../thread-split/threadPaneContext";
import { useThreadSplitStore } from "../thread-split/threadSplitStore";
import { usePullRequestReviewStore } from "./pullRequestReviewStore";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "Original description",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "conflicting",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "Unit tests", status: "success", description: null, url: null }],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: false,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

let currentDetail = detail;
let activityDetail: PullRequestDetailView | null = null;

// Enough lines to exercise the panel's title folding with the real virtualized Code tab.
const diff = {
  patch: [
    "diff --git a/a.ts b/a.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/a.ts",
    "@@ -0,0 +1,100 @@",
    "+broken()",
    ...Array.from({ length: 99 }, (_, index) => `+// line ${index + 2}`),
    "",
  ].join("\n"),
  truncated: false,
  nextCursor: null,
};

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const newDraftId = DraftId.make("new-draft");
const shortcutContext = () => ({
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
});

function panelContainer() {
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  return container;
}

// The mocked modules and stores are shared by the whole file, so every test starts by
// resetting them.
function setup() {
  activityDetail = null;
  currentDetail = detail;
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
  usePullRequestReviewStore.setState({ drafts: {}, summaries: {} });
  hostCommand.mockReset();
  newThread
    .mockReset()
    .mockResolvedValue({ draftId: newDraftId, threadId: ThreadId.make("new-thread") });
  addToast.mockReset().mockReturnValue("checkout-toast");
  updateToast.mockReset();
  checkoutState.error = null;
  prepareThread.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { branch: "feature", worktreePath: "/workspace/pr" },
  });
  update.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
}

describe("copy PR number shortcut in split view", () => {
  it("copies only the active pane's PR", async () => {
    setup();
    copied.mockReset();
    const initialSplit = useThreadSplitStore.getState();
    useThreadSplitStore.setState({ splitMounted: true, activePaneId: "secondary" });
    const panel = (number: number) => (
      <PullRequestDetailPanel
        environmentId={threadRef.environmentId}
        reference={{ ...detail, number }}
        context="page"
        shortcutsEnabled
        getShortcutContext={shortcutContext}
      />
    );
    try {
      await using _screen = await renderUi(
        <>
          <ThreadPaneContext value="primary">{panel(1)}</ThreadPaneContext>
          <ThreadPaneContext value="secondary">{panel(2)}</ThreadPaneContext>
        </>,
        { container: panelContainer() },
      );
      // The panel's own Mod+Shift+K; every mounted panel hears the same window event.
      const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
      const press = () =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "k",
            code: "KeyK",
            metaKey: isMac,
            ctrlKey: !isMac,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );

      press();
      expect(copied.mock.calls).toEqual([["#2", "PR number"]]);

      copied.mockReset();
      await act(async () => useThreadSplitStore.setState({ activePaneId: "primary" }));
      press();
      expect(copied.mock.calls).toEqual([["#1", "PR number"]]);
    } finally {
      useThreadSplitStore.setState(initialSplit, true);
    }
  });
});
