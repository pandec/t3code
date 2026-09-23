import type { EnvironmentId, SidebarProjectGroupingMode } from "@t3tools/contracts";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
  type Dispatch,
  type SetStateAction,
} from "react";

export interface HomeListOptions {
  readonly selectedEnvironmentId: EnvironmentId | null;
  /** Model slug the list is pinned to (`thread.modelSelection.model`). */
  readonly selectedModel: string | null;
}

export interface ResolvedHomeListOptions extends HomeListOptions {
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

function defaultHomeListOptions(): HomeListOptions {
  return {
    selectedEnvironmentId: null,
    selectedModel: null,
  };
}

interface HomeListOptionsContextValue {
  readonly options: HomeListOptions;
  readonly setOptions: Dispatch<SetStateAction<HomeListOptions>>;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

const HomeListOptionsContext = createContext<HomeListOptionsContextValue | null>(null);

/** Keeps list preferences stable while the app moves between compact and split shells. */
export function HomeListOptionsProvider({
  children,
  projectGroupingMode,
}: PropsWithChildren<{
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}>) {
  const [options, setOptions] = useState<HomeListOptions>(defaultHomeListOptions);
  const value = useMemo(
    () => ({ options, setOptions, projectGroupingMode }),
    [options, projectGroupingMode],
  );
  return createElement(HomeListOptionsContext, { value }, children);
}

/** True when an environment, project, or model narrows the list. */
export function hasActiveHomeListFilters(filters: {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedModel: string | null;
  readonly selectedProjectKey?: string | null;
}): boolean {
  return (
    filters.selectedEnvironmentId !== null ||
    filters.selectedModel !== null ||
    (filters.selectedProjectKey !== null && filters.selectedProjectKey !== undefined)
  );
}

/**
 * A pin whose environment or model is not currently available is MASKED, not
 * cleared: the stored value survives so the filter comes back when the
 * environment reconnects or a thread on that model reappears, instead of
 * being silently dropped while a machine is offline. Masking is per consumer,
 * but both shells derive availability from the same thread list, and only one
 * is mounted at a time.
 */
export function useHomeListOptions(
  availableEnvironmentIds: ReadonlySet<EnvironmentId>,
  /** Model slugs still present in the list; a stale pin falls back to "all". */
  availableModels: ReadonlySet<string>,
) {
  const shared = useContext(HomeListOptionsContext);
  const [localOptions, setLocalOptions] = useState<HomeListOptions>(defaultHomeListOptions);
  const options = shared?.options ?? localOptions;
  const setOptions = shared?.setOptions ?? setLocalOptions;
  const selectedEnvironmentId =
    options.selectedEnvironmentId !== null &&
    availableEnvironmentIds.has(options.selectedEnvironmentId)
      ? options.selectedEnvironmentId
      : null;
  const selectedModel =
    options.selectedModel !== null && availableModels.has(options.selectedModel)
      ? options.selectedModel
      : null;
  const availableOptions =
    selectedEnvironmentId === options.selectedEnvironmentId &&
    selectedModel === options.selectedModel
      ? options
      : { ...options, selectedEnvironmentId, selectedModel };
  const resolvedOptions: ResolvedHomeListOptions = {
    ...availableOptions,
    projectGroupingMode: shared?.projectGroupingMode ?? "repository",
  };

  const setSelectedEnvironmentId = useCallback((value: EnvironmentId | null) => {
    setOptions((current) => ({ ...current, selectedEnvironmentId: value }));
  }, []);
  const setSelectedModel = useCallback((value: string | null) => {
    setOptions((current) => ({ ...current, selectedModel: value }));
  }, []);
  return {
    options: resolvedOptions,
    setSelectedEnvironmentId,
    setSelectedModel,
  } as const;
}
