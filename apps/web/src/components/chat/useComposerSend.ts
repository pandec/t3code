import {
  mergeDirectPreviewAnnotation,
  resolveBackgroundDraftWorkspaceOptions,
  shouldDockDraftHeroForSubmission,
  restorePlanFollowUpComposer,
  buildExpiredTerminalContextToastCopy,
  deriveComposerSendState,
  revokeUserMessagePreviewUrls,
  boundAttachmentIds,
  formatOutgoingPrompt,
  optimisticMessageAttachments,
  planComposerTurn,
  sendTitleFallbackLabels,
  snapshotComposerSend,
  withMessageContext,
  makeThreadErrorSetter,
  hasStandaloneComposerCommandContext,
  resolveDraftCreationGroup,
} from "../ChatView.logic";
import { isUsageLimitsCommand } from "@t3tools/shared/usageLimits";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_MODEL,
  type EnvironmentId,
  type ModelSelection,
  type PreviewAnnotationPayload,
  type ThreadId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { wasBootstrapThreadDeleted } from "@t3tools/client-runtime/errors";
import {
  declinePendingApprovals,
  sendApprovalFeedback,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";
import { type SetStateAction, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  type ComposerSubmissionIntent,
  collapseExpandedComposerCursor,
  parseComposerArchiveCommand,
  parseStandaloneComposerSlashCommand,
} from "../../composer-logic";
import { hasPendingArchive } from "@t3tools/client-runtime/state/thread-settled";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useThreadGroupCatalog } from "../../hooks/useThreadGroups";
import { useKeepFullHistoryOverrideStore } from "../../keepFullHistoryOverrideStore";
import { draftSubmissionTracker } from "../../draftSubmissionState";
import {
  enqueueThreadSubmission,
  hasPendingThreadSubmission,
  settleClaimedThreadSubmission,
  useThreadOutboxStore,
  type PendingThreadSubmission,
} from "../../state/threadOutbox";
import { labsEnvironment, readLabsSnapshot } from "~/state/labs";
import {
  resolveLabBranchRequest,
  resolveLabPurpose,
  resolveLabSendTarget,
} from "../labs/labs.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import type { QueuedRunsControlHandle } from "./QueuedRunsControl";
import { resolvePlanFollowUpSubmission } from "../../proposedPlan";
import { type ChatMessage } from "../../types";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { newCommandId, newMessageId, newThreadId } from "~/lib/utils";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  beginBackgroundDraftSubmissionByRef,
  clearBackgroundDraftSubmissionByRef,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  restoreFailedDraftThread,
  composerDraftHasUserContent,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  DEFAULT_DRAFT_LAB_INTENT,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  DraftId,
} from "../../composerDraftStore";
import { type TerminalContextDraft } from "../../lib/terminalContext";
import { ensureInlineContextReferences } from "../../lib/composerContextReferences";
import {
  buildMessageContext,
  previewAnnotationContextReference,
} from "../../lib/composerContextRecords";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { runMobileComposerTransition } from "./draftHeroTransition";
import {
  useClientSettingsHydrated,
  useEnvironmentSettings,
  useSteerGraceWindowMs,
} from "../../hooks/useSettings";
import { environmentPresentations } from "../../state/presentation";
import {
  approvalRedirectNotice,
  loadBalancingSendWarning,
  multipleModelSendBlock,
  referencedThreadContexts,
} from "./composerSend.logic";
import { usePlanFollowUpSend } from "./useProposedPlanSend";
import { useMultipleModelSend } from "./useMultipleModelSend";
import { type ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseDraftAttachments,
  retryAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import { readEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  threadContextsOutsideEnvironment,
} from "@t3tools/shared/composerContextReferences";
import {
  draftSendState,
  type MultipleModelTarget,
  resolveMultipleModelTargets,
  prepareTurnAttachments,
  restoreComposerDraft,
} from "./chatViewSend";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { UnifiedSettings } from "@t3tools/contracts";
import type { Dispatch } from "react";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { SessionPhase } from "../../types";
import type { DraftSessionState } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import type { LatestProposedPlanState } from "../../session-logic";
import type { useDraftEnvironmentRouting } from "./useDraftEnvironmentRouting";
import type { useLocalDispatchState } from "./useLocalDispatchState";
import type { usePendingThreadRequests } from "./usePendingThreadRequests";
import type { useQueuedRunEdit } from "./useQueuedRunEdit";
import type { useTimelineFollow } from "./useTimelineFollow";
import type { useUsageLimitsPanel } from "./useUsageLimitsPanel";
import type { useWorktreeSetup } from "./useWorktreeSetup";

const ENVIRONMENT_UNAVAILABLE_SEND_TOAST_TRAIL_SIZE = 3;

const selectPlanModeEnabled = (settings: UnifiedSettings) => settings.planModeEnabled;

function readEnvironmentPresentation(environmentId: EnvironmentId) {
  return appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId);
}

function draftHasNonPromptContent(target: ComposerThreadTarget) {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  return draft ? composerDraftHasUserContent({ ...draft, prompt: "" }) : false;
}

type PendingThreadRequests = ReturnType<typeof usePendingThreadRequests>;
type LocalDispatchState = ReturnType<typeof useLocalDispatchState>;
type DraftEnvironmentRouting = ReturnType<typeof useDraftEnvironmentRouting>;
type UsageLimitsPanel = ReturnType<typeof useUsageLimitsPanel>;
type TimelineFollow = ReturnType<typeof useTimelineFollow>;

