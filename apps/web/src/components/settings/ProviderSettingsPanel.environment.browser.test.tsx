import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  PROVIDER_USAGE_SOURCE_CLIPROXYAPI,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { AsyncResult, type Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  providers: null as unknown as Atom.Writable<ReadonlyArray<ServerProvider>>,
  settings: null as unknown as UnifiedSettings,
  canManageProviders: true,
  canWriteSettings: true,
  searchTargetId: null as string | null,
  readEnvironmentIds: [] as string[],
  updateEnvironmentIds: [] as string[],
  mutationEnvironmentIds: [] as string[],
  refresh: vi.fn(),
  updateProvider: vi.fn(),
  uninstall: vi.fn(),
  acceptUrlAuth: vi.fn(),
  updateSettings: vi.fn(),
  updateModelPreferences: vi.fn(),
  toggleFavorite: vi.fn(),
  mutateProviderInstance: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const providers = Atom.make<ReadonlyArray<ServerProvider>>([]).pipe(Atom.keepAlive);
  state.providers = providers;
  const config = Atom.make(null);
  const commandLabels = {
    refreshProviders: "refresh",
    updateProvider: "update",
    uninstallAcpRegistryManagedBinary: "uninstall",
    acceptAcpRegistryUrlAuth: "accept-url-auth",
  } as const;
  const labelled = Object.fromEntries(
    Object.entries(commandLabels).map(([key, label]) => [
      key,
      { ...actual.serverEnvironment[key as keyof typeof commandLabels], label },
    ]),
  );
  return {
    ...actual,
    providersIgnoringCheckedAtAtom: (() => providers) as never,
    serverEnvironment: {
      ...actual.serverEnvironment,
      ...labelled,
      configValueAtom: (() => config) as never,
      providersValueAtom: (() => providers) as never,
    } as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) =>
    ({
      refresh: state.refresh,
      update: state.updateProvider,
      uninstall: state.uninstall,
      "accept-url-auth": state.acceptUrlAuth,
    })[command.label ?? ""] ?? vi.fn()) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((environmentId: string) => {
    state.readEnvironmentIds.push(environmentId);
    return state.settings;
  }) as never,
  useUpdateEnvironmentSettings: ((environmentId: string) => {
    state.updateEnvironmentIds.push(environmentId);
    return state.updateSettings;
  }) as never,
  useUpdateEnvironmentModelPreferences: (() => state.updateModelPreferences) as never,
  useToggleEnvironmentModelFavorite: (() => state.toggleFavorite) as never,
  usePersistEnvironmentProviderInstanceMutation: ((environmentId: string) => {
    state.mutationEnvironmentIds.push(environmentId);
    return state.mutateProviderInstance;
  }) as never,
}));
vi.mock(import("../../state/session"), async (original) => {
  const scope = (environmentId: string, requested: string) =>
    environmentId === "remote-device" &&
    (requested === "providers:manage"
      ? state.canManageProviders
      : requested === "settings:write"
        ? state.canWriteSettings
        : requested === "orchestration:read");
  return {
    ...(await original()),
    useEnvironmentScope: scope as never,
    readEnvironmentScope: scope as never,
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => []) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  useSettingsSearchTargetId: () => state.searchTargetId,
  SettingsRow: (({
    id,
    title,
    description,
    status,
    control,
    children,
  }: {
    id?: string;
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div id={id}>
      <h4>{title}</h4>
      {description}
      {status}
      {control}
      {children}
    </div>
  )) as never,
}));
vi.mock(import("./UsageProviderSettings"), async (original) => ({
  ...(await original()),
  UsageProviderSettings: (() => null) as never,
}));
vi.mock(import("../ProviderUpdatesAction"), async (original) => ({
  ...(await original()),
  ProviderUpdatesAction: (() => null) as never,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";

const environmentId = EnvironmentId.make("remote-device");
const codexId = ProviderInstanceId.make("codex");
const customId = ProviderInstanceId.make("codex_work");
const antigravityId = ProviderInstanceId.make("antigravity");

function provider(): ServerProvider {
  return {
    instanceId: codexId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-24T12:00:00.000Z",
    models: [{ slug: "chosen", name: "Chosen", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "pnpm add -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-07-24T12:00:00.000Z",
      message: "Update available.",
    },
  };
}

const setProviders = (providers: ReadonlyArray<ServerProvider>) =>
  act(async () => appAtomRegistry.set(state.providers, providers));

function panel(options?: {
  readonly readOnly?: boolean;
  readonly targetInstanceId?: ProviderInstanceId;
}) {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <div className="@container/providers">
        <EnvironmentProviderSettings
          environmentId={environmentId}
          environmentLabel="Remote device"
          {...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly })}
          {...(options?.targetInstanceId === undefined
            ? {}
            : { targetInstanceId: options.targetInstanceId })}
        />
      </div>
    </RegistryContext.Provider>
  );
}

// The section header and the end of the provider list both offer Add provider.

const button = (name: string) => page.getByRole("button", { name, exact: true });
const select = (name: string) => button(`Select ${name}`);

// Fork: the mocked write never echoes, so each edit below stays pending.
async function commitDisplayName(
  container: HTMLElement,
  instanceId: ProviderInstanceId,
  value: string,
) {
  const input = container.querySelector<HTMLInputElement>(
    `#provider-instance-${instanceId}-display-name`,
  )!;
  await userEvent.fill(input, value);
  await userEvent.keyboard("{Enter}");
}

function lastUpsertedInstance(): unknown {
  const [mutation] = state.mutateProviderInstance.mock.lastCall ?? [];
  expect(mutation).toMatchObject({ operation: "upsert" });
  return (mutation as { readonly instance?: unknown } | undefined)?.instance;
}

function antigravitySettings(): UnifiedSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [antigravityId]: {
        driver: ProviderDriverKind.make("antigravity"),
        enabled: false,
        config: { authMethod: "oauth-personal" },
      },
    },
  };
}

