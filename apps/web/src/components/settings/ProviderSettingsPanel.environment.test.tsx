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
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  providers: null as ReadonlyArray<ServerProvider> | null,
  providersAtom: Symbol("providers"),
  refreshProviders: Symbol("refreshProviders"),
  updateProvider: Symbol("updateProvider"),
  uninstallAcpRegistryManagedBinary: Symbol("uninstallAcpRegistryManagedBinary"),
  acceptAcpRegistryUrlAuth: Symbol("acceptAcpRegistryUrlAuth"),
}));

const commands = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateProvider: vi.fn(),
  uninstall: vi.fn(),
  acceptUrlAuth: vi.fn(),
  canManageProviders: true,
  canWriteSettings: true,
}));

const settingsState = vi.hoisted(() => ({
  value: null as UnifiedSettings | null,
  readEnvironmentIds: [] as EnvironmentId[],
  updateEnvironmentIds: [] as EnvironmentId[],
  mutationEnvironmentIds: [] as EnvironmentId[],
  updateSettings: vi.fn(),
  mutateProviderInstance: vi.fn(),
  updateClientSettings: vi.fn(),
}));

const settingsSearchState = vi.hoisted(() => ({
  targetId: null as string | null,
  effects: [] as Array<() => void>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void) => settingsSearchState.effects.push(effect),
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("./settingsLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settingsLayout")>();
  return {
    ...actual,
    useSettingsSearchTargetId: () => settingsSearchState.targetId,
  };
});

vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));
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
    uninstallAcpRegistryManagedBinary: atoms.uninstallAcpRegistryManagedBinary,
    acceptAcpRegistryUrlAuth: atoms.acceptAcpRegistryUrlAuth,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === atoms.refreshProviders
      ? commands.refresh
      : atom === atoms.uninstallAcpRegistryManagedBinary
        ? commands.uninstall
        : atom === atoms.acceptAcpRegistryUrlAuth
          ? commands.acceptUrlAuth
          : commands.updateProvider,
}));

vi.mock("../../hooks/useSettings", () => ({
  useUpdateClientSettings: () => settingsState.updateClientSettings,
  useEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.readEnvironmentIds.push(environmentId);
    return settingsState.value;
  },
  useUpdateEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.updateEnvironmentIds.push(environmentId);
    return settingsState.updateSettings;
  },
  usePersistEnvironmentProviderInstanceMutation: (environmentId: EnvironmentId) => {
    settingsState.mutationEnvironmentIds.push(environmentId);
    return settingsState.mutateProviderInstance;
  },
}));

vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));

vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, hasError: false, isPending: true }),
  useEnvironmentScope: (environmentId: EnvironmentId, scope: string) =>
    environmentId === "remote-device" &&
    (scope === "providers:manage"
      ? commands.canManageProviders
      : scope === "settings:write"
        ? commands.canWriteSettings
        : scope === "orchestration:read"),
  readEnvironmentScope: (environmentId: EnvironmentId, scope: string) =>
    environmentId === "remote-device" &&
    (scope === "providers:manage"
      ? commands.canManageProviders
      : scope === "settings:write"
        ? commands.canWriteSettings
        : scope === "orchestration:read"),
}));

vi.mock("../../state/entities", () => ({
  useProjects: () => [],
}));

