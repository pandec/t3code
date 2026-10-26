import { createFileRoute } from "@tanstack/react-router";

import { PromptsSettings } from "../components/settings/PromptsSettings";

export const Route = createFileRoute("/_chat/settings/prompts")({
  component: PromptsSettings,
});
