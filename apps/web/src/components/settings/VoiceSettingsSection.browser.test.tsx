import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  canWrite: true,
  readEnvironmentIds: [] as string[],
  updateEnvironmentIds: [] as string[],
  update: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const denied = Atom.make(false);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      updateSettings: {
        ...actual.serverEnvironment.updateSettings,
        permissionAtom: () => (state.canWrite ? allowed : denied),
      },
    },
  };
});
vi.mock(import("../../state/query"), async (original) => {
  const provider = { configured: true, defaults: { modelId: "model", voiceId: "voice" } };
  // One shape answers both the status and the catalog query.
  const data = { openrouter: provider, elevenlabs: provider, configured: true, models: [] };
  return {
    ...(await original()),
    useEnvironmentQuery: (() => ({ data, error: null, isPending: false })) as never,
  };
});
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (<T,>(environmentId: string, select: (s: UnifiedSettings) => T) => {
    state.readEnvironmentIds.push(environmentId);
    return select(DEFAULT_UNIFIED_SETTINGS);
  }) as never,
  useUpdateEnvironmentSettings: ((environmentId: string) => {
    state.updateEnvironmentIds.push(environmentId);
    return state.update;
  }) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({ environment: { environmentId: "remote" } })) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({ control, children }: { control?: ReactNode; children?: ReactNode }) => (
    <div>
      {control}
      {children}
    </div>
  )) as never,
}));

import { VoiceSettingsSection } from "./VoiceSettingsSection";

function setup(canWrite: boolean) {
  state.canWrite = canWrite;
  state.readEnvironmentIds = [];
  state.updateEnvironmentIds = [];
  state.update.mockReset();
}

it("edits the selected environment's voice settings", async () => {
  setup(true);
  await using screen = await render(<VoiceSettingsSection />);
  await userEvent.click(screen.getByRole("switch", { name: "Allow agent voice replies" }));

  expect(new Set(state.readEnvironmentIds)).toEqual(new Set(["remote"]));
  expect(new Set(state.updateEnvironmentIds)).toEqual(new Set(["remote"]));
  expect(state.update).toHaveBeenCalledWith({
    voice: { enableAgentVoiceReplies: !DEFAULT_UNIFIED_SETTINGS.voice.enableAgentVoiceReplies },
  });
});

it("disables profile fields without write permission on the selected environment", async () => {
  setup(false);
  await using screen = await render(<VoiceSettingsSection />);
  await expect.element(screen.getByRole("combobox", { name: "Provider" })).toBeDisabled();
});
