import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";

import { useClientSettings } from "../hooks/useSettings";
import type { SidebarProjectAccentColor } from "@t3tools/contracts/settings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { useThreadShells } from "../state/entities";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { useThreadSearch } from "../state/queries";
import { primaryServerProvidersAtom } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";
import { openThreadInActivePane } from "./thread-split/threadOpenTarget";
import { paletteOwnerPane, requestThreadPaneFocus } from "./thread-split/threadSplitStore";
import { buildThreadActionItems, ITEM_ICON_CLASS } from "./CommandPalette.logic";
import { useEnvironmentLookups, useProjectLookups } from "./CommandPaletteLookups";
import { ThreadCommandSubtitle } from "./ThreadCommandSubtitle";
import {
  ThreadRowLeadingStatus,
  ThreadRowTrailingStatus,
  ThreadSearchPullRequestNumber,
} from "./ThreadStatusIndicators";

function useProviderEntryByEnvironmentAndInstanceId() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const providersByEnvironment = useEnvironmentProviders();
  return new Map<string, ProviderInstanceEntry>(
    environments.flatMap((environment) => {
      const serverConfig = environment.serverConfig;
      const derived = deriveProviderInstanceEntries(
        providersByEnvironment.get(environment.environmentId) ??
          (environment.environmentId === primaryEnvironmentId ? providers : []),
      );
      const entries = serverConfig
        ? applyProviderInstanceSettings(derived, serverConfig.settings, null)
        : derived;
      return entries.map(
        (entry) => [`${environment.environmentId}:${entry.instanceId}`, entry] as const,
      );
    }),
  );
}

function useThreadSearchWithContentMatches(query: string) {
  const { environments } = useEnvironments();
  const environmentIds: ReadonlyArray<EnvironmentId> = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId);
  const threadSearch = useThreadSearch(environmentIds, query);
  const contentMatchByKey = new Map(
    threadSearch.matches.flatMap((match) =>
      match.source === "user" || match.source === "assistant"
        ? [[threadSearchMatchKey(match), match] as const]
        : [],
    ),
  );
  return { threadSearch, contentMatchByKey };
}

/** Every thread as a palette item, with message matches for a non-empty `threadSearchQuery`. */
export function useCommandPaletteThreadItems(input: {
  /** Scoped `environmentId:threadId`: bare thread ids can collide across environments. */
  readonly activeThreadKey: string | undefined;
  readonly threadSearchQuery: string;
  readonly routeThreadRef: ScopedThreadRef | null;
  readonly projectAccentColorByKey: ReadonlyMap<string, SidebarProjectAccentColor>;
}) {
  const { activeThreadKey, threadSearchQuery, routeThreadRef, projectAccentColorByKey } = input;
  const navigate = useNavigate();
  const threads = useThreadShells();
  const sidebarThreadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const { projectEnvironmentLocationById } = useEnvironmentLookups();
  const providerEntryByEnvironmentAndInstanceId = useProviderEntryByEnvironmentAndInstanceId();
  const { threadSearch, contentMatchByKey } = useThreadSearchWithContentMatches(threadSearchQuery);
  const { projectByKey, projectTitleByKey } = useProjectLookups();

  const threadItems = buildThreadActionItems({
    threads,
    ...(activeThreadKey ? { activeThreadKey } : {}),
    projectTitleByKey,
    sortOrder: sidebarThreadSortOrder,
    icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
    renderLeadingContent: (thread) => <ThreadRowLeadingStatus thread={thread} />,
    renderTrailingContent: (thread) => (
      <>
        <ThreadSearchPullRequestNumber
          thread={thread}
          query={threadSearchQuery}
          settled={thread.settledOverride === "settled"}
        />
        <ThreadRowTrailingStatus thread={thread} />
      </>
    ),
    projectAccentColor: (thread) =>
      projectAccentColorByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
    renderDescription: (thread, { projectTitle }) => {
      const modelInstanceId =
        thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
      const providerEntry =
        providerEntryByEnvironmentAndInstanceId.get(`${thread.environmentId}:${modelInstanceId}`) ??
        null;
      return (
        <ThreadCommandSubtitle
          project={projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null}
          projectTitle={projectTitle ?? null}
          environmentLabel={
            projectEnvironmentLocationById.get(thread.environmentId)?.label ?? "Remote"
          }
          branch={thread.branch}
          worktreePath={thread.worktreePath}
          isCurrent={`${thread.environmentId}:${thread.id}` === activeThreadKey}
          driverKind={providerEntry?.driverKind ?? null}
          providerDisplayName={
            thread.runtime?.providerName ?? providerEntry?.displayName ?? modelInstanceId
          }
          acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
          acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
        />
      );
    },
    getContentMatch: (thread) => {
      const match = contentMatchByKey.get(
        threadSearchMatchKey({
          environmentId: thread.environmentId,
          threadId: thread.id,
        }),
      );
      return match && (match.source === "user" || match.source === "assistant")
        ? {
            source: match.source,
            snippet: match.snippet,
            query: threadSearch.query,
          }
        : undefined;
    },
    runThread: async (thread) => {
      const targetRef = scopeThreadRef(thread.environmentId, thread.id);
      const { plan, completion } = openThreadInActivePane({
        targetRef,
        routeThreadRef,
        paneOverride: paletteOwnerPane(),
        navigateToPrimary: () =>
          navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(targetRef),
          }),
      });
      if (plan.kind === "open-secondary") {
        // The closing palette restores focus to its trigger a beat later;
        // the intent bounces that restore into the pane just opened.
        requestThreadPaneFocus("secondary");
      }
      // Awaited so a navigation rejection still reaches the palette's
      // run-command error handling, as it did before the split routing.
      if (completion) await completion;
    },
  });

  return { threadItems, isSearchPending: threadSearch.isPending };
}
