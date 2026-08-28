import type { ComponentProps, ReactElement } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  PROVIDER_USAGE_SOURCE_CLIPROXYAPI,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  providers: null as ReadonlyArray<ServerProvider> | null,
  providersAtom: Symbol("providers"),
  refreshProviders: Symbol("refreshProviders"),
  updateProvider: Symbol("updateProvider"),
}));

const commands = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateProvider: vi.fn(),
}));

const settingsState = vi.hoisted(() => ({
  value: null as UnifiedSettings | null,
  readEnvironmentIds: [] as EnvironmentId[],
  updateEnvironmentIds: [] as EnvironmentId[],
  updateSettings: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void | (() => void)) => {
      effect();
    },
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => atoms.providers,
}));

vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => atoms.providersAtom,
    refreshProviders: atoms.refreshProviders,
    updateProvider: atoms.updateProvider,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === atoms.refreshProviders ? commands.refresh : commands.updateProvider,
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.readEnvironmentIds.push(environmentId);
    return settingsState.value;
  },
  useUpdateEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.updateEnvironmentIds.push(environmentId);
    return settingsState.updateSettings;
  },
}));

vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));

vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, hasError: false, isPending: true }),
}));

import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";

const environmentId = EnvironmentId.make("remote-device");
const codexId = ProviderInstanceId.make("codex");
const customId = ProviderInstanceId.make("codex_work");

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
    models: [],
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

function renderPanel(options?: {
  readonly readOnly?: boolean;
}): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return EnvironmentProviderSettings({
    environmentId,
    environmentLabel: "Remote device",
    ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  }) as ReactElement<Record<string, unknown>>;
}