interface ComposerSendInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadKey: string | null;
  readonly activeThreadBranch: string | null;
  readonly activeProject: EnvironmentProject | null;
  readonly activeProjectDefaultModelSelection: ModelSelection | null;
  readonly activeProposedPlan: LatestProposedPlanState | null;
  readonly activeMessageCount: number;
  readonly isServerThread: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isGitRepo: boolean;
  readonly phase: SessionPhase;
  readonly runtimeMode: RuntimeMode;
  readonly sendEnvMode: DraftThreadEnvMode;
  readonly startFromOrigin: boolean;
  readonly localCheckoutBranchMismatch: {
    readonly threadBranch: string;
    readonly currentBranch: string;
  } | null;
  readonly logicalProjectEnvironments: ReturnType<typeof useLogicalProjectEnvironments>;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly promptRef: { current: string };
  readonly composerImagesRef: { current: ComposerImageAttachment[] };
  readonly composerFilesRef: { current: ComposerFileAttachment[] };
  readonly composerTerminalContextsRef: { current: TerminalContextDraft[] };
  readonly feedbackUploadsInFlightRef: { readonly current: Set<string> };
  readonly queuedRunEdit: ReturnType<typeof useQueuedRunEdit>;
  readonly queuedRunsControlRef: { readonly current: QueuedRunsControlHandle | null };
  readonly isConnecting: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly threadDetailLoading: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly isSendBusy: boolean;
  readonly sendQueuesBehindSetup: boolean;
  readonly isDraftHeroState: boolean;
  readonly panelAnimationsActive: boolean;
  readonly panelAnimationDurationMs: number;
  readonly keepFullHistory: boolean;
  readonly resumeCompactionTokens: number | null;
  readonly showPlanFollowUpPrompt: boolean;
  readonly usageLimitsKey: string | null;
  readonly usageLimitsOffered: boolean;
  readonly openUsageLimits: UsageLimitsPanel["open"];
  readonly clearUsageLimitsFor: UsageLimitsPanel["clearFor"];
  readonly needsLoadBalancing: boolean;
  readonly loadBalancing: DraftEnvironmentRouting["loadBalancing"];
  readonly readPendingEnvironmentChange: DraftEnvironmentRouting["readPendingEnvironmentChange"];
  readonly pendingApprovals: PendingThreadRequests["pendingApprovals"];
  readonly respondingRequestIds: PendingThreadRequests["respondingRequestIds"];
  readonly activePendingProgress: PendingThreadRequests["activePendingProgress"];
  readonly onAdvanceActivePendingUserInput: PendingThreadRequests["onAdvanceActivePendingUserInput"];
  readonly onRespondToApproval: PendingThreadRequests["onRespondToApproval"];
  readonly beginLocalDispatch: LocalDispatchState["beginLocalDispatch"];
  readonly resetLocalDispatch: LocalDispatchState["resetLocalDispatch"];
  readonly beginWorktreeSetup: ReturnType<typeof useWorktreeSetup>["begin"];
  readonly captureDraftHeroComposerRect: () => void;
  readonly setDockedDraftHeroThreadKey: Dispatch<SetStateAction<string | null>>;
  readonly setSetupQueueSendThreadKey: Dispatch<SetStateAction<string | null>>;
  readonly setOptimisticUserMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  readonly setFeedbackSubmissionsByThreadKey: Dispatch<
    SetStateAction<Record<string, ReadonlyArray<CodexFeedbackSubmission>>>
  >;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
  readonly anchorNewTurn: TimelineFollow["anchorNewTurn"];
  readonly acknowledgeActiveThreadWoke: () => void;
  readonly handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  readonly handleNewThreadInActiveProject: () => void;
  readonly persistThreadSettingsForNextTurn: (input: {
    threadId: ThreadId;
    createdAt: string;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<AtomCommandResult<void, unknown>>;
}

/**
 * Everything the composer's send button can start: a turn on this thread or a new one,
 * a multiple-model start, a queued or steering message, a plan follow-up or implementation
 * thread, a feedback upload, and resuming an interrupted run. Each path restores the draft
 * when it fails.
 */
export function useComposerSend(input: ComposerSendInput) {
  const {
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    draftId,
    draftThread,
    activeThread,
    activeThreadKey,
    activeThreadBranch,
    activeProject,
    activeProjectDefaultModelSelection,
    activeProposedPlan,
    activeMessageCount,
    isServerThread,
    isLocalDraftThread,
    isGitRepo,
    phase,
    runtimeMode,
    sendEnvMode,
    startFromOrigin,
    localCheckoutBranchMismatch,
    logicalProjectEnvironments,
    providerInstanceEntries,
    composerRef,
    composerDraftTarget,
    promptRef,
    composerImagesRef,
    composerFilesRef,
    composerTerminalContextsRef,
    feedbackUploadsInFlightRef,
    queuedRunEdit,
    queuedRunsControlRef,
    isConnecting,
    isRevertingCheckpoint,
    threadDetailLoading,
    activeEnvironmentUnavailable,
    isSendBusy,
    sendQueuesBehindSetup,
    isDraftHeroState,
    panelAnimationsActive,
    panelAnimationDurationMs,
    keepFullHistory,
    resumeCompactionTokens,
    showPlanFollowUpPrompt,
    usageLimitsKey,
    usageLimitsOffered,
    openUsageLimits,
    clearUsageLimitsFor,
    needsLoadBalancing,
    loadBalancing,
    readPendingEnvironmentChange,
    pendingApprovals,
    respondingRequestIds,
    activePendingProgress,
    onAdvanceActivePendingUserInput,
    onRespondToApproval: onRespondToApprovalStable,
    beginLocalDispatch,
    resetLocalDispatch,
    beginWorktreeSetup,
    captureDraftHeroComposerRect,
    setDockedDraftHeroThreadKey,
    setSetupQueueSendThreadKey,
    setOptimisticUserMessages,
    setFeedbackSubmissionsByThreadKey,
    setThreadError,
    anchorNewTurn,
    acknowledgeActiveThreadWoke,
    handleInteractionModeChange,
    handleNewThreadInActiveProject,
    persistThreadSettingsForNextTurn,
  } = input;
  const handleNewThread = useNewThreadHandler();
  const navigate = useNavigate();
  const clientSettingsHydrated = useClientSettingsHydrated();
  const steerGraceWindowMs = useSteerGraceWindowMs();
  const { attemptArchiveThread } = useThreadActions();
  const customGroupCatalog = useThreadGroupCatalog();
  const setKeepFullHistoryOverride = useKeepFullHistoryOverrideStore((state) => state.setOverride);
  // Fork (SP Labs): a Lab-mode first send reserves its lab before launching.
  const prepareLabThread = useAtomCommand(labsEnvironment.prepareThread, { reportFailure: false });
  const planModeEnabled = useEnvironmentSettings(environmentId, selectPlanModeEnabled);
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const uploadThreadFeedback = useOrchestrationCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftPreviewAnnotations = useComposerDraftStore(
    (store) => store.setPreviewAnnotations,
  );
  const setComposerDraftReviewComments = useComposerDraftStore((store) => store.setReviewComments);
  const setComposerDraftThreadContexts = useComposerDraftStore((store) => store.setThreadContexts);
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const sendToMultipleModels = useMultipleModelSend({
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    draftId,
    composerDraftTarget,
    composerRef,
    promptRef,
    runtimeMode,
    startFromOrigin,
    resetLocalDispatch,
    setThreadError,
  });
  const submitPlanFollowUp = usePlanFollowUpSend({
    environmentId,
    routeThreadKey,
    activeThread,
    activeThreadBranch,
    activeProposedPlan,
    isServerThread,
    isSendBusy,
    isConnecting,
    composerRef,
    beginLocalDispatch,
    resetLocalDispatch,
    runtimeMode,
    localCheckoutBranchMismatch,
    setOptimisticUserMessages,
    setThreadError,
    anchorNewTurn,
    persistThreadSettingsForNextTurn,
  });
  const { sendInFlight: sendInFlightRef } = draftSendState(routeThreadKey);
  const composerSendGenerationRef = useRef(0);
  const environmentUnavailableSendToastSlotRef = useRef(0);
  // A send awaits uploads before it declines, so it reads the approvals pending by then.
  const pendingApprovalsRef = useRef(pendingApprovals);
  const respondingRequestIdsRef = useRef(respondingRequestIds);
  useLayoutEffect(() => {
    pendingApprovalsRef.current = pendingApprovals;
    respondingRequestIdsRef.current = respondingRequestIds;
  }, [pendingApprovals, respondingRequestIds]);

  const onSend = async (
    e?: { preventDefault: () => void },
    dispatchMode: ComposerDispatchMode = "auto",
    submissionIntent: ComposerSubmissionIntent = "foreground",
    directAnnotation?: {
      annotation: PreviewAnnotationPayload;
      image: ComposerImageAttachment | null;
    },
    // Fork: the secondary send key sends once with the Compact chip's other state.
    keepFullHistoryOnce?: boolean,
  ) => {
    e?.preventDefault();
    // What the user pressed send on; uploads below can take a while, and a redirect must not
    // decline approvals for a draft that changed meanwhile.
    const promptAtSend = promptRef.current;
    if (
      usageLimitsOffered &&
      usageLimitsKey !== null &&
      !directAnnotation &&
      !draftHasNonPromptContent(composerDraftTarget) &&
      isUsageLimitsCommand(promptRef.current)
    ) {
      if (openUsageLimits()) {
        promptRef.current = "";
        setComposerDraftPrompt(composerDraftTarget, "");
        composerRef.current?.resetCursorState();
      }
      return;
    }

    const notifyDirectAnnotationAttached = () => {
      if (!directAnnotation) return;
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Annotation attached to draft",
          description: "Sending is unavailable right now. Finish the current action, then send.",
        }),
      );
    };
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !activeThread ||
      (isSendBusy && !sendQueuesBehindSetup) ||
      isConnecting ||
      isRevertingCheckpoint ||
      queuedRunEdit.rescueActive ||
      !clientSettingsHydrated ||
      threadDetailLoading ||
      readPendingEnvironmentChange() !== null ||
      sendInFlightRef.current ||
      feedbackUploadsInFlightRef.current.has(routeThreadKey)
    ) {
      notifyDirectAnnotationAttached();
      return;
    }
    if (needsLoadBalancing) {
      const draft = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
      toastManager.add({
        type: "warning",
        ...loadBalancingSendWarning({
          pending: loadBalancing.pending,
          threadContexts: draft ? referencedThreadContexts(draft) : [],
          candidateEnvironmentIds: logicalProjectEnvironments.map(
            (candidate) => candidate.environmentId,
          ),
        }),
      });
      return;
    }
    const notifyEnvironmentUnavailable = () => {
      const toastSlot = environmentUnavailableSendToastSlotRef.current;
      environmentUnavailableSendToastSlotRef.current =
        (toastSlot + 1) % ENVIRONMENT_UNAVAILABLE_SEND_TOAST_TRAIL_SIZE;
      toastManager.add({
        ...stackedThreadToast({
          type: "warning",
          title: "Not connected: message not sent",
          description: "Reconnecting to the environment. Try again once it is connected.",
        }),
        id: `chat-send-environment-unavailable:${toastSlot}`,
      });
    };
    // A plain prompt to a server thread waits in the durable outbox while offline;
    // anything that needs the server right away still refuses.
    const sendOffline =
      activeEnvironmentUnavailable &&
      isServerThread &&
      !queuedRunEdit.isEditing &&
      !directAnnotation;
    if (activeEnvironmentUnavailable && !sendOffline) {
      notifyEnvironmentUnavailable();
      return;
    }
    const sendCtx = composerRef.current?.getSendContext();
    if (activePendingProgress && sendCtx?.answeringPendingUserInput !== false) {
      if (sendOffline) {
        notifyEnvironmentUnavailable();
        return;
      }
      if (directAnnotation) {
        notifyDirectAnnotationAttached();
        return;
      }
      onAdvanceActivePendingUserInput();
      return;
    }
    // Fork: `/t3-archive` archives now or when done; sent again, it cancels.
    // Attachments or contexts mean a real prompt, which goes to the provider.
    const archiveCommand =
      !directAnnotation &&
      !queuedRunEdit.isEditing &&
      sendCtx !== undefined &&
      sendCtx.threadContexts.length === 0 &&
      hasStandaloneComposerCommandContext({
        imageCount: sendCtx.images.length,
        fileCount: sendCtx.files.length,
        terminalContextCount: sendCtx.terminalContexts.length,
        previewAnnotationCount: sendCtx.previewAnnotations.length,
        reviewCommentCount: sendCtx.reviewComments.length,
      })
        ? parseComposerArchiveCommand(promptRef.current)
        : null;
    if (archiveCommand) {
      if (archiveCommand.action === null) {
        toastManager.add({
          type: "error",
          title: "Unable to archive thread",
          description: "Usage: /t3-archive (send again to cancel a pending archive)",
        });
        return;
      }
      if (!isServerThread) {
        toastManager.add({ type: "error", title: "No thread to archive yet" });
        return;
      }
      if (activeThread.archivedAt !== null) {
        toastManager.add({ type: "error", title: "This thread is already archived" });
        return;
      }
      if (archiveCommand.action === "cancel" && !hasPendingArchive(activeThread)) {
        toastManager.add({ type: "error", title: "No archive is pending for this thread" });
        return;
      }
      // The shared archive path: archive now (with its confirmation and
      // Undo), archive when done, or cancel a pending archive.
      const promptForArchive = promptRef.current;
      const draftTargetForArchive = composerDraftTarget;
      sendInFlightRef.current = true;
      // A promise `finally`: the React Compiler cannot compile try/finally.
      await attemptArchiveThread(scopeThreadRef(environmentId, activeThread.id), {
        ...(archiveCommand.action === "cancel" ? { expectedAction: "cancel" as const } : {}),
        scheduledHint: "Send /t3-archive again to cancel.",
        // Clear only an unchanged draft: the user may have typed on meanwhile.
        onApplied: () => {
          if (promptRef.current !== promptForArchive) return;
          promptRef.current = "";
          clearComposerDraftContent(draftTargetForArchive);
          composerRef.current?.resetCursorState();
        },
      }).finally(() => {
        sendInFlightRef.current = false;
      });
      return;
    }
    if (!sendCtx?.providerAvailable) {
      notifyDirectAnnotationAttached();
      return;
    }
    const multipleModelSelections = sendCtx.multipleModelSelections;
    const approvalFeedbackTarget = pendingApprovalsRef.current.find(
      (approval) =>
        approval.supportsFeedback && approval.requestId === sendCtx.shownPendingApprovalIds[0],
    );
    // Fork: the offline outbox only starts turns, so approval feedback needs the server.
    if (sendOffline && approvalFeedbackTarget !== undefined) {
      notifyEnvironmentUnavailable();
      return;
    }
    const multipleModelBlock =
      multipleModelSelections === null
        ? null
        : multipleModelSendBlock({
            selectionCount: multipleModelSelections.length,
            serverSupportsWorktreeBootstrap:
              readEnvironmentPresentation(activeThread.environmentId)?.serverConfig?.environment
                .capabilities.requiredWorktreeBootstrap === true,
            isLocalDraftThread,
            isGitRepo,
            branch: activeThreadBranch,
          });
    if (multipleModelBlock === "server-outdated") {
      setThreadError(activeThread.id, "Update this server before starting multiple models.");
      return;
    }
    if (multipleModelBlock === "needs-new-git-thread") {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Choose models and a base branch",
          description:
            "Multiple models need a new thread in a Git project. Each gets its own worktree.",
        }),
      );
      return;
    }
    const {
      images: sendContextImages,
      files: composerFiles,
      terminalContexts: composerTerminalContexts,
      previewAnnotations: sendContextPreviewAnnotations,
      reviewComments: composerReviewComments,
      threadContexts: composerThreadContexts,
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
      interactionMode: sendInteractionMode,
      interactionModeEnabled: sendInteractionModeEnabled,
    } = sendCtx;
    const { images: composerImages, previewAnnotations: composerPreviewAnnotations } =
      mergeDirectPreviewAnnotation({
        images: sendContextImages,
        fileCount: composerFiles.length,
        previewAnnotations: sendContextPreviewAnnotations,
        direct: directAnnotation,
      });
    // A direct "send annotation" writes the draft and sends in the same tick; the reference
    // must be in the text now, not after the next render.
    const promptForSend = directAnnotation
      ? ensureInlineContextReferences(promptRef.current, [
          previewAnnotationContextReference(directAnnotation.annotation),
        ])
      : promptRef.current;
    if (
      sendOffline &&
      (multipleModelSelections !== null || composerImages.length > 0 || composerFiles.length > 0)
    ) {
      notifyEnvironmentUnavailable();
      return;
    }
    const strandedThread = threadContextsOutsideEnvironment({
      text: promptForSend,
      records: composerThreadContexts,
      environmentId,
    })[0];
    if (strandedThread) {
      const owner =
        readEnvironmentPresentation(strandedThread.environmentId)?.entry.target.label ??
        "its machine";
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Attached thread is on another machine",
          description: `This machine's agent can't read "${strandedThread.title}". Remove it, or switch back to ${owner} to send.`,
        }),
      );
      return;
    }
    if (queuedRunEdit.isEditing) {
      // Edit mode repurposes the composer: sending saves the queued message
      // in place instead of dispatching a new turn.
      await queuedRunEdit.saveEdit(
        {
          prompt: promptForSend,
          images: composerImages,
          files: composerFiles,
          terminalContexts: composerTerminalContexts,
          reviewComments: composerReviewComments,
          previewAnnotations: composerPreviewAnnotations,
          threadContexts: composerThreadContexts,
        },
        setThreadError,
      );
      return;
    }
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length + composerFiles.length,
      terminalContexts: composerTerminalContexts,
      elementContextCount:
        composerPreviewAnnotations.length +
        composerReviewComments.length +
        composerThreadContexts.length,
    });
    const feedbackCommand =
      ctxSelectedProvider === "codex" &&
      composerImages.length === 0 &&
      composerFiles.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0 &&
      composerThreadContexts.length === 0
        ? parseCodexFeedbackCommand(trimmed)
        : null;
    if (feedbackCommand && multipleModelSelections === null) {
      if (sendOffline) {
        notifyEnvironmentUnavailable();
        return;
      }
      if (!isServerThread || activeThread.activeProviderThreadId === null) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Start a Codex thread first",
            description: "Send a message before you submit feedback.",
          }),
        );
        return;
      }
      feedbackUploadsInFlightRef.current.add(routeThreadKey);
      await submitCodexFeedback({
        submission: {
          id: newMessageId(),
          command: trimmed,
          createdAt: new Date().toISOString(),
        },
        clearDraft: () => {
          promptRef.current = "";
          clearComposerDraftContent(composerDraftTarget);
          composerRef.current?.resetCursorState();
        },
        onUpdate: (submission) => {
          setFeedbackSubmissionsByThreadKey((current) => {
            const existing = current[routeThreadKey] ?? [];
            const found = existing.some((entry) => entry.id === submission.id);
            return {
              ...current,
              [routeThreadKey]: found
                ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                : [...existing, submission],
            };
          });
        },
        upload: () =>
          uploadThreadFeedback({
            environmentId: activeThread.environmentId,
            input: { threadId: activeThread.id, ...feedbackCommand },
          }),
      }).finally(() => {
        feedbackUploadsInFlightRef.current.delete(routeThreadKey);
      });

      return;
    }
    if (
      !directAnnotation &&
      sendInteractionModeEnabled &&
      showPlanFollowUpPrompt &&
      activeProposedPlan &&
      composerImages.length === 0 &&
      composerFiles.length === 0
    ) {
      if (sendOffline) {
        notifyEnvironmentUnavailable();
        return;
      }
      const followUp = resolvePlanFollowUpSubmission({
        draftText: promptForSend,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      const outgoingFollowUpText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: followUp.text.trim(),
      });
      if (composerRef.current?.validateProviderInput(outgoingFollowUpText) === false) {
        return;
      }
      const followUpPromptSnapshot = promptRef.current;
      const followUpTerminalContexts = [...sendableComposerTerminalContexts];
      const followUpReviewComments = [...composerReviewComments];
      const followUpPreviewAnnotations = [...composerPreviewAnnotations];
      const followUpThreadContexts = [...composerThreadContexts];
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      const followUpSent = await submitPlanFollowUp({
        text: followUp.text,
        context: buildMessageContext({
          terminalContexts: sendableComposerTerminalContexts,
          reviewComments: composerReviewComments,
          previewAnnotations: composerPreviewAnnotations,
          threadContexts: composerThreadContexts,
        }),
        interactionMode: followUp.interactionMode,
      });
      if (!followUpSent) {
        promptRef.current = followUpPromptSnapshot;
        composerTerminalContextsRef.current = [...followUpTerminalContexts];
        restorePlanFollowUpComposer({
          snapshot: {
            prompt: followUpPromptSnapshot,
            terminalContexts: followUpTerminalContexts,
            reviewComments: followUpReviewComments,
            previewAnnotations: followUpPreviewAnnotations,
            threadContexts: followUpThreadContexts,
          },
          writePrompt: (prompt) => setComposerDraftPrompt(composerDraftTarget, prompt),
          writeTerminalContexts: (contexts) =>
            setComposerDraftTerminalContexts(composerDraftTarget, [...contexts]),
          writeReviewComments: (comments) =>
            setComposerDraftReviewComments(composerDraftTarget, [...comments]),
          writePreviewAnnotations: (annotations) =>
            setComposerDraftPreviewAnnotations(composerDraftTarget, [...annotations]),
          writeThreadContexts: (records) =>
            setComposerDraftThreadContexts(composerDraftTarget, [...records]),
          resetCursor: (options) => composerRef.current?.resetCursorState(options),
        });
      } else if (
        submissionIntent === "background" &&
        currentRouteThreadKeyRef.current === routeThreadKey
      ) {
        handleNewThreadInActiveProject();
      }
      return;
    }
    const standaloneSlashCommand =
      sendInteractionModeEnabled &&
      composerImages.length === 0 &&
      composerFiles.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0 &&
      composerThreadContexts.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand && multipleModelSelections === null) {
      if (sendOffline) {
        notifyEnvironmentUnavailable();
        return;
      }
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: toastCopy.title,
            description: toastCopy.description,
          }),
        );
        return;
      }
      // Sending an empty composer skips the wait on the steer just sent.
      if (!sendOffline) queuedRunsControlRef.current?.steerNewestHeld();
      return;
    }
    if (!activeProject) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Choose a project first",
          description: "This draft no longer points to an available project.",
        }),
      );
      return;
    }
    const threadIdForSend = activeThread.id;
    const sendSnapshot = snapshotComposerSend({
      prompt: promptForSend,
      images: composerImages,
      files: composerFiles,
      terminalContexts: composerTerminalContexts,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      previewAnnotations: composerPreviewAnnotations,
      reviewComments: composerReviewComments,
      threadContexts: composerThreadContexts,
    });
    const {
      files: composerFilesSnapshot,
      attachments: composerAttachmentsSnapshot,
      terminalContexts: composerTerminalContextsSnapshot,
      previewAnnotations: composerPreviewAnnotationsSnapshot,
      reviewComments: composerReviewCommentsSnapshot,
      threadContexts: composerThreadContextsSnapshot,
      messageText: messageTextForSend,
    } = sendSnapshot;
    const {
      isFirstMessage,
      missingWorktreeBaseBranch,
      baseBranchForWorktree,
      compactBeforeSend,
      turnDispatchMode,
      shouldQueueBehindActiveRun,
    } = planComposerTurn({
      messageText: messageTextForSend,
      sendQueuesBehindSetup,
      isServerThread,
      activeMessageCount,
      sendEnvMode,
      worktreePath: activeThread.worktreePath,
      activeThreadBranch,
      resumeCompactionTokens,
      keepFullHistory: keepFullHistoryOnce ?? keepFullHistory,
      // An older unaccepted send waits in the outbox; compacting would jump ahead of it.
      hasPendingOutboxSubmission:
        isServerThread &&
        hasPendingThreadSubmission(
          useThreadOutboxStore.getState().submissions,
          environmentId,
          threadIdForSend,
        ),
      steerGraceWindowMs,
      phase,
      dispatchMode,
    });
    if (missingWorktreeBaseBranch) {
      setThreadError(threadIdForSend, "Select a base branch before sending in New worktree mode.");
      return;
    }
    // Fork (SP Labs): a Lab-mode first send reserves its lab, then launches into its worktree.
    let labSendRequest: {
      readonly labId: string;
      readonly branch: string | null;
      readonly baseRef: string | null;
    } | null = null;
    if (
      isFirstMessage &&
      sendEnvMode === "lab" &&
      multipleModelSelections === null &&
      !activeThread.worktreePath
    ) {
      const labIntent = draftThread?.lab ?? DEFAULT_DRAFT_LAB_INTENT;
      const branchRequest = resolveLabBranchRequest(labIntent);
      const target = resolveLabSendTarget(
        labIntent,
        readLabsSnapshot(activeThread.environmentId),
        threadIdForSend,
      );
      if (!branchRequest.ok || !target.ok) {
        setThreadError(
          threadIdForSend,
          !branchRequest.ok ? branchRequest.error : !target.ok ? target.error : null,
        );
        return;
      }
      labSendRequest = {
        labId: target.labId,
        branch: branchRequest.branch,
        baseRef: branchRequest.baseRef,
      };
    }
    // Fork: the draft's custom group joins the thread this send creates. The
    // send environment can differ from where the group was picked, so the
    // capability is read live.
    const creationGroup = isLocalDraftThread
      ? resolveDraftCreationGroup({
          customGroupId: draftThread?.customGroupId,
          catalog: customGroupCatalog.catalog,
          supportsGroupCreation:
            appAtomRegistry.get(environmentServerConfigsAtom).get(activeThread.environmentId)
              ?.environment.capabilities.threadCustomGroupCreation === true,
        })
      : null;
    if (creationGroup?.blockReason) {
      setThreadError(threadIdForSend, creationGroup.blockReason);
      return;
    }
    const creationGroupFields =
      creationGroup?.customGroupId != null ? { customGroupId: creationGroup.customGroupId } : {};
    const inputOriginForSend = useComposerDraftStore
      .getState()
      .getComposerDraft(composerDraftTarget)?.inputOrigin;
    // Records bind attachments by the id each side knows: the local id for the optimistic
    // row, the upload id (or local id on the data-URL path) on the wire; the server
    // rebinds them to the persisted id.
    const buildOutgoingMessageContext = (attachmentIds: ReadonlyArray<string>) =>
      buildMessageContext({
        terminalContexts: composerTerminalContextsSnapshot,
        reviewComments: composerReviewCommentsSnapshot,
        previewAnnotations: composerPreviewAnnotationsSnapshot,
        threadContexts: composerThreadContextsSnapshot,
        attachments: composerAttachmentsSnapshot.map((attachment, index) => ({
          attachment,
          attachmentId: attachmentIds[index] ?? attachment.id,
        })),
      });
    const outgoingMessageContext = buildOutgoingMessageContext(
      composerAttachmentsSnapshot.map((attachment) => attachment.id),
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: messageTextForSend || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    });
    if (composerRef.current?.validateProviderInput(outgoingMessageText) === false) {
      return;
    }

    const readLiveAttachmentCapabilities = () => {
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
      const liveSupportsAttachmentUploads =
        config?.environment.capabilities.attachmentUploads === true;
      return {
        supportsAttachmentUploads: liveSupportsAttachmentUploads,
        fileBlockReason: fileAttachmentCapabilityBlockReason({
          files: composerFilesSnapshot,
          attachmentUploadsCapabilityKnown: config !== null,
          supportsAttachmentUploads: liveSupportsAttachmentUploads,
          maxFileAttachmentBytes:
            config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
        }),
      };
    };

    const multipleTargets: MultipleModelTarget[] = [];
    for (const resolved of resolveMultipleModelTargets({
      selections: multipleModelSelections ?? [],
      providerInstanceEntries,
      messageText: messageTextForSend,
      planModeEnabled,
      interactionMode: sendInteractionMode,
    })) {
      if ("error" in resolved) {
        setThreadError(threadIdForSend, resolved.error);
        return;
      }
      if (composerRef.current?.validateProviderInput(resolved.text) === false) return;
      multipleTargets.push(resolved);
    }

    if (sendOffline) {
      const queuedOffline =
        !baseBranchForWorktree &&
        enqueueThreadSubmission({
          environmentId,
          threadId: threadIdForSend,
          commandId: newCommandId(),
          messageId: messageIdForSend,
          text: outgoingMessageText,
          ...(outgoingMessageContext === undefined ? {} : { context: outgoingMessageContext }),
          ...(inputOriginForSend ? { inputOrigin: inputOriginForSend } : {}),
          attachments: [],
          modelSelection: ctxSelectedModelSelection,
          dispatchMode,
          settings: { runtimeMode, interactionMode: sendInteractionMode },
          createdAt: messageCreatedAt,
        });
      if (!queuedOffline) {
        notifyEnvironmentUnavailable();
        return;
      }
      setThreadError(threadIdForSend, null);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      // The durable outbox owns delivery now, so send-then-new moves on like
      // an online send does.
      if (
        submissionIntent === "background" &&
        currentRouteThreadKeyRef.current === routeThreadKey
      ) {
        handleNewThreadInActiveProject();
      }
      return;
    }
    sendInFlightRef.current = true;
    const sendGeneration = ++composerSendGenerationRef.current;
    const attachmentCapabilitiesBeforeUpload = readLiveAttachmentCapabilities();
    if (attachmentCapabilitiesBeforeUpload.fileBlockReason !== null) {
      sendInFlightRef.current = false;
      setThreadError(threadIdForSend, attachmentCapabilitiesBeforeUpload.fileBlockReason);
      return;
    }
    const turnUsesAttachmentUploads =
      composerFilesSnapshot.length > 0
        ? attachmentCapabilitiesBeforeUpload.supportsAttachmentUploads
        : readEnvironmentPresentation(environmentId)?.serverConfig?.environment.capabilities
            .attachmentUploads === true;
    if (turnUsesAttachmentUploads && composerAttachmentsSnapshot.length > 0) {
      for (const attachment of composerAttachmentsSnapshot) {
        const upload =
          readAttachmentUpload(attachment.id)?.status === "failed"
            ? retryAttachmentUpload
            : startAttachmentUpload;
        upload({
          environmentId,
          image: attachment,
          draftTarget: composerDraftTarget,
        });
      }
      await awaitAttachmentUploads(composerAttachmentsSnapshot.map((attachment) => attachment.id));
      const attachmentCapabilitiesAfterUpload = readLiveAttachmentCapabilities();
      if (attachmentCapabilitiesAfterUpload.fileBlockReason !== null) {
        sendInFlightRef.current = false;
        setThreadError(threadIdForSend, attachmentCapabilitiesAfterUpload.fileBlockReason);
        return;
      }
      if (getUploadedAttachments({ environmentId, images: composerAttachmentsSnapshot }) === null) {
        sendInFlightRef.current = false;
        setThreadError(threadIdForSend, "Retry or remove failed uploads before sending.");
        return;
      }
    }

    // Fork: an emptied draft whose send is in flight must not be replaced by
    // an archive Undo before its thread appears (see archiveUndo.ts).
    if (draftId) {
      draftSubmissionTracker.begin(draftId);
    }
    if (
      multipleModelSelections === null &&
      shouldDockDraftHeroForSubmission({ isDraftHeroState, activeThreadKey, submissionIntent }) &&
      activeThreadKey
    ) {
      let resolveDockStarted: (() => void) | undefined;
      const dockStarted = new Promise<void>((resolve) => {
        resolveDockStarted = resolve;
      });
      const dockTransition = runMobileComposerTransition(
        () => {
          flushSync(() => {
            captureDraftHeroComposerRect();
            setDockedDraftHeroThreadKey(activeThreadKey);
          });
          resolveDockStarted?.();
        },
        {
          active: panelAnimationsActive,
          durationMs: panelAnimationDurationMs,
        },
      );
      void dockTransition.catch(() => resolveDockStarted?.());
      await dockStarted;
    }

    const attachmentCapabilitiesBeforeDispatch = readLiveAttachmentCapabilities();
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      attachmentCapabilitiesBeforeDispatch.fileBlockReason !== null
    ) {
      sendInFlightRef.current = false;
      if (draftId) draftSubmissionTracker.clear(draftId);
      setThreadError(
        threadIdForSend,
        attachmentCapabilitiesBeforeDispatch.fileBlockReason ??
          "This connection cannot change threads.",
      );
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      return;
    }
    // A message sent while approvals are pending redirects the agent. They are declined only
    // here, after everything above has accepted the send, so local commands and rejected
    // drafts leave them alone. After navigating away during an upload, the shown approvals
    // are another thread's, so this send leaves them alone too.
    const approvalsToDecline =
      currentRouteThreadKeyRef.current === routeThreadKey
        ? pendingApprovalsRef.current.filter((approval) =>
            sendCtx?.shownPendingApprovalIds.includes(approval.requestId),
          )
        : [];
    if (approvalsToDecline.length > 0 || approvalFeedbackTarget !== undefined) {
      // A draft edited since send, or a paste still landing in it, is no longer the message
      // the user sent.
      const attachmentIdsAtSend = composerAttachmentsSnapshot.map((attachment) => attachment.id);
      // A direct annotation send writes its image and reference into the draft as it sends,
      // so the live draft may still lack them; anything else differing is a real edit.
      const annotationImageId = directAnnotation?.image?.id;
      const attachmentIdsBeforeAnnotation = attachmentIdsAtSend.filter(
        (id) => id !== annotationImageId,
      );
      const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
        left.length === right.length && left.every((id, index) => id === right[index]);
      const draftChangedSinceSend = () => {
        if (composerRef.current?.hasPendingAttachments() === true) return true;
        const sendContext = composerRef.current?.getSendContext();
        const attachmentIds = sendContext
          ? [...sendContext.images, ...sendContext.files].map((attachment) => attachment.id)
          : attachmentIdsAtSend;
        const promptUnchanged =
          promptRef.current === promptAtSend || promptRef.current === promptForSend;
        const attachmentsUnchanged =
          sameIds(attachmentIds, attachmentIdsAtSend) ||
          (annotationImageId !== undefined &&
            sameIds(attachmentIds, attachmentIdsBeforeAnnotation));
        return !promptUnchanged || !attachmentsUnchanged;
      };
      const draftBeforeDecline = useComposerDraftStore
        .getState()
        .getComposerDraft(composerDraftTarget);
      const changedBeforeDecline = draftChangedSinceSend();
      const pendingIdsBeforeDecline = pendingApprovalsRef.current.map(
        (approval) => approval.requestId,
      );
      const approvalResponding = approvalsToDecline.some((approval) =>
        respondingRequestIdsRef.current.includes(approval.requestId),
      );
      if (approvalFeedbackTarget !== undefined) {
        if (composerAttachmentsSnapshot.length > 0 || outgoingMessageContext !== undefined) {
          setThreadError(
            threadIdForSend,
            "Send approval feedback without attachments or added context.",
          );
          sendInFlightRef.current = false;
          return;
        }
        if (
          changedBeforeDecline ||
          approvalResponding ||
          currentRouteThreadKeyRef.current !== routeThreadKey
        ) {
          sendInFlightRef.current = false;
          return;
        }
        const sent = await sendApprovalFeedback(
          approvalFeedbackTarget,
          messageTextForSend,
          onRespondToApprovalStable,
        ).catch(() => false);
        sendInFlightRef.current = false;
        if (
          sent &&
          !draftChangedSinceSend() &&
          currentRouteThreadKeyRef.current === routeThreadKey &&
          useComposerDraftStore.getState().getComposerDraft(composerDraftTarget) ===
            draftBeforeDecline
        ) {
          promptRef.current = "";
          clearComposerDraftContent(composerDraftTarget);
          composerRef.current?.resetCursorState();
        }
        return;
      }
      const declined =
        !changedBeforeDecline &&
        !approvalResponding &&
        (await declinePendingApprovals(approvalsToDecline, onRespondToApprovalStable).catch(
          () => false,
        ));
      const draftChanged =
        changedBeforeDecline ||
        draftChangedSinceSend() ||
        useComposerDraftStore.getState().getComposerDraft(composerDraftTarget) !==
          draftBeforeDecline;
      // An approval that arrived during the decline would block the redirect; keep the draft so
      // the next send declines it too.
      const approvalArrived = pendingApprovalsRef.current.some(
        (approval) => !pendingIdsBeforeDecline.includes(approval.requestId),
      );
      if (
        !declined ||
        draftChanged ||
        approvalArrived ||
        currentRouteThreadKeyRef.current !== routeThreadKey
      ) {
        sendInFlightRef.current = false;
        if (draftId) draftSubmissionTracker.clear(draftId);
        setDockedDraftHeroThreadKey((currentThreadKey) =>
          currentThreadKey === activeThreadKey ? null : currentThreadKey,
        );
        const notice = approvalRedirectNotice({
          draftChanged,
          declined,
          approvalResponding,
          approvalArrived,
        });
        if (notice !== null) {
          toastManager.add({
            type: "info",
            title: notice,
            description: "Send again when it's ready.",
          });
        }
        return;
      }
    }
    if (sendQueuesBehindSetup) {
      setSetupQueueSendThreadKey(activeThreadKey);
    } else {
      beginLocalDispatch({
        preparingWorktree: multipleModelSelections !== null || Boolean(baseBranchForWorktree),
        submissionIntent:
          submissionIntent === "background" && !isLocalDraftThread
            ? "foreground"
            : submissionIntent,
      });
      beginWorktreeSetup(
        multipleModelSelections === null && baseBranchForWorktree
          ? { environmentId: activeThread.environmentId, threadId: threadIdForSend }
          : null,
      );
    }

    const turnAttachmentsPromise = prepareTurnAttachments({
      environmentId,
      attachments: composerAttachmentsSnapshot,
      usesAttachmentUploads: turnUsesAttachmentUploads,
    });
    if (multipleModelSelections !== null) {
      await sendToMultipleModels({
        threadId: threadIdForSend,
        project: activeProject,
        branch: activeThreadBranch!,
        selections: multipleModelSelections,
        targets: multipleTargets,
        sendSnapshot,
        createdAt: messageCreatedAt,
        attachmentsPromise: turnAttachmentsPromise,
        usesAttachmentUploads: turnUsesAttachmentUploads,
        readFileBlockReason: () => readLiveAttachmentCapabilities().fileBlockReason,
        buildOutgoingMessageContext,
        isCurrentSend: () => composerSendGenerationRef.current === sendGeneration,
        inputOrigin: inputOriginForSend,
        customGroupId: creationGroup?.customGroupId ?? null,
      });
      return;
    }
    const optimisticAttachments = optimisticMessageAttachments(composerAttachmentsSnapshot);
    if (!shouldQueueBehindActiveRun) {
      anchorNewTurn(
        scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadIdForSend)),
        messageIdForSend,
      );
    }
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        ...(outgoingMessageContext !== undefined ? { context: outgoingMessageContext } : {}),
        ...(inputOriginForSend ? { inputOrigin: inputOriginForSend } : {}),
        runId: null,
        createdAt: messageCreatedAt,
        updatedAt: messageCreatedAt,
        streaming: false,
        ...(shouldQueueBehindActiveRun
          ? { inputIntent: "queued_turn" as const }
          : phase === "running" && dispatchMode === "steer"
            ? { inputIntent: "steer" as const }
            : {}),
      },
    ]);
    setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        }),
      );
    }
    const sentDraftThreadRef = isLocalDraftThread
      ? scopeThreadRef(environmentId, threadIdForSend)
      : null;
    // Keep new-thread flows from reusing this draft while attachments and worktree setup settle.
    if (sentDraftThreadRef) markPromotedDraftThreadByRef(sentDraftThreadRef);
    // Compact-then-send keeps the draft until the follow-up is durably enqueued:
    // a reload during the /compact request must not lose the prompt.
    let sentDraftCleared = false;
    const clearSentDraft = () => {
      if (sentDraftCleared) return;
      sentDraftCleared = true;
      clearComposerDraftContent(composerDraftTarget);
      if (currentRouteThreadKeyRef.current === routeThreadKey) {
        promptRef.current = "";
        composerRef.current?.resetCursorState();
      }
    };
    if (!compactBeforeSend) clearSentDraft();

    const title = deriveThreadTitleSeed({
      text: messageTextForSend,
      attachments: composerAttachmentsSnapshot,
      fallbackLabels: sendTitleFallbackLabels(sendSnapshot),
    });
    const threadCreateModelSelection = createModelSelection(
      ctxSelectedModelSelection.instanceId,
      ctxSelectedModel || activeProjectDefaultModelSelection?.model || DEFAULT_MODEL,
      ctxSelectedModelSelection.options,
    );

    let failure: AtomCommandResult<unknown, unknown> | null = null;

    const persistSettingsForSend = () =>
      persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode: sendInteractionMode,
      });
    // An existing server thread's send records its settings in its outbox row
    // before applying them (below), so a reload in between still resends both.
    const settingsGoThroughOutbox = isServerThread && !isLocalDraftThread && !baseBranchForWorktree;
    if (failure === null && isServerThread && !settingsGoThroughOutbox) {
      const settingsResult = await persistSettingsForSend();
      if (settingsResult._tag === "Failure") {
        failure = settingsResult;
      }
    }

    const turnAttachmentsResult = await settlePromise(async () => {
      const turnAttachments = await turnAttachmentsPromise;
      const liveFileBlockReason = readLiveAttachmentCapabilities().fileBlockReason;
      if (liveFileBlockReason !== null) {
        throw new Error(liveFileBlockReason);
      }
      return turnAttachments;
    });
    if (failure === null && turnAttachmentsResult._tag === "Failure") {
      failure = turnAttachmentsResult;
    }

    if (failure === null && compactBeforeSend) {
      const compactResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: threadIdForSend,
          message: { messageId: newMessageId(), role: "user", text: "/compact", attachments: [] },
          modelSelection: ctxSelectedModelSelection,
          runtimeMode,
          interactionMode: sendInteractionMode,
        },
      });
      if (compactResult._tag === "Failure") {
        failure = compactResult;
      }
    }

    // Fork (SP Labs): reserve the lab only once everything else is ready. A failure keeps the
    // composer content (the failure path below restores it) and launches nothing.
    let labWorkspace: { readonly worktreePath: string; readonly branch: string } | null = null;
    if (failure === null && labSendRequest !== null) {
      const prepared = await prepareLabThread({
        environmentId,
        input: {
          threadId: threadIdForSend,
          labId: labSendRequest.labId,
          branch: labSendRequest.branch,
          baseRef: labSendRequest.baseRef,
          purpose: resolveLabPurpose(trimmed, title),
        },
      });
      if (prepared._tag === "Failure") failure = prepared;
      else labWorkspace = prepared.value;
    }

    let backgroundDraftOpened = false;
    let turnStartSucceeded = false;
    if (failure === null && turnAttachmentsResult._tag === "Success") {
      const bootstrap =
        isLocalDraftThread || baseBranchForWorktree
          ? {
              ...(isLocalDraftThread
                ? {
                    createThread: {
                      projectId: activeProject.id,
                      title,
                      modelSelection: threadCreateModelSelection,
                      runtimeMode,
                      interactionMode: sendInteractionMode,
                      branch: labWorkspace?.branch ?? activeThreadBranch,
                      worktreePath: labWorkspace?.worktreePath ?? activeThread.worktreePath,
                      createdAt: activeThread.createdAt,
                      ...creationGroupFields,
                    },
                  }
                : {}),
              ...(baseBranchForWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: activeProject.workspaceRoot,
                      baseBranch: baseBranchForWorktree,
                      ...(startFromOrigin ? { startFromOrigin: true } : {}),
                    },
                    runSetupScript: true,
                  }
                : {}),
            }
          : undefined;
      const backgroundThreadRef =
        submissionIntent === "background" && isLocalDraftThread
          ? scopeThreadRef(environmentId, threadIdForSend)
          : null;
      if (backgroundThreadRef) beginBackgroundDraftSubmissionByRef(backgroundThreadRef);
      const turnMessage = {
        messageId: messageIdForSend,
        role: "user" as const,
        attachments: turnAttachmentsResult.value,
        ...(inputOriginForSend ? { inputOrigin: inputOriginForSend } : {}),
        ...withMessageContext({
          text: outgoingMessageText,
          context: buildOutgoingMessageContext(
            boundAttachmentIds(turnAttachmentsResult.value, composerAttachmentsSnapshot),
          ),
          // Read at dispatch time: the upload and persistence awaits above can
          // span a server reconnect that changes it.
          supportsInlineMessageContext:
            appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment
              .capabilities.inlineMessageContext === true,
        }),
      };
      // An existing thread's send stays durable until the server accepts it: a
      // reload or dropped socket leaves the row for the outbox drain, which
      // resends with the same commandId so a delivered send is not repeated.
      const outboxSubmission: PendingThreadSubmission | null =
        bootstrap === undefined && isServerThread
          ? {
              environmentId,
              threadId: threadIdForSend,
              commandId: newCommandId(),
              messageId: messageIdForSend,
              text: turnMessage.text,
              ...(inputOriginForSend ? { inputOrigin: inputOriginForSend } : {}),
              ...("context" in turnMessage && turnMessage.context !== undefined
                ? { context: turnMessage.context }
                : {}),
              attachments: turnMessage.attachments,
              modelSelection: ctxSelectedModelSelection,
              titleSeed: title,
              dispatchMode: turnDispatchMode,
              settings: { runtimeMode, interactionMode: sendInteractionMode },
              createdAt: messageCreatedAt,
            }
          : null;
      // An older unaccepted row for this thread goes first: this one waits
      // behind it in the drain instead of overtaking it.
      const queuedBehindOutbox =
        outboxSubmission !== null &&
        hasPendingThreadSubmission(
          useThreadOutboxStore.getState().submissions,
          environmentId,
          threadIdForSend,
        ) &&
        enqueueThreadSubmission(outboxSubmission);
      const sentFromOutbox =
        !queuedBehindOutbox &&
        outboxSubmission !== null &&
        enqueueThreadSubmission(outboxSubmission, { claim: true });
      if (queuedBehindOutbox || sentFromOutbox) {
        clearSentDraft();
        setKeepFullHistoryOverride(routeThreadKey, null);
      }
      let settingsLeftForDrain = false;
      if (outboxSubmission !== null && !queuedBehindOutbox) {
        const settingsResult = await persistSettingsForSend();
        if (sentFromOutbox && settingsResult._tag === "Success") {
          // Applied: a resend must not re-apply modes the user may change meanwhile.
          const { settings: _appliedSettings, ...submissionWithoutSettings } = outboxSubmission;
          enqueueThreadSubmission(submissionWithoutSettings, { claim: true });
        } else if (
          sentFromOutbox &&
          settleClaimedThreadSubmission(messageIdForSend, settingsResult)
        ) {
          settingsLeftForDrain = true;
        } else if (settingsResult._tag === "Failure") {
          failure = settingsResult;
        }
      }
      const startPromise =
        failure !== null || queuedBehindOutbox || settingsLeftForDrain
          ? null
          : startThreadTurn({
              environmentId,
              input: {
                threadId: threadIdForSend,
                ...(sentFromOutbox ? { commandId: outboxSubmission.commandId } : {}),
                message: turnMessage,
                modelSelection: ctxSelectedModelSelection,
                titleSeed: title,
                runtimeMode,
                interactionMode: sendInteractionMode,
                dispatchMode: turnDispatchMode,
                steerGraceWindowMs,
                ...(bootstrap ? { bootstrap } : {}),
                createdAt: messageCreatedAt,
              },
            });
      if (backgroundThreadRef) {
        try {
          backgroundDraftOpened = Boolean(
            await handleNewThread(
              scopeProjectRef(activeProject.environmentId, activeProject.id),
              resolveBackgroundDraftWorkspaceOptions({
                envMode: sendEnvMode,
                branch: activeThreadBranch,
                startFromOrigin,
              }),
            ),
          );
        } catch (error) {
          clearBackgroundDraftSubmissionByRef(backgroundThreadRef);
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Could not open a fresh composer",
              description: error instanceof Error ? error.message : undefined,
            }),
          );
        }
      }
      const startResult = startPromise === null ? null : await startPromise;
      // A message the durable outbox now owns counts as sent: send-then-new
      // moves on to the fresh composer as it does after an accepted turn.
      const openNewThreadAfterOutboxHandoff = () => {
        if (
          submissionIntent === "background" &&
          !backgroundThreadRef &&
          currentRouteThreadKeyRef.current === routeThreadKey
        ) {
          handleNewThreadInActiveProject();
        }
      };
      if (startResult === null) {
        // Handed to the outbox drain (or settings failed, reported below).
        if (failure === null) openNewThreadAfterOutboxHandoff();
      } else if (sentFromOutbox && settleClaimedThreadSubmission(messageIdForSend, startResult)) {
        // Not accepted yet: the outbox drain sends it once the connection recovers.
        openNewThreadAfterOutboxHandoff();
      } else if (startResult._tag === "Failure") {
        failure = startResult;
      } else {
        turnStartSucceeded = true;
        clearSentDraft();
        setKeepFullHistoryOverride(routeThreadKey, null);
        clearUsageLimitsFor(routeThreadKey);
        if (turnUsesAttachmentUploads) {
          releaseDraftAttachments(composerAttachmentsSnapshot);
        }
        acknowledgeActiveThreadWoke();
        // A draft still on screen finalizes once its thread route takes over.
        if (sentDraftThreadRef) {
          if (backgroundDraftOpened || currentRouteThreadKeyRef.current !== routeThreadKey) {
            finalizePromotedDraftThreadByRef(sentDraftThreadRef);
          } else {
            clearBackgroundDraftSubmissionByRef(sentDraftThreadRef);
          }
        }
        if (backgroundThreadRef) {
          if (backgroundDraftOpened) {
            if (draftId) {
              draftSubmissionTracker.clear(draftId);
            }
            toastManager.add(
              stackedThreadToast({
                type: "success",
                title: "Started in background",
                timeout: 5_000,
                actionProps: {
                  children: "Open",
                  onClick: () => {
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(backgroundThreadRef),
                    });
                  },
                },
              }),
            );
          }
        } else if (
          submissionIntent === "background" &&
          currentRouteThreadKeyRef.current === routeThreadKey
        ) {
          handleNewThreadInActiveProject();
        }
      }
    }

    if (failure !== null) {
      if (isLocalDraftThread && draftId && draftThread) {
        restoreFailedDraftThread(
          draftId,
          draftThread,
          wasBootstrapThreadDeleted(squashAtomCommandFailure(failure))
            ? newThreadId()
            : threadIdForSend,
        );
        clearBackgroundDraftSubmissionByRef(scopeThreadRef(environmentId, threadIdForSend));
      }
      const dropOptimisticSendMessage = () =>
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
      if (!sentDraftCleared) {
        // The draft never left the composer; only the optimistic row goes.
        dropOptimisticSendMessage();
      } else if (
        !composerDraftHasUserContent(
          useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
        )
      ) {
        dropOptimisticSendMessage();
        const retryComposerImages = restoreComposerDraft(
          composerDraftTarget,
          sendSnapshot,
          inputOriginForSend,
        );
        if (currentRouteThreadKeyRef.current === routeThreadKey) {
          promptRef.current = messageTextForSend;
          composerImagesRef.current = retryComposerImages;
          composerFilesRef.current = composerFilesSnapshot;
          composerTerminalContextsRef.current = composerTerminalContextsSnapshot;
          composerRef.current?.resetCursorState({
            cursor: collapseExpandedComposerCursor(messageTextForSend, messageTextForSend.length),
            prompt: messageTextForSend,
            detectTrigger: true,
          });
        }
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Failed to send message.",
        );
        if (
          draftId &&
          (backgroundDraftOpened || currentRouteThreadKeyRef.current !== routeThreadKey)
        ) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title:
                submissionIntent === "background"
                  ? "Background task failed"
                  : "Could not start thread",
              description: error instanceof Error ? error.message : "Failed to send message.",
              actionProps: {
                children: "Open draft",
                onClick: () => {
                  void navigate({ to: "/draft/$draftId", params: { draftId } });
                },
              },
            }),
          );
        }
      }
    }
    sendInFlightRef.current = false;
    if (draftId) {
      draftSubmissionTracker.finish(draftId, turnStartSucceeded);
    }
    setSetupQueueSendThreadKey((current) => (current === activeThreadKey ? null : current));
    if (!turnStartSucceeded) {
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      if (!sendQueuesBehindSetup) resetLocalDispatch();
    }
  };

  return { onSend };
}
