import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "../components/settings/SettingsPanels";

function ArchivedSettingsRoute() {
  const { project } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <ArchivedThreadsPanel
      projectFilterKey={project ?? null}
      onProjectFilterChange={(projectKey) => {
        void navigate({
          search: projectKey ? { project: projectKey } : {},
          replace: true,
        });
      }}
    />
  );
}

export const Route = createFileRoute("/settings/archived")({
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.project === "string" && search.project.length > 0
      ? { project: search.project }
      : {},
  component: ArchivedSettingsRoute,
});
