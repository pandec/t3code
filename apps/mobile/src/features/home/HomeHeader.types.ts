import type { EnvironmentId, SidebarThreadSortOrder } from "@t3tools/contracts";
import type { HomeProjectSortOrder } from "./homeThreadList";
import type {
  HomeListFilterMenuEnvironment,
  HomeListFilterMenuModel,
  HomeListFilterMenuProject,
} from "./home-list-filter-menu";

export type HomeHeaderEnvironment = HomeListFilterMenuEnvironment;

export interface HomeHeaderProps {
  readonly environments: ReadonlyArray<HomeHeaderEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly models: ReadonlyArray<HomeListFilterMenuModel>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly selectedModel: string | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly attentionFilterEnabled: boolean;
  /** False while thread shells are still loading; gates enabling the filter. */
  readonly attentionFilterReady: boolean;
  readonly onToggleAttentionFilter: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onModelChange: (model: string | null) => void;
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  readonly onOpenEnvironments: () => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
}
