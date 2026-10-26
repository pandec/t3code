import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type ScopedProjectRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import {
  composerDraftHasUserContent,
  markPromotedDraftThreadByRef,
  type DraftId,
  type DraftLabIntent,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { shouldDefaultToLabMode } from "../components/labs/labs.logic";
import { loadLabsInventory } from "../state/labs";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  selectProjectGroupingSettings,
  type ProjectGroupingSettings,
} from "../logicalProject";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  readProject,
  readProjects,
  readThreadShell,
  readThreadShells,
  useProjects,
  useQuietThreadShell,
} from "../state/entities";
import {
  hasExplicitComposerModelSelection,
  resolveNewDraftStartFromOrigin,
} from "../lib/chatThreadActions";
import { readT3ProjectFile } from "../lib/t3ProjectFileDefaults";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "../state/presentation";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";
import { useThreadRouteTarget } from "./useThreadRouteTarget";
import { readUnloadedThreadCount } from "../state/olderSettledShelf";

/**
 * Precedence, lowest to highest: per-provider sticky memory; the project's
 * `defaultModelSelection` (options merge, so sticky effort/context still apply); the
 * viewed thread's carried selection, only within the same logical project. A draft in
 * another project never inherits the previous project's model.
 */
export function seedNewDraftModelState(input: {
  draftId: DraftId;
  logicalProjectKey: string;
  projectDefaultModelSelection: ModelSelection | null;
  carryModelSelection: ModelSelection | null;
  carrySourceLogicalProjectKey: string | null;
}): void {
  const { applyStickyState, setModelSelection } = useComposerDraftStore.getState();
  applyStickyState(input.draftId);
  if (input.projectDefaultModelSelection) {
    setModelSelection(input.draftId, input.projectDefaultModelSelection);
  }
  const carryIsSameLogicalProject = input.carrySourceLogicalProjectKey === input.logicalProjectKey;
  if (input.carryModelSelection && carryIsSameLogicalProject) {
    // After sticky state and the project default so the viewed thread's exact
    // selection (model + options like effort and context window) wins.
    // replaceOptions: the carried selection is a complete snapshot — absent
    // options mean "no options", not "keep whatever was just seeded".
    setModelSelection(input.draftId, input.carryModelSelection, { replaceOptions: true });
  }
}

/**
 * Same carry rule as seedNewDraftModelState, for a reused empty draft: the carry
 * applies only within its own logical project. A reused draft is already seeded, so
 * nothing is written when the carry does not apply.
 */
export function applyCarryModelSelectionToReusedDraft(input: {
  draftId: DraftId;
  logicalProjectKey: string;
  carryModelSelection: ModelSelection | null;
  carrySourceLogicalProjectKey: string | null;
}): void {
  if (!input.carryModelSelection) return;
  if (input.carrySourceLogicalProjectKey !== input.logicalProjectKey) return;
  // The carried selection is a complete snapshot of the viewed thread's
  // model state: absent options mean "no options", not "keep the stale
  // draft's options".
  useComposerDraftStore.getState().setModelSelection(input.draftId, input.carryModelSelection, {
    replaceOptions: true,
  });
}

/**
 * The carry may out-rank the target project's default only within the same logical
 * project. Draft sources record their logical project key; server threads resolve it
 * through the project list, falling back to the scoped key when the project is unloaded.
 */
export function resolveCarrySourceLogicalProjectKey(input: {
  carrySourceDraftLogicalProjectKey: string | null;
  carrySourceShellProjectRef: ScopedProjectRef | null;
  projects: ReadonlyArray<
    Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity">
  >;
  projectGroupingSettings: ProjectGroupingSettings;
}): string | null {
  if (input.carrySourceDraftLogicalProjectKey !== null) {
    return input.carrySourceDraftLogicalProjectKey;
  }
  const carrySourceProjectRef = input.carrySourceShellProjectRef;
  if (!carrySourceProjectRef) {
    return null;
  }
  const carrySourceProject = input.projects.find(
    (candidate) =>
      candidate.id === carrySourceProjectRef.projectId &&
      candidate.environmentId === carrySourceProjectRef.environmentId,
  );
  return carrySourceProject
    ? deriveLogicalProjectKeyFromSettings(carrySourceProject, input.projectGroupingSettings)
    : scopedProjectKey(carrySourceProjectRef);
}

interface NewThreadWorkspaceOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  startFromOrigin?: boolean;
  /** Fork (SP Labs): the lab a Lab-mode draft targets. */
  lab?: DraftLabIntent | null;
}