function renderProviderCard(
  element: ReactElement<Record<string, unknown>>,
): ReactElement<Record<string, unknown>> {
  hooks.reset();
  return ProviderInstanceCard(
    element.props as unknown as ComponentProps<typeof ProviderInstanceCard>,
  ) as ReactElement<Record<string, unknown>>;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EnvironmentProviderSettings routing", () => {
  beforeEach(() => {
    hooks.reset();
    atoms.providers = null;
    settingsState.value = DEFAULT_UNIFIED_SETTINGS;
    settingsState.readEnvironmentIds = [];
    settingsState.updateEnvironmentIds = [];
    settingsState.updateSettings.mockReset();
    commands.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.updateProvider.mockReset().mockResolvedValue({ _tag: "Success" });
  });

  it("coalesces a nullable provider snapshot before rendering array-backed UI", () => {
    expect(() => renderPanel()).not.toThrow();
    expect(settingsState.readEnvironmentIds).toEqual([environmentId]);
    expect(settingsState.updateEnvironmentIds).toEqual([environmentId]);
  });

  it("routes refresh and provider update commands to the selected environment", async () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    const refreshButton = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Refresh provider status",
    );
    expect(refreshButton).not.toBeNull();
    (refreshButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.refresh).toHaveBeenCalledWith({ environmentId, input: {} });

    const providerCard = visitElements(
      panel,
      (element) =>
        element.props.instanceId === codexId && typeof element.props.onRunUpdate === "function",
    );
    expect(providerCard).not.toBeNull();
    (providerCard?.props.onRunUpdate as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.updateProvider).toHaveBeenCalledWith({
      environmentId,
      input: { provider: ProviderDriverKind.make("codex"), instanceId: codexId },
    });
  });

  it("keeps provider selection available while write controls are read only", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    atoms.providers = [provider()];
    let panel = renderPanel({ readOnly: true });

    const inertWrapper = visitElements(panel, (element) => element.props.inert === true);
    expect(inertWrapper).not.toBeNull();

    const customRow = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "list",
    );
    expect(customRow?.props.readOnly).toBe(true);
    expect(customRow?.props.onSelect).toBeTypeOf("function");
    (customRow?.props.onSelect as (() => void) | undefined)?.();

    panel = renderPanel({ readOnly: true });
    const customEditor = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(customEditor).not.toBeNull();

    const notice = visitElements(panel, (element) => element.props.title === "Limited permissions");
    expect(notice).not.toBeNull();

    const providersSection = visitElements(
      panel,
      (element) => element.props.title === "Providers" && "headerAction" in element.props,
    );
    expect(providersSection?.props.headerAction).toBeNull();
    expect(
      visitElements(panel, (element) => element.props["aria-label"] === "Refresh provider status"),
    ).toBeNull();
  });

  it("keeps the editable layout interactive when not read only", () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.inert === true)).toBeNull();
    expect(
      visitElements(panel, (element) => element.props.title === "Limited permissions"),
    ).toBeNull();
    const providersSection = visitElements(
      panel,
      (element) => element.props.title === "Providers" && "headerAction" in element.props,
    );
    expect(providersSection?.props.headerAction).not.toBeNull();
  });

  it("shares pending envelopes between editor and list writes", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: { approvalPolicy: "on-request" },
        },
      },
    };
    atoms.providers = [provider()];
    const panel = renderPanel();
    const listCard = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "list",
    );
    const editorCard = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "editor",
    );
    expect(listCard).not.toBeNull();
    expect(editorCard).not.toBeNull();
    expect(listCard?.props.pendingInstancesRef).toBe(editorCard?.props.pendingInstancesRef);

    const editor = renderProviderCard(editorCard!);
    const displayNameInput = visitElements(
      editor,
      (element) => element.props.id === `provider-instance-${codexId}-display-name`,
    );
    (displayNameInput?.props.onCommit as ((value: string) => void) | undefined)?.("Work");

    const list = renderProviderCard(listCard!);
    const enabledSwitch = visitElements(
      list,
      (element) => element.props["aria-label"] === "Enable Codex",
    );
    (enabledSwitch?.props.onCheckedChange as ((checked: boolean) => void) | undefined)?.(false);

    const patch = settingsState.updateSettings.mock.lastCall?.[0] as
      | { providerInstances?: Record<string, unknown> }
      | undefined;
    expect(patch?.providerInstances?.[codexId]).toEqual({
      driver: ProviderDriverKind.make("codex"),
      enabled: false,
      displayName: "Work",
      config: { approvalPolicy: "on-request" },
    });
  });

  it("keeps model and usage-source editors inside the read-only inert boundary", () => {
    settingsState.value = {
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
    atoms.providers = [provider()];
    const panel = renderPanel({ readOnly: true });
    const editorCard = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "editor",
    );
    const listCard = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "list",
    );
    expect(editorCard).not.toBeNull();
    expect(listCard).not.toBeNull();

    const editor = renderProviderCard(editorCard!);
    const modelsSection = visitElements(
      editor,
      (element) =>
        Array.isArray(element.props.customModels) &&
        typeof element.props.onAddCustomModel === "function",
    );
    expect(modelsSection?.props.models).toEqual([
      {
        slug: "gpt-custom",
        name: "Custom label",
        isCustom: true,
        capabilities: null,
      },
    ]);
    expect(modelsSection?.props.customModelIcons).toMatchObject({
      "gpt-custom": "claudeAgent",
    });
    expect(modelsSection?.props.onAddCustomModel).toBeTypeOf("function");
    expect(modelsSection?.props.onRemoveCustomModel).toBeTypeOf("function");
    expect(modelsSection?.props.onCustomModelIconChange).toBeTypeOf("function");
    const usageSection = visitElements(
      editor,
      (element) =>
        (element.props.usageSource as { kind?: unknown } | undefined)?.kind ===
          PROVIDER_USAGE_SOURCE_CLIPROXYAPI && typeof element.props.onChange === "function",
    );
    expect(usageSection).not.toBeNull();
    const inertEditor = visitElements(
      editor,
      (element) =>
        element.props.inert === true &&
        visitElements(
          element,
          (child) =>
            Array.isArray(child.props.customModels) || child.props.usageSource !== undefined,
        ) !== null,
    );
    expect(inertEditor).not.toBeNull();

    const list = renderProviderCard(listCard!);
    expect(
      visitElements(
        list,
        (element) =>
          Array.isArray(element.props.customModels) || element.props.usageSource !== undefined,
      ),
    ).toBeNull();
  });

  it("deletes and resets provider configuration without erasing shared preferences", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          failoverInstanceId: customId,
        },
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Work",
          enabled: true,
        },
      },
      providerModelPreferences: {
        [customId]: { hiddenModels: ["hidden"], modelOrder: ["model"] },
      },
      favorites: [{ provider: customId, model: "favorite" }],
    };
    let panel = renderPanel();
    const customRow = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "list",
    );
    (customRow?.props.onSelect as (() => void) | undefined)?.();
    panel = renderPanel();
    const customCard = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(customCard).not.toBeNull();
    expect(customCard?.props.failoverOptions).toEqual([
      {
        id: codexId,
        label: "Codex (codex)",
        compatible: false,
      },
    ]);
    (customCard?.props.onDelete as (() => void) | undefined)?.();

    expect(settingsState.updateSettings).toHaveBeenLastCalledWith({
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
        },
      },
    });

    settingsState.updateSettings.mockClear();
    const defaultRow = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "list",
    );
    (defaultRow?.props.onSelect as (() => void) | undefined)?.();
    panel = renderPanel();
    const defaultCard = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "editor",
    );
    const resetAction = defaultCard?.props.headerAction;
    const resetButton = visitElements(
      resetAction,
      (element) => typeof element.props.onClick === "function",
    );
    expect(resetButton).not.toBeNull();
    (resetButton?.props.onClick as (() => void) | undefined)?.();

    const resetPatch = settingsState.updateSettings.mock.lastCall?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(Object.keys(resetPatch ?? {}).sort()).toEqual(["providerInstances", "providers"]);
    expect(resetPatch).not.toHaveProperty("favorites");
    expect(resetPatch).not.toHaveProperty("providerModelPreferences");
  });
});
