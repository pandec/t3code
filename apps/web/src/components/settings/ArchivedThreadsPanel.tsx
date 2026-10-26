import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import { Spinner } from "~/components/ui/spinner";
import { ArchiveIcon, ArchiveX, BotIcon, SearchIcon, XIcon } from "lucide-react";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useSettingsScope } from "./SettingsScopeContext";
import { useThreadActions } from "../../hooks/useThreadActions";
import { readLocalApi } from "../../localApi";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  archivedThreadGroupMatchesScope,
  archivedThreadMatchesScope,
  resolveArchivedThreadScopeFilter,
  shouldDeferArchivedEmptyState,
} from "../../archivedProjectFilter";
import { archivedThreadMatchesSearch } from "./SettingsPanels.logic";
import { buildArchivedThreadGroups } from "../../archivedThreadGrouping";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { projectAccentTintStyle } from "../../projectAccentTint";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { serverEnvironment } from "../../state/server";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useAccentTintSettings, useClientSettings } from "../../hooks/useSettings";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../../state/entities";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { useProjectAccentColors } from "../../hooks/useProjectAccentColors";

function ArchivedThreadModelIcon({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(thread.environmentId));
  const providerInstance = deriveProviderInstanceEntries(serverConfig?.providers ?? []).find(
    (entry) => entry.instanceId === thread.modelSelection.instanceId,
  );
  const label = providerInstance
    ? `${providerInstance.displayName}, ${thread.modelSelection.model}`
    : `Model ${thread.modelSelection.model}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            tabIndex={0}
            aria-label={label}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        {providerInstance ? (
          <ProviderInstanceIcon
            driverKind={providerInstance.driverKind}
            displayName={providerInstance.displayName}
            accentColor={providerInstance.accentColor}
            iconClassName="size-3.5"
          />
        ) : (
          <BotIcon className="size-3.5" aria-hidden />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function ArchivedThreadsPanel() {
  const { scope } = useSettingsScope();
  const { environments, isReady: environmentsReady } = useEnvironments();
  const environmentShellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const primaryEnvironment = usePrimaryEnvironment();
  const projects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectAccentColors = useProjectAccentColors();
  const accentTint = useAccentTintSettings();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scopeFilter = resolveArchivedThreadScopeFilter(scope);
  const selectedProjectLabel = scopeFilter?.label ?? "selected project";
  // A scope pinned to one environment only asks that environment, so another
  // machine's outage or slow load cannot mark this view failed or pending.
  const scopedEnvironmentId = scopeFilter?.environmentId ?? null;
  const environmentIds =
    scopedEnvironmentId === null
      ? environments.map((environment) => environment.environmentId)
      : [scopedEnvironmentId];
  const environmentLabelById = new Map(
    environments.map((environment) => {
      const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
      return [
        environment.environmentId,
        secondary ? `${primary} (${secondary})` : primary,
      ] as const;
    }),
  );
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(environmentIds);

  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const archivedGroups = buildArchivedThreadGroups({
    groupingSettings,
    primaryEnvironmentId,
    projects,
    resolveEnvironmentLabel: (environmentId) =>
      environmentLabelById.get(environmentId) ??
      (environmentId === primaryEnvironmentId ? "Local" : "Remote"),
    snapshots: archivedSnapshots,
  });
  const filteredArchivedGroups = archivedGroups.flatMap((group) => {
    if (!archivedThreadGroupMatchesScope(group, scopeFilter)) {
      return [];
    }
    const matchingThreads = group.threads.filter(
      ({ environmentLabel, project, thread }) =>
        archivedThreadMatchesScope({ project, thread }, scopeFilter) &&
        archivedThreadMatchesSearch(
          {
            environmentLabel,
            modelName: thread.modelSelection.model,
            projectName: `${group.displayName} ${project.title}`,
            projectCwd: project.workspaceRoot,
            threadTitle: thread.title,
          },
          searchQuery,
        ),
    );
    return matchingThreads.length > 0 ? [{ ...group, threads: matchingThreads }] : [];
  });
  const matchingThreadCount = filteredArchivedGroups.reduce(
    (count, group) => count + group.threads.length,
    0,
  );
  const hasSearchQuery = searchQuery.trim().length > 0;
  const hasProjectFilter = scopeFilter !== null;
  const hasActiveFilter = hasSearchQuery || hasProjectFilter;
  const archiveSourcesReady = environmentsReady && environmentShellsBootstrapped;
  const isLoadingArchiveSources = !archiveSourcesReady || isLoadingArchive;
  const shouldDeferEmptyState = shouldDeferArchivedEmptyState({
    hasMatchingGroups: filteredArchivedGroups.length > 0,
    isLoading: isLoadingArchiveSources,
    hasError: archiveError !== null,
  });

  // oxlint-disable-next-line t3code/react-effect-budget -- window Mod+F focuses the search
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isMod = event.metaKey || event.ctrlKey;
      if (event.defaultPrevented || !isMod || event.altKey || event.key.toLowerCase() !== "f") {
        return;
      }

      const target = event.target;
      if (
        target !== searchInputRef.current &&
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }

      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleArchivedThreadContextMenu = async (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(
      [
        { id: "unarchive", label: "Unarchive" },
        { id: "delete", label: "Delete", destructive: true },
      ],
      position,
    );

    if (clicked === "unarchive") {
      const result = await unarchiveThread(threadRef);
      if (result._tag === "Success") {
        refreshArchivedThreads();
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to unarchive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return;
    }

    if (clicked === "delete") {
      const result = await confirmAndDeleteThread(threadRef);
      if (result._tag === "Success") {
        refreshArchivedThreads();
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    }
  };

  return (
    <SettingsPageContainer>
      <div className="space-y-1.5">
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && searchQuery.length > 0) {
                event.preventDefault();
                event.stopPropagation();
                setSearchQuery("");
              }
            }}
            placeholder="Search archived threads"
            aria-label="Search archived threads"
            aria-describedby="archived-thread-search-status"
            className="h-9 w-full rounded-lg border border-input bg-background pr-9 pl-9 text-sm text-foreground shadow-xs/5 outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/24 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
          />
          {searchQuery.length > 0 ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="absolute top-1/2 right-2 size-6 -translate-y-1/2"
              onClick={() => {
                setSearchQuery("");
                searchInputRef.current?.focus({ preventScroll: true });
              }}
              aria-label="Clear archived thread search"
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
        <p
          id="archived-thread-search-status"
          className="min-h-4 px-1 text-2xs text-muted-foreground"
          aria-live={isLoadingArchiveSources || archiveError !== null ? "off" : "polite"}
        >
          {isLoadingArchiveSources
            ? `Loading archived threads${hasProjectFilter ? ` in ${selectedProjectLabel}` : ""}…`
            : archiveError !== null && filteredArchivedGroups.length === 0
              ? `Archived thread results${hasProjectFilter ? ` in ${selectedProjectLabel}` : ""} may be incomplete`
              : hasActiveFilter
                ? `${matchingThreadCount} ${matchingThreadCount === 1 ? "thread" : "threads"}${
                    hasSearchQuery ? " found" : ""
                  }${hasProjectFilter ? ` in ${selectedProjectLabel}` : ""}`
                : "Press Command+F or Ctrl+F to focus search."}
        </p>
      </div>

      {archiveError && archivedGroups.length > 0 ? (
        <SettingsSection title="Archive availability" role="status">
          <SettingsRow
            title="Some archived threads could not be loaded"
            description="One or more environments are unavailable. The results below may be incomplete."
          />
        </SettingsSection>
      ) : null}

      {archivedGroups.length === 0 ? (
        <SettingsSection
          id={isLoadingArchive ? undefined : searchableSetting("archive").id}
          title={searchableSetting("archive").title}
          role={archiveError ? "alert" : "status"}
        >
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchiveSources ? (
                  <Spinner size="sm" tone="muted" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchiveSources
                  ? "Loading archived threads"
                  : archiveError
                    ? "Could not load archived threads"
                    : "No archived threads"}
              </span>
            }
            description={
              isLoadingArchiveSources
                ? "Checking connected environments."
                : (archiveError ?? "Archived threads will appear here.")
            }
          />
        </SettingsSection>
      ) : shouldDeferEmptyState ? (
        <SettingsSection
          title="Archived threads"
          role={archiveError === null ? "status" : undefined}
        >
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchiveSources ? (
                  <Spinner size="sm" tone="muted" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchiveSources
                  ? `Loading archived threads${hasProjectFilter ? ` in ${selectedProjectLabel}` : ""}`
                  : `Archived threads${hasProjectFilter ? ` in ${selectedProjectLabel}` : ""} may be unavailable`}
              </span>
            }
            description={
              isLoadingArchiveSources
                ? "Checking connected environments."
                : "One or more environments could not be loaded, so this result may be incomplete."
            }
          />
        </SettingsSection>
      ) : filteredArchivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads">
          <SettingsRow
            title={
              hasProjectFilter
                ? `No archived threads in ${selectedProjectLabel}`
                : "No matching archived threads"
            }
            description={
              hasProjectFilter && !hasSearchQuery
                ? "Widen the scope above or choose another project or environment."
                : "Try a different thread title, project, or workspace path."
            }
          />
        </SettingsSection>
      ) : (
        filteredArchivedGroups.map((group, index) => {
          const isCollapsed = !hasActiveFilter && collapsedProjectKeys.has(group.key);
          const accentStyle = accentTint.enabled
            ? projectAccentTintStyle(
                projectAccentColors.resolve(group.projects),
                accentTint.intensityPercent,
              )
            : undefined;
          return (
            <SettingsSection
              key={group.key}
              id={index === 0 ? searchableSetting("archive").id : undefined}
              title={group.displayName}
              collapsed={isCollapsed}
              onToggleCollapsed={
                hasActiveFilter
                  ? undefined
                  : () => {
                      setCollapsedProjectKeys((current) => {
                        const next = new Set(current);
                        if (next.has(group.key)) {
                          next.delete(group.key);
                        } else {
                          next.add(group.key);
                        }
                        return next;
                      });
                    }
              }
              icon={<ProjectFavicon project={group.representativeProject} />}
            >
              {group.threads.map(({ environmentLabel, thread }) => {
                const threadRef = scopeThreadRef(thread.environmentId, thread.id);
                return (
                  <SettingsRow
                    key={`${thread.environmentId}:${thread.id}`}
                    style={accentStyle}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      void (async () => {
                        const result = await settlePromise(() =>
                          handleArchivedThreadContextMenu(threadRef, {
                            x: event.clientX,
                            y: event.clientY,
                          }),
                        );
                        if (result._tag === "Failure") {
                          const error = squashAtomCommandFailure(result);
                          toastManager.add(
                            stackedThreadToast({
                              type: "error",
                              title: "Archived thread action failed",
                              description:
                                error instanceof Error ? error.message : "An error occurred.",
                            }),
                          );
                        }
                      })();
                    }}
                    title={
                      <span className="inline-flex min-w-0 items-center gap-2">
                        <ArchivedThreadModelIcon thread={thread} />
                        <span className="truncate">{thread.title}</span>
                      </span>
                    }
                    description={
                      <>
                        {environmentLabel}
                        {" \u00b7 "}
                        {thread.modelSelection.model}
                        {" \u00b7 Archived "}
                        <RelativeTime timestamp={thread.archivedAt ?? thread.createdAt} />
                        {" \u00b7 Created "}
                        <RelativeTime timestamp={thread.createdAt} />
                      </>
                    }
                    control={
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0 cursor-pointer"
                        onClick={() => {
                          void (async () => {
                            const result = await unarchiveThread(threadRef);
                            if (result._tag === "Success") {
                              refreshArchivedThreads();
                              return;
                            }
                            if (!isAtomCommandInterrupted(result)) {
                              const error = squashAtomCommandFailure(result);
                              toastManager.add(
                                stackedThreadToast({
                                  type: "error",
                                  title: "Failed to unarchive thread",
                                  description:
                                    error instanceof Error ? error.message : "An error occurred.",
                                }),
                              );
                            }
                          })();
                        }}
                      >
                        <ArchiveX className="size-3.5" />
                        <span>Unarchive</span>
                      </Button>
                    }
                  />
                );
              })}
            </SettingsSection>
          );
        })
      )}
    </SettingsPageContainer>
  );
}