async function setup() {
  await page.viewport(1280, 900);
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  state.canManageProviders = true;
  state.canWriteSettings = true;
  state.searchTargetId = null;
  state.readEnvironmentIds = [];
  state.updateEnvironmentIds = [];
  state.mutationEnvironmentIds = [];
  state.updateSettings.mockReset();
  state.updateModelPreferences.mockReset();
  state.toggleFavorite.mockReset();
  state.mutateProviderInstance.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.refresh.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateProvider.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.uninstall.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.acceptUrlAuth.mockReset().mockResolvedValue(AsyncResult.success({ accepted: true }));
  await setProviders([]);
}

describe("EnvironmentProviderSettings routing", () => {
  it("does not substitute another account when the requested instance was removed", async () => {
    await setup();
    await setProviders([provider()]);
    await using _screen = await render(panel({ targetInstanceId: customId }));
    await expect
      .element(page.getByText("This provider instance is no longer available on this device."))
      .toBeVisible();
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps model and usage-source editors read only", async () => {
    await setup();
    state.canWriteSettings = false;
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: {
            customModels: ["gpt-custom=Custom label"],
            customModelIcons: { "gpt-custom": "claudeAgent" },
          },
          usageSource: {
            kind: PROVIDER_USAGE_SOURCE_CLIPROXYAPI,
            managementKey: "",
            managementKeyRedacted: true,
          },
        },
      },
    };
    await setProviders([provider()]);
    await using screen = await render(panel({ readOnly: true }));

    // Custom models stay listed with their icon override, but read only.
    await expect.element(page.getByText("Custom label").first()).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: /^Icon for Custom label: Claude/ }))
      .toBeDisabled();
    const inert = Array.from(screen.container.querySelectorAll("[inert]"));
    expect(
      inert.some(
        (element) =>
          element.querySelector('[aria-label="Meter usage from a CLIProxyAPI gateway"]') !== null,
      ),
    ).toBe(true);
  });

  it("shares pending envelopes between editor and list writes", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: { approvalPolicy: "on-request" },
        },
      },
    };
    await setProviders([provider()]);
    await using screen = await render(panel());

    await commitDisplayName(screen.container, codexId, "Work");
    await userEvent.click(page.getByRole("switch", { name: "Enable Codex" }).first());

    expect(lastUpsertedInstance()).toEqual({
      driver: ProviderDriverKind.make("codex"),
      enabled: false,
      displayName: "Work",
      config: { approvalPolicy: "on-request" },
    });
  });

  it("keeps an editor change when Antigravity setup enables the instance", async () => {
    await setup();
    state.settings = antigravitySettings();
    await using screen = await render(panel({ targetInstanceId: antigravityId }));

    await commitDisplayName(screen.container, antigravityId, "Work");
    await userEvent.click(button("Enable Antigravity"));

    expect(lastUpsertedInstance()).toEqual({
      driver: ProviderDriverKind.make("antigravity"),
      enabled: true,
      displayName: "Work",
      config: { authMethod: "oauth-personal" },
    });
  });

  it("keeps setup enablement when the Antigravity editor changes next", async () => {
    await setup();
    state.settings = antigravitySettings();
    await using screen = await render(panel({ targetInstanceId: antigravityId }));

    await userEvent.click(button("Enable Antigravity"));
    await commitDisplayName(screen.container, antigravityId, "Work");

    expect(lastUpsertedInstance()).toEqual({
      driver: ProviderDriverKind.make("antigravity"),
      enabled: true,
      displayName: "Work",
      config: { authMethod: "oauth-personal" },
    });
  });

  it("does not let a rejected write resurface in the next edit", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Work",
        },
      },
    };
    state.mutateProviderInstance.mockResolvedValueOnce(AsyncResult.fail(new Error("Rejected")));
    await using screen = await render(panel({ targetInstanceId: customId }));

    await commitDisplayName(screen.container, customId, "Rejected");
    await vi.waitFor(() => expect(state.mutateProviderInstance).toHaveBeenCalledTimes(1));
    await userEvent.click(page.getByRole("switch", { name: "Enable Work" }).first());

    expect(lastUpsertedInstance()).toEqual({
      driver: ProviderDriverKind.make("codex"),
      enabled: false,
      displayName: "Work",
    });
  });

  it("bases an edit made right after a reset on the provider defaults", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Old",
          config: { binaryPath: "/opt/old/codex" },
        },
      },
    };
    await using screen = await render(panel({ targetInstanceId: codexId }));
    await userEvent.click(button("Reset Codex provider settings to default"));
    expect(state.mutateProviderInstance).toHaveBeenLastCalledWith({
      operation: "remove",
      instanceId: codexId,
    });

    // The reset has not echoed, so the card still shows the old envelope; the
    // edit must not resurrect it.
    await commitDisplayName(screen.container, codexId, "Fresh");
    expect(lastUpsertedInstance()).toEqual({
      driver: ProviderDriverKind.make("codex"),
      displayName: "Fresh",
    });
  });

  it("drops a reset's pending envelope once its row is gone", async () => {
    await setup();
    const grokId = ProviderInstanceId.make("grok");
    const grok = ProviderDriverKind.make("grok");
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: { [grokId]: { driver: grok, enabled: true, displayName: "Old" } },
    };
    await using screen = await render(panel({ targetInstanceId: grokId }));
    await userEvent.click(button("Reset Grok provider settings to default"));

    // The reset echoes: the default-off slot is hidden, so no card acknowledges it.
    state.settings = DEFAULT_UNIFIED_SETTINGS;
    await screen.rerender(panel());
    await expect.element(select("Old")).not.toBeInTheDocument();

    // Re-added through Add provider, then edited.
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [grokId]: { driver: grok, enabled: true, config: { binaryPath: "/opt/grok" } },
      },
    };
    await screen.rerender(panel());
    await commitDisplayName(screen.container, grokId, "Grok");
    expect(lastUpsertedInstance()).toEqual({
      driver: grok,
      enabled: true,
      displayName: "Grok",
      config: { binaryPath: "/opt/grok" },
    });
  });

  it("keeps an unechoed custom model rename when its options change after a remount", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: { customModels: [{ slug: "gpt-custom", name: "Old" }] },
        },
      },
    };
    await setProviders([provider()]);
    await using _screen = await render(panel({ targetInstanceId: codexId }));

    await userEvent.click(button("Edit gpt-custom"));
    await userEvent.fill(page.getByLabelText("Display name"), "New");
    await userEvent.click(button("Save"));
    expect(lastUpsertedInstance()).toMatchObject({
      config: { customModels: [{ slug: "gpt-custom", name: "New" }] },
    });

    // Leaving and returning remounts the editor from the echoed "Old" definition.
    await userEvent.click(select("Claude"));
    await userEvent.click(select("Codex"));
    await userEvent.click(button("Edit gpt-custom"));
    await userEvent.click(button("Reasoning"));
    await userEvent.click(button("Save"));

    expect(lastUpsertedInstance()).toMatchObject({
      config: {
        customModels: [
          {
            slug: "gpt-custom",
            name: "New",
            capabilities: {
              optionDescriptors: [expect.objectContaining({ id: "reasoningEffort" })],
            },
          },
        ],
      },
    });
  });

  it("updates one provider instance without sending a stale whole map", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Work",
        },
      },
    };
    await using _screen = await render(panel());
    await userEvent.click(page.getByRole("switch", { name: "Enable Work" }).first());

    expect(state.mutateProviderInstance).toHaveBeenCalledWith(
      {
        operation: "upsert",
        instanceId: customId,
        instance: { driver: ProviderDriverKind.make("codex"), enabled: false, displayName: "Work" },
      },
      {},
    );
  });

  it("routes explicit ACP browser authentication consent to the selected environment", async () => {
    await setup();
    const instanceId = ProviderInstanceId.make("acpRegistry_antigravity");
    const action = {
      elicitationId: "google-login-1",
      url: "https://accounts.google.com/login",
      message: "Continue with Google",
    };
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: { agentId: "antigravity" },
        },
      },
    };
    await setProviders([
      {
        ...provider(),
        instanceId,
        driver: ProviderDriverKind.make("acpRegistry"),
        auth: { status: "unauthenticated", action },
      },
    ]);
    await using _screen = await render(panel({ targetInstanceId: instanceId }));
    const link = page.getByRole("link", { name: "Continue authentication" });
    link.element().addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(link);

    expect(state.acceptUrlAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, elicitationId: action.elicitationId },
    });
  });
});
