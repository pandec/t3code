import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ServerSettingsPatch } from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { refreshLabsInventory, useLabsInventory } from "../../state/labs";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

type LabsPatch = NonNullable<ServerSettingsPatch["labs"]>;

const AUTO_PROJECT_VALUE = "auto";

/** Fork: SP Labs for the selected environment's server. */
export function SpLabsSettingsSection() {
  const { environment } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" && environment.serverConfig !== null
      ? environment.environmentId
      : null;
  return (
    <SettingsSection {...searchableSetting("extras-sp-labs")}>
      {environmentId ? (
        // Settings belong to one environment; switching must not carry drafts over.
        <SpLabsSettingsRows key={environmentId} environmentId={environmentId} />
      ) : (
        <p className="px-3 py-3 text-muted-foreground text-xs sm:px-4">
          Connect an environment to set up SP Labs.
        </p>
      )}
    </SettingsSection>
  );
}

function SpLabsSettingsRows({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.labs);
  const inventory = useLabsInventory(environmentId);
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save SP Labs settings",
  });
  const projects = useProjects();
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );
  const enabled = saved.spLabsDirectory !== "";

  const save = async (labs: LabsPatch) => {
    const result = await updateSettings({ environmentId, input: { patch: { labs } } });
    // The server resolves the directory and project again; the inventory carries the result.
    if (result._tag === "Success") refreshLabsInventory(environmentId);
  };

  const resolvedProject = environmentProjects.find(
    (project) => project.id === (inventory?.projectId ?? null),
  );
  const status = !enabled
    ? "Off."
    : inventory === null
      ? "Checking…"
      : !inventory.configured
        ? "No sp-labs checkout found. Set its directory to turn SP Labs on."
        : inventory.error
          ? inventory.error
          : `${inventory.environments.filter((entry) => entry.kind === "lab").length} labs${
              resolvedProject ? ` in ${resolvedProject.title}` : ""
            }.`;

  return (
    <>
      <SettingsRow
        {...searchableSetting("sp-labs-directory")}
        description={
          <>
            Threads in the labs project can run in a persistent sp-labs lab, with its own browser
            and dev stack. Leave the directory empty to find the checkout automatically.{" "}
            <span className="text-muted-foreground/80">{status}</span>
          </>
        }
        resetAction={
          saved.spLabsDirectory !== null ? (
            <SettingResetButton
              label="sp-labs directory"
              onClick={() => void save({ spLabsDirectory: null })}
            />
          ) : null
        }
        control={
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <DraftInput
              key={saved.spLabsDirectory ?? ""}
              className="w-full sm:w-72"
              value={saved.spLabsDirectory ?? ""}
              disabled={!canWrite || !enabled}
              onCommit={(next) => {
                const trimmed = next.trim();
                void save({ spLabsDirectory: trimmed.length > 0 ? trimmed : null });
              }}
              placeholder={inventory?.spLabsDirectory ?? "~/SynologyDrive/AIMac/repos/sp-labs"}
              spellCheck={false}
              autoComplete="off"
              aria-label="sp-labs directory"
            />
            <Switch
              checked={enabled}
              disabled={!canWrite}
              onCheckedChange={(checked) => void save({ spLabsDirectory: checked ? null : "" })}
              aria-label="Use SP Labs"
            />
          </div>
        }
      />
      <SettingsRow
        {...searchableSetting("sp-labs-project")}
        description="The project whose threads can run in labs. Automatic picks the project rooted at the labs' source checkout."
        resetAction={
          saved.projectId !== null ? (
            <SettingResetButton
              label="Labs project"
              onClick={() => void save({ projectId: null })}
            />
          ) : null
        }
        control={
          <Select
            value={saved.projectId ?? AUTO_PROJECT_VALUE}
            disabled={!canWrite || !enabled}
            onValueChange={(value) =>
              void save({
                projectId:
                  value === AUTO_PROJECT_VALUE || value === null ? null : (value as ProjectId),
              })
            }
          >
            <SelectTrigger className="w-full sm:w-56" aria-label="Labs project">
              <SelectValue>
                {saved.projectId === null
                  ? `Automatic${resolvedProject ? ` (${resolvedProject.title})` : ""}`
                  : (environmentProjects.find((project) => project.id === saved.projectId)?.title ??
                    saved.projectId)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={AUTO_PROJECT_VALUE}>
                Automatic
              </SelectItem>
              {environmentProjects.map((project) => (
                <SelectItem hideIndicator key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("sp-labs-default-lab-mode")}
        description="New threads in the labs project start in Lab mode instead of the project default."
        control={
          <Switch
            checked={saved.defaultToLabMode}
            disabled={!canWrite || !enabled}
            onCheckedChange={(checked) => void save({ defaultToLabMode: Boolean(checked) })}
            aria-label="Default to Lab mode"
          />
        }
      />
    </>
  );
}
