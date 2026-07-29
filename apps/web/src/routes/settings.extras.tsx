import { createFileRoute } from "@tanstack/react-router";

import { ExtrasSettingsPanel } from "../components/settings/ExtrasSettingsPanel";

function SettingsExtrasRoute() {
  return <ExtrasSettingsPanel />;
}

export const Route = createFileRoute("/settings/extras")({
  component: SettingsExtrasRoute,
});