import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

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
  readonly targetInstanceId?: ProviderInstanceId;
}): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return EnvironmentProviderSettings({
    environmentId,
    environmentLabel: "Remote device",
    ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options?.targetInstanceId === undefined
      ? {}
      : { targetInstanceId: options.targetInstanceId }),
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

function isRefreshButton(element: ReactElement<Record<string, unknown>>): boolean {
  const children = element.props.children;
  return (
    Array.isArray(children) &&
    children.some(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        (child as ReactElement<Record<string, unknown>>).props?.className === "sr-only" &&
        (child as ReactElement<Record<string, unknown>>).props?.children ===
          "Refresh provider status",
    )
  );
}

function isAddProviderButton(element: ReactElement<Record<string, unknown>>): boolean {
  return element.props["aria-label"] === "Add provider";
}

function findCard(
  panel: ReactElement<Record<string, unknown>>,
  instanceId: ProviderInstanceId,
  mode: "list" | "editor",
): ReactElement<Record<string, unknown>> | null {
  return visitElements(
    panel,
    (element) => element.props.instanceId === instanceId && element.props.mode === mode,
  );
}

function commitDisplayName(
  card: ReactElement<Record<string, unknown>>,
  instanceId: ProviderInstanceId,
  value: string,
): void {
  const input = visitElements(
    renderProviderCard(card),
    (element) => element.props.id === `provider-instance-${instanceId}-display-name`,
  );
  expect(input).not.toBeNull();
  (input?.props.onCommit as (value: string) => void)(value);
}

function enableAntigravity(card: ReactElement<Record<string, unknown>>): void {
  const setup = visitElements(
    card.props.setup,
    (element) => typeof element.props.onEnable === "function",
  );
  expect(setup).not.toBeNull();
  (setup?.props.onEnable as () => void)();
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

function lastUpsertedInstance(): unknown {
  const [mutation] = settingsState.mutateProviderInstance.mock.lastCall ?? [];
  expect(mutation).toMatchObject({ operation: "upsert" });
  return (mutation as { readonly instance?: unknown } | undefined)?.instance;
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
    settingsState.mutationEnvironmentIds = [];
    settingsState.updateSettings.mockReset();
    settingsState.updateClientSettings.mockReset();
    settingsSearchState.targetId = null;
    settingsSearchState.effects = [];
    settingsState.mutateProviderInstance
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: {} });
    commands.canManageProviders = true;
    commands.canWriteSettings = true;
    commands.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.updateProvider.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.uninstall.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
    commands.acceptUrlAuth
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: { accepted: true } });
  });

  it("shows Codex and Claude while hiding untouched disabled provider slots", () => {
    const panel = renderPanel();
    for (const driver of ["codex", "claudeAgent"] as const) {
      expect(
        visitElements(
          panel,
          (element) => element.props.instanceId === driver && element.props.mode === "list",
        ),
      ).not.toBeNull();
    }
    for (const driver of ["cursor", "grok", "pi", "opencode", "antigravity"] as const) {
      expect(
        visitElements(
          panel,
          (element) => element.props.instanceId === driver && element.props.mode === "list",
        ),
      ).toBeNull();
    }
  });

  it("keeps explicitly configured providers visible when disabled", () => {
    const grokId = ProviderInstanceId.make("grok");
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [grokId]: { driver: ProviderDriverKind.make("grok"), enabled: false },
      },
    };
    const panel = renderPanel();
    expect(
      visitElements(
        panel,
        (element) => element.props.instanceId === grokId && element.props.mode === "list",
      ),
    ).not.toBeNull();
  });

  it("keeps legacy provider configuration visible when disabled", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("grok")]: {
          driver: ProviderDriverKind.make("grok"),
          enabled: false,
          config: {
            binaryPath: "/custom/grok",
          },
        },
      },
    };
    const panel = renderPanel();
    expect(
      visitElements(
        panel,
        (element) => element.props.instanceId === "grok" && element.props.mode === "list",
      ),
    ).not.toBeNull();
  });

  it("coalesces a nullable provider snapshot before rendering array-backed UI", () => {
    expect(() => renderPanel()).not.toThrow();
    expect(settingsState.readEnvironmentIds).toEqual([environmentId]);
    expect(settingsState.updateEnvironmentIds).toEqual([environmentId]);
    expect(settingsState.mutationEnvironmentIds).toEqual([environmentId]);
  });

  it("routes refresh and provider update commands to the selected environment", async () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    const refreshButton = visitElements(panel, isRefreshButton);
    expect(refreshButton).not.toBeNull();
    (refreshButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.refresh).toHaveBeenCalledWith({
      environmentId,
      input: { refreshModels: true },
    });

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

  it("opens the requested provider instance instead of the first provider", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
    };
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: customId });
    const editor = visitElements(panel, (element) => element.props.mode === "editor");
    expect(editor?.props.instanceId).toBe(customId);
  });

  it.each([
    ["onFavoriteModelsChange", { favorites: [{ provider: codexId, model: "chosen" }] }],
    [
      "onHiddenModelsChange",
      { providerModelPreferences: { [codexId]: { hiddenModels: ["chosen"], modelOrder: [] } } },
    ],
    [
      "onModelOrderChange",
      { providerModelPreferences: { [codexId]: { hiddenModels: [], modelOrder: ["chosen"] } } },
    ],
  ])("saves %s on this device without changing the selected server", (action, expected) => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    const editor = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "editor",
    );
    expect(editor).not.toBeNull();
    if (!editor) throw new Error("Provider editor was not rendered");
    (editor.props[action] as (models: string[]) => void)(["chosen"]);
    expect(settingsState.updateClientSettings).toHaveBeenCalledExactlyOnceWith(expected);
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("does not substitute another account when the requested instance was removed", () => {
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: customId });
    expect(visitElements(panel, (element) => element.props.mode === "editor")).toBeNull();
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps provider selection available while write controls are read only", () => {
    commands.canWriteSettings = false;
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

    expect(visitElements(panel, isRefreshButton)).not.toBeNull();
    expect(visitElements(panel, isAddProviderButton)).toBeNull();
  });

  it("keeps the editable layout interactive when not read only", () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.inert === true)).toBeNull();
    expect(
      visitElements(panel, (element) => element.props.title === "Limited permissions"),
    ).toBeNull();
    expect(visitElements(panel, isRefreshButton)).not.toBeNull();
    expect(visitElements(panel, isAddProviderButton)).not.toBeNull();
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
        typeof element.props.onCustomModelIconChange === "function",
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
    expect(modelsSection?.props.onChange).toBeTypeOf("function");
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

  it("shares pending envelopes between editor and list writes", async () => {
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
    const listCard = findCard(panel, codexId, "list");
    const editorCard = findCard(panel, codexId, "editor");
    expect(listCard?.props.pendingInstancesRef).toBe(editorCard?.props.pendingInstancesRef);

    commitDisplayName(editorCard!, codexId, "Work");
    const list = renderProviderCard(listCard!);
    const enabledSwitch = visitElements(
      list,
      (element) => element.props["aria-label"] === "Enable Codex",
    );
    (enabledSwitch?.props.onCheckedChange as ((checked: boolean) => void) | undefined)?.(false);
    await flushPromises();

    expect(lastUpsertedInstance()).toEqual({
      driver: ProviderDriverKind.make("codex"),
      enabled: false,
      displayName: "Work",
      config: { approvalPolicy: "on-request" },
    });
  });

  it("keeps an editor change when Antigravity setup enables the instance", async () => {
    settingsState.value = antigravitySettings();
    const panel = renderPanel({ targetInstanceId: antigravityId });
    const editorCard = findCard(panel, antigravityId, "editor");

    commitDisplayName(editorCard!, antigravityId, "Work");
    enableAntigravity(editorCard!);
    await flushPromises();

    expect(lastUpsertedInstance()).toEqual({
      driver: ProviderDriverKind.make("antigravity"),
      enabled: true,
      displayName: "Work",
      config: { authMethod: "oauth-personal" },
    });
  });

  it("keeps setup enablement when the Antigravity editor changes next", async () => {
    settingsState.value = antigravitySettings();
    const panel = renderPanel({ targetInstanceId: antigravityId });
    const editorCard = findCard(panel, antigravityId, "editor");

    enableAntigravity(editorCard!);
    commitDisplayName(editorCard!, antigravityId, "Work");
    await flushPromises();

    expect(lastUpsertedInstance()).toEqual({
      driver: ProviderDriverKind.make("antigravity"),
      enabled: true,
      displayName: "Work",
      config: { authMethod: "oauth-personal" },
    });
  });

  it("does not let a rejected write resurface in the next edit", async () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
    };
    const panel = renderPanel({ targetInstanceId: customId });
    const editorCard = findCard(panel, customId, "editor");
    settingsState.mutateProviderInstance.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Rejected")),
    });

    commitDisplayName(editorCard!, customId, "Rejected");
    await flushPromises();
    const list = renderProviderCard(findCard(panel, customId, "list")!);
    const enabledSwitch = visitElements(
      list,
      (element) => typeof element.props.onCheckedChange === "function",
    );
    (enabledSwitch?.props.onCheckedChange as ((checked: boolean) => void) | undefined)?.(false);
    await flushPromises();

    expect(lastUpsertedInstance()).toEqual({
      driver: ProviderDriverKind.make("codex"),
      enabled: false,
    });
  });

  it("bases an edit made right after a reset on the provider defaults", async () => {
    settingsState.value = {
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
    const panel = renderPanel({ targetInstanceId: codexId });
    const editorCard = findCard(panel, codexId, "editor");
    const resetButton = visitElements(
      editorCard?.props.headerAction,
      (element) => typeof element.props.onClick === "function",
    );
    (resetButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    const [resetMutation] = settingsState.mutateProviderInstance.mock.lastCall ?? [];
    expect(resetMutation).toEqual({ operation: "remove", instanceId: codexId });

    // The server has not echoed the reset yet, so the card still renders the
    // old envelope; the edit must not resurrect it.
    commitDisplayName(editorCard!, codexId, "Fresh");
    await flushPromises();

    expect(lastUpsertedInstance()).toEqual({
      driver: ProviderDriverKind.make("codex"),
      displayName: "Fresh",
    });
  });

  it("drops a reset's pending envelope once its row is gone", async () => {
    const grokId = ProviderInstanceId.make("grok");
    const grok = ProviderDriverKind.make("grok");
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: { [grokId]: { driver: grok, enabled: true, displayName: "Old" } },
    };
    const resetButton = visitElements(
      findCard(renderPanel({ targetInstanceId: grokId }), grokId, "editor")?.props.headerAction,
      (element) => typeof element.props.onClick === "function",
    );
    (resetButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    // The reset echoes: the default-off slot is hidden, so no card acknowledges it.
    settingsState.value = DEFAULT_UNIFIED_SETTINGS;
    settingsSearchState.effects = [];
    expect(findCard(renderPanel(), grokId, "list")).toBeNull();
    for (const effect of settingsSearchState.effects) effect();

    // Re-added through Add provider, then edited.
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [grokId]: { driver: grok, enabled: true, config: { binaryPath: "/opt/grok" } },
      },
    };
    commitDisplayName(findCard(renderPanel(), grokId, "editor")!, grokId, "Grok");
    await flushPromises();

    expect(lastUpsertedInstance()).toEqual({
      driver: grok,
      enabled: true,
      displayName: "Grok",
      config: { binaryPath: "/opt/grok" },
    });
  });

  it("removes an open add-instance dialog when the provider grant is revoked", () => {
    let panel = renderPanel();
    const add = visitElements(panel, isAddProviderButton);
    if (!add) throw new Error("Missing Add provider action.");
    (add.props.onClick as () => void)();
    panel = renderPanel();
    expect(
      visitElements(panel, (element) => element.type === AddProviderInstanceDialog),
    ).not.toBeNull();

    commands.canManageProviders = false;
    panel = renderPanel({ readOnly: true });
    expect(
      visitElements(panel, (element) => element.type === AddProviderInstanceDialog),
    ).toBeNull();
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps Advanced visible when search targets the provider health interval", () => {
    let panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.title === "Advanced")).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props.id === "provider-health-check-interval"),
    ).not.toBeNull();

    settingsSearchState.targetId = "provider-health-check-interval";
    panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.title === "Advanced")).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props.id === "provider-health-check-interval"),
    ).not.toBeNull();
  });

  it("deletes and resets provider configuration without erasing shared preferences", async () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
        },
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
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
    (customCard?.props.onDelete as (() => void) | undefined)?.();
    await flushPromises();

    expect(settingsState.mutateProviderInstance).toHaveBeenLastCalledWith({
      operation: "remove",
      instanceId: customId,
    });

    settingsState.mutateProviderInstance.mockClear();
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
    await flushPromises();

    const [resetMutation, resetPatch] = settingsState.mutateProviderInstance.mock.lastCall ?? [];
    expect(resetMutation).toEqual({ operation: "remove", instanceId: codexId });
    // Removing the instance is the whole reset; shared preferences stay untouched.
    expect(resetPatch ?? {}).toEqual({});
  });

  it("updates one provider instance without sending a stale whole map", async () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Work",
        },
      },
    };
    const panel = renderPanel();
    const card = visitElements(panel, (element) => element.props.instanceId === customId);
    const next = {
      driver: ProviderDriverKind.make("codex"),
      enabled: false,
      displayName: "Work",
    };
    (card?.props.onUpdate as ((instance: typeof next) => void) | undefined)?.(next);
    await flushPromises();

    expect(settingsState.mutateProviderInstance).toHaveBeenCalledWith(
      { operation: "upsert", instanceId: customId, instance: next },
      {},
    );
  });

  it("lets the server decide managed ACP cleanup after an atomic delete", async () => {
    const firstId = ProviderInstanceId.make("acpRegistry_kilo_one");
    const secondId = ProviderInstanceId.make("acpRegistry_kilo_two");
    const registryInstance = {
      driver: ProviderDriverKind.make("acpRegistry"),
      enabled: true,
      config: { agentId: "kilo" },
    };
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [firstId]: registryInstance,
        [secondId]: registryInstance,
      },
    };
    let panel = renderPanel();
    const row = visitElements(
      panel,
      (element) => element.props.instanceId === firstId && element.props.mode === "list",
    );
    (row?.props.onSelect as (() => void) | undefined)?.();
    panel = renderPanel();
    const card = visitElements(
      panel,
      (element) => element.props.instanceId === firstId && element.props.mode === "editor",
    );
    (card?.props.onDelete as (() => void) | undefined)?.();
    await flushPromises();

    expect(settingsState.mutateProviderInstance).toHaveBeenCalledWith({
      operation: "remove",
      instanceId: firstId,
    });
    expect(commands.uninstall).toHaveBeenCalledWith({
      environmentId,
      input: { agentId: "kilo" },
    });
  });

  it("keeps the signed-in ACP account visible when login methods are no longer advertised", () => {
    const instanceId = ProviderInstanceId.make("acpRegistry_devin");
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: { agentId: "devin" },
        },
      },
    };
    atoms.providers = [
      {
        ...provider(),
        instanceId,
        driver: ProviderDriverKind.make("acpRegistry"),
        auth: { status: "authenticated", canLogout: false },
        setup: { canAuthenticate: false, canInstall: false },
      },
    ];
    const panel = renderPanel({ targetInstanceId: instanceId });
    expect(
      visitElements(
        panel,
        (element) =>
          typeof element.type === "function" &&
          element.type.name === "ProviderAuthenticationSection",
      ),
    ).not.toBeNull();
  });

  it("routes explicit ACP browser authentication consent to the selected environment", async () => {
    const instanceId = ProviderInstanceId.make("acpRegistry_antigravity");
    const action = {
      elicitationId: "google-login-1",
      url: "https://accounts.google.com/login",
      message: "Continue with Google",
    };
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: { agentId: "antigravity" },
        },
      },
    };
    atoms.providers = [
      {
        ...provider(),
        instanceId,
        driver: ProviderDriverKind.make("acpRegistry"),
        auth: { status: "unauthenticated", action },
      },
    ];

    const panel = renderPanel();
    const card = visitElements(panel, (element) => element.props.instanceId === instanceId);
    (card?.props.onAcceptUrlAuth as ((candidate: typeof action) => void) | undefined)?.(action);
    await flushPromises();

    expect(commands.acceptUrlAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, elicitationId: action.elicitationId },
    });
  });
});
