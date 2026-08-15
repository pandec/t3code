import { createFileRoute } from "@tanstack/react-router";

import { PromptsSettings } from "../components/settings/PromptsSettings";

export const Route = createFileRoute("/settings/prompts")({
  component: PromptsSettings,
});
