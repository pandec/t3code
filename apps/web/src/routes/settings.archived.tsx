import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";

import { parseArchivedProjectFilterKey } from "../archivedProjectFilter";
import { ArchivedThreadsPanel } from "../components/settings/SettingsPanels";

function ArchivedSettingsRoute() {
  const { project } = Route.useSearch();
  const navigate = Route.useNavigate();
  const handleProjectFilterChange = useCallback(
    (projectKey: string | null) => {
      void navigate({
        search: projectKey ? { project: projectKey } : {},
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <ArchivedThreadsPanel
      projectFilterKey={project ?? null}
      onProjectFilterChange={handleProjectFilterChange}
    />
  );
}

export const Route = createFileRoute("/settings/archived")({
  validateSearch: (search: Record<string, unknown>) => {
    const project = parseArchivedProjectFilterKey(search.project);
    return project === null ? {} : { project };
  },
  component: ArchivedSettingsRoute,
});