function pickExplicitWorkspaceOptions(options: NewThreadWorkspaceOptions | undefined) {
  return {
    ...(options?.branch !== undefined ? { branch: options.branch } : {}),
    ...(options?.worktreePath !== undefined ? { worktreePath: options.worktreePath } : {}),
    ...(options?.envMode !== undefined ? { envMode: options.envMode } : {}),
    ...(options?.startFromOrigin !== undefined ? { startFromOrigin: options.startFromOrigin } : {}),
    ...(options?.lab !== undefined ? { lab: options.lab } : {}),
  };
}

export function useNewThreadHandler() {
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const router = useRouter();
  const getCurrentRouteTarget = () => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  };

  return (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      lab?: DraftLabIntent | null;
      /** Custom group the new thread joins on first send; null is Active.
       * Absent keeps whatever the reused draft already holds. */
      customGroupId?: string | null;
      replace?: boolean;
    },
  ): Promise<{ draftId: DraftId; threadId: ThreadId } | null> => {
    const projects = readProjects();
    // Read at call time; status pushes replace the config map and would recreate every sidebar handler.
    const environmentServerConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    const targetServerSettings =
      environmentServerConfigs.get(projectRef.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
    const {
      getComposerDraft,
      getDraftSessionByLogicalProjectKey,
      getDraftSession,
      getDraftThread,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
    } = useComposerDraftStore.getState();
    const requestingRouteHref = router.state.location.href;
    const routeChangedSinceRequest = () => router.state.location.href !== requestingRouteHref;
    const currentRouteTarget = getCurrentRouteTarget();
    // A new thread carries the viewed thread's model (over the project default only in the
    // same logical project) and interaction mode. Permissions, branch, worktree, and env
    // mode come from configured defaults unless explicitly passed.
    const carrySourceShell =
      currentRouteTarget?.kind === "server" ? readThreadShell(currentRouteTarget.threadRef) : null;
    const carrySourceDraft =
      currentRouteTarget?.kind === "draft" ? getDraftSession(currentRouteTarget.draftId) : null;
    const carrySourceComposer = currentRouteTarget
      ? getComposerDraft(
          currentRouteTarget.kind === "server"
            ? currentRouteTarget.threadRef
            : currentRouteTarget.draftId,
        )
      : null;
    const composerActiveProvider = carrySourceComposer?.activeProvider ?? null;
    const composerModelSelection = composerActiveProvider
      ? (carrySourceComposer?.modelSelectionByProvider[composerActiveProvider] ?? null)
      : null;
    const carryModelSelection = composerModelSelection ?? carrySourceShell?.modelSelection ?? null;
    const carryInteractionMode =
      carrySourceComposer?.interactionMode ??
      carrySourceShell?.interactionMode ??
      carrySourceDraft?.interactionMode ??
      null;
    const project = projects.find(
      (candidate) =>
        candidate.id === projectRef.projectId &&
        candidate.environmentId === projectRef.environmentId,
    );
    const abandonedSinceRequest = () =>
      routeChangedSinceRequest() || (project !== undefined && readProject(projectRef) === null);
    const projectSettings = resolveProjectSettings(
      targetServerSettings,
      project?.id ?? null,
      project,
    );
    const projectDefaultModelSelection = projectSettings.settings.defaultModelSelection ?? null;
    const defaultRuntimeMode = projectSettings.settings.defaultRuntimeMode;
    const resolveDefaultEnvMode = async (): Promise<DraftThreadEnvMode> => {
      // Fork (SP Labs): "Default to Lab mode" wins, but only in the labs project and only while
      // SP Labs resolves; the inventory carries both the resolved state and project.
      if (
        targetServerSettings.labs.defaultToLabMode &&
        targetServerSettings.labs.spLabsDirectory !== "" &&
        project !== undefined
      ) {
        const inventory = await loadLabsInventory(projectRef.environmentId);
        if (
          shouldDefaultToLabMode({
            defaultToLabMode: true,
            configured: inventory?.configured === true,
            labsProjectId: inventory?.projectId ?? null,
            projectId: project.id,
          })
        ) {
          return "lab";
        }
      }
      // Environment queries wait for a connection, so reading the project file on an
      // offline machine would never settle and the draft would never open.
      const consultProjectFile =
        project !== undefined &&
        projectSettings.settings.defaultThreadEnvMode === null &&
        appAtomRegistry
          .get(environmentSummaries.connectedEnvironmentIdsAtom)
          .includes(project.environmentId);
      const projectFile = consultProjectFile
        ? await readT3ProjectFile(project.environmentId, project.workspaceRoot)
        : null;
      return resolveNewThreadEnvMode({
        projectSettings: resolveProjectSettings(
          targetServerSettings,
          project?.id ?? null,
          project,
          projectFile,
        ),
        workspaceRoot: project?.workspaceRoot ?? null,
        newProjectsRoot: environmentServerConfigs.get(projectRef.environmentId)?.newProjectsRoot,
        projectHasThreads:
          readThreadShells().some(
            (thread) =>
              thread.environmentId === projectRef.environmentId &&
              thread.projectId === projectRef.projectId,
          ) ||
          readUnloadedThreadCount(
            [{ environmentId: projectRef.environmentId, id: projectRef.projectId }],
            [],
          ) > 0,
      });
    };
    const logicalProjectKey = project
      ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
      : scopedProjectKey(projectRef);
    const carrySourceLogicalProjectKey = resolveCarrySourceLogicalProjectKey({
      carrySourceDraftLogicalProjectKey: carrySourceDraft?.logicalProjectKey ?? null,
      carrySourceShellProjectRef: carrySourceShell
        ? scopeProjectRef(carrySourceShell.environmentId, carrySourceShell.projectId)
        : null,
      projects,
      projectGroupingSettings,
    });
    const hasBranchOption = options?.branch !== undefined;
    const hasWorktreePathOption = options?.worktreePath !== undefined;
    const hasEnvModeOption = options?.envMode !== undefined;
    const hasStartFromOriginOption = options?.startFromOrigin !== undefined;
    const hasLabOption = options?.lab !== undefined;
    // A group pick belongs to the unsent draft, like its branch and env mode: returning
    // to that draft keeps it, and only an explicit option or the picker changes it. A
    // promoted draft is left behind, so the next draft starts in Active.
    const customGroupFields =
      options?.customGroupId === undefined ? {} : { customGroupId: options.customGroupId };
    const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
    const storedDraftThreadRef = storedDraftThread
      ? scopeThreadRef(storedDraftThread.environmentId, storedDraftThread.threadId)
      : null;
    const reusableStoredDraftThread =
      storedDraftThread !== null &&
      storedDraftThread.promotedTo == null &&
      storedDraftThreadRef !== null &&
      readThreadShell(storedDraftThreadRef) === null
        ? storedDraftThread
        : null;
    if (storedDraftThreadRef && reusableStoredDraftThread === null) {
      markPromotedDraftThreadByRef(storedDraftThreadRef);
    }
    const emptyStoredDraftThread =
      reusableStoredDraftThread &&
      !composerDraftHasUserContent(getComposerDraft(reusableStoredDraftThread.draftId))
        ? reusableStoredDraftThread
        : null;
    const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
      ? currentRouteTarget.kind === "server"
        ? getDraftThread(currentRouteTarget.threadRef)
        : getDraftSession(currentRouteTarget.draftId)
      : null;
    if (emptyStoredDraftThread) {
      return (async () => {
        const isDraftAlreadyOpen =
          currentRouteTarget?.kind === "draft" &&
          currentRouteTarget.draftId === emptyStoredDraftThread.draftId;
        const hasExplicitWorkspaceOption =
          hasBranchOption ||
          hasWorktreePathOption ||
          hasEnvModeOption ||
          hasStartFromOriginOption ||
          hasLabOption;
        let workspaceContext: NewThreadWorkspaceOptions | null = null;
        if (hasExplicitWorkspaceOption) {
          workspaceContext = pickExplicitWorkspaceOptions(options);
        } else if (!isDraftAlreadyOpen) {
          const defaultEnvMode = await resolveDefaultEnvMode();
          if (abandonedSinceRequest()) {
            return null;
          }
          // Concurrent calls may change the draft; stale resets, remaps, or navigation could clobber it.
          const routeTargetNow = getCurrentRouteTarget();
          const openedMeanwhile =
            routeTargetNow?.kind === "draft" &&
            routeTargetNow.draftId === emptyStoredDraftThread.draftId;
          const promotedMeanwhile =
            storedDraftThreadRef !== null && readThreadShell(storedDraftThreadRef) !== null;
          const remappedMeanwhile =
            getDraftSessionByLogicalProjectKey(logicalProjectKey)?.draftId !==
            emptyStoredDraftThread.draftId;
          const investedMeanwhile = composerDraftHasUserContent(
            getComposerDraft(emptyStoredDraftThread.draftId),
          );
          if (openedMeanwhile || promotedMeanwhile || remappedMeanwhile || investedMeanwhile) {
            return null;
          }
          workspaceContext = {
            branch: null,
            worktreePath: null,
            envMode: defaultEnvMode,
            startFromOrigin: resolveNewDraftStartFromOrigin({
              envMode: defaultEnvMode,
              newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
            }),
          };
        }
        if (workspaceContext) {
          setDraftThreadContext(emptyStoredDraftThread.draftId, {
            ...workspaceContext,
            ...(!isDraftAlreadyOpen ? { runtimeMode: defaultRuntimeMode } : {}),
            ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
          });
        }
        // An explicit human pick always stands; anything else re-resolves here (sticky,
        // project default, then a same-project carry) even when the draft is already
        // open, or a changed pin could never reach the draft on screen.
        const storedDraft = getComposerDraft(emptyStoredDraftThread.draftId);
        const storedDraftHasExplicitModelPick = hasExplicitComposerModelSelection(storedDraft);
        if (!storedDraftHasExplicitModelPick) {
          seedNewDraftModelState({
            draftId: emptyStoredDraftThread.draftId,
            logicalProjectKey,
            projectDefaultModelSelection,
            carryModelSelection,
            carrySourceLogicalProjectKey,
          });
        }
        // Remapping physical projects clears workspace context; preserve the branch and worktree.
        setLogicalProjectDraftThreadId(
          logicalProjectKey,
          projectRef,
          emptyStoredDraftThread.draftId,
          {
            threadId: emptyStoredDraftThread.threadId,
            ...workspaceContext,
            ...(!isDraftAlreadyOpen ? { runtimeMode: defaultRuntimeMode } : {}),
            ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
            ...customGroupFields,
          },
        );
        const opened = {
          draftId: emptyStoredDraftThread.draftId,
          threadId: emptyStoredDraftThread.threadId,
        };
        const routeTargetAfterWrites = getCurrentRouteTarget();
        if (
          routeTargetAfterWrites?.kind === "draft" &&
          routeTargetAfterWrites.draftId === emptyStoredDraftThread.draftId
        ) {
          return opened;
        }
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId: emptyStoredDraftThread.draftId },
          replace: options?.replace ?? false,
        });
        return opened;
      })();
    }

    if (
      latestActiveDraftThread &&
      currentRouteTarget?.kind === "draft" &&
      latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
      latestActiveDraftThread.promotedTo == null &&
      !composerDraftHasUserContent(getComposerDraft(currentRouteTarget.draftId))
    ) {
      if (
        hasBranchOption ||
        hasWorktreePathOption ||
        hasEnvModeOption ||
        hasStartFromOriginOption ||
        hasLabOption
      ) {
        setDraftThreadContext(currentRouteTarget.draftId, pickExplicitWorkspaceOptions(options));
      }
      setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
        threadId: latestActiveDraftThread.threadId,
        createdAt: latestActiveDraftThread.createdAt,
        runtimeMode: latestActiveDraftThread.runtimeMode,
        interactionMode: latestActiveDraftThread.interactionMode,
        ...pickExplicitWorkspaceOptions(options),
        ...customGroupFields,
      });
      return Promise.resolve({
        draftId: currentRouteTarget.draftId,
        threadId: latestActiveDraftThread.threadId,
      });
    }

    const draftId = newDraftId();
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    return (async () => {
      const initialEnvMode = options?.envMode ?? (await resolveDefaultEnvMode());
      if (abandonedSinceRequest()) {
        return null;
      }
      // Reuse drafts registered while awaiting so their pending navigation cannot lose them.
      const racedDraft = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      if (
        racedDraft &&
        racedDraft.draftId !== storedDraftThread?.draftId &&
        readThreadShell(scopeThreadRef(racedDraft.environmentId, racedDraft.threadId)) === null
      ) {
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, racedDraft.draftId, {
          threadId: racedDraft.threadId,
          createdAt: racedDraft.createdAt,
          runtimeMode: racedDraft.runtimeMode,
          interactionMode: racedDraft.interactionMode,
          ...pickExplicitWorkspaceOptions(options),
          ...customGroupFields,
        });
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId: racedDraft.draftId },
          replace: options?.replace ?? false,
        });
        return { draftId: racedDraft.draftId, threadId: racedDraft.threadId };
      }
      setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
        threadId,
        createdAt,
        branch: options?.branch ?? null,
        worktreePath: options?.worktreePath ?? null,
        envMode: initialEnvMode,
        startFromOrigin:
          options?.startFromOrigin ??
          resolveNewDraftStartFromOrigin({
            envMode: initialEnvMode,
            newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
          }),
        ...(options?.lab !== undefined ? { lab: options.lab } : {}),
        runtimeMode: defaultRuntimeMode,
        ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
        ...customGroupFields,
      });
      seedNewDraftModelState({
        draftId,
        logicalProjectKey,
        projectDefaultModelSelection,
        carryModelSelection,
        carrySourceLogicalProjectKey,
      });
      await router.navigate({
        to: "/draft/$draftId",
        params: { draftId },
        replace: options?.replace ?? false,
      });
      return { draftId, threadId };
    })();
  };
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useThreadRouteTarget();
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const activeThread = useQuietThreadShell(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const handleNewThread = useNewThreadHandler();
  const [defaultProject] = orderItemsByPreferredIds({
    items: projects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  const defaultProjectRef = defaultProject
    ? scopeProjectRef(defaultProject.environmentId, defaultProject.id)
    : null;

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    handleNewThread,
    routeDraftId,
    routeThreadRef,
  };
}
