export const DASHLANE_EXTENSION_ID = "fdjamakpfbbddfjaooikfcpapjohcfmg";
export const DASHLANE_ACTIVE_TAB_CHANNEL = "t3code:dashlane-active-tab";
export const DASHLANE_OPEN_TAB_CHANNEL = "t3code:dashlane-open-tab";
export const DASHLANE_TAB_FOCUS_CHANNEL = "t3code:dashlane-tab-focus";
export const DASHLANE_ACTION_CHANNEL = "t3code:dashlane-action";

/** What the service worker reports about Dashlane's toolbar button; main validates every field. */
export type DashlaneActionMessage =
  | { readonly kind: "icon"; readonly path: unknown; readonly tabId: unknown }
  | { readonly kind: "title"; readonly title: unknown; readonly tabId: unknown }
  | { readonly kind: "openPopup" };

/**
 * Adds stand-ins for Chrome APIs Electron lacks; runs self-contained in the main world via `contextBridge.executeInMainWorld`.
 * `activeTabId`: the tab a popup opened over, since Electron reports no active tab once the popup is focused.
 * `openTab`: shows Dashlane pages Chrome would open as tabs. `onTabFocus`: preview tabs the user switched to.
 * `onAction`: mirrors `chrome.action` icon and title changes, which Electron does not render, and popup requests.
 */
export function installDashlaneApiShim(
  extensionId: string,
  activeTabId?: number,
  openTab?: (url: string) => Promise<unknown>,
  onTabFocus?: (focused: (tabId: number) => void) => void,
  onAction?: (message: DashlaneActionMessage) => void,
): ReadonlyArray<string> {
  type Callback = (value?: unknown) => void;
  type Tab = { readonly id?: number };
  type ChromeLike = Record<string, unknown> & {
    readonly tabs?: {
      query: (
        query: { readonly active?: boolean },
        callback?: (tabs: ReadonlyArray<Tab>) => void,
      ) => Promise<ReadonlyArray<Tab>> | undefined;
      readonly get: (tabId: number) => Promise<Tab>;
      getCurrent?: (...args: ReadonlyArray<unknown>) => Promise<unknown> | undefined;
      create?: (
        properties: { readonly url?: string },
        ...args: ReadonlyArray<unknown>
      ) => Promise<unknown> | undefined;
    };
    readonly runtime?: {
      readonly id?: string;
      readonly getManifest?: () => {
        readonly permissions?: ReadonlyArray<string>;
        readonly host_permissions?: ReadonlyArray<string>;
      };
    };
  };
  const { chrome, browser } = globalThis as { chrome?: ChromeLike; browser?: ChromeLike };
  const runtime = chrome?.runtime;
  if (chrome === undefined || runtime?.id !== extensionId) return [];

  const event = () => {
    const listeners = new Set<(...args: ReadonlyArray<unknown>) => void>();
    return {
      addListener: (listener: (...args: ReadonlyArray<unknown>) => void) =>
        void listeners.add(listener),
      removeListener: (listener: (...args: ReadonlyArray<unknown>) => void) =>
        void listeners.delete(listener),
      hasListener: (listener: (...args: ReadonlyArray<unknown>) => void) => listeners.has(listener),
      hasListeners: () => listeners.size > 0,
      dispatch: (...args: ReadonlyArray<unknown>) => {
        for (const listener of listeners) listener(...args);
      },
    };
  };
  // Chrome APIs answer through a trailing callback when given one, otherwise through a promise.
  const reply = (value: unknown, args: ReadonlyArray<unknown>): Promise<unknown> | undefined => {
    const result = Promise.resolve(value);
    const callback = args.findLast((arg): arg is Callback => typeof arg === "function");
    if (callback === undefined) return result;
    void result.then(callback, () => callback(undefined));
    return undefined;
  };
  const answer =
    (value: () => unknown) =>
    (...args: ReadonlyArray<unknown>) =>
      reply(value(), args);

  const manifest = runtime.getManifest?.() ?? {};
  const granted = new Set(manifest.permissions ?? []);
  const window = {
    id: 1,
    focused: true,
    incognito: false,
    alwaysOnTop: false,
    type: "normal",
    state: "normal",
  };
  const setting = (value: unknown) => ({
    get: answer(() => ({ value, levelOfControl: "not_controllable" })),
    set: answer(() => undefined),
    clear: answer(() => undefined),
    onChange: event(),
  });
  const shims: Record<string, unknown> = {
    contextMenus: {
      create: (...args: ReadonlyArray<unknown>) => (reply(undefined, args), 0),
      update: answer(() => undefined),
      remove: answer(() => undefined),
      removeAll: answer(() => undefined),
      onClicked: event(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2,
      get: answer(() => window),
      getCurrent: answer(() => window),
      getLastFocused: answer(() => window),
      getAll: answer(() => [window]),
      update: answer(() => window),
      onCreated: event(),
      onRemoved: event(),
      onFocusChanged: event(),
    },
    // The vault keeps its own session; reporting no browser cookies only skips Dashlane's cookie cleanup.
    cookies: {
      getAll: answer(() => []),
      remove: answer(() => null),
      onChanged: event(),
    },
    permissions: {
      contains: (request: { readonly permissions?: ReadonlyArray<string> }, ...args: unknown[]) =>
        reply(
          (request?.permissions ?? []).every((permission) => granted.has(permission)),
          args,
        ),
      getAll: answer(() => ({
        permissions: [...granted],
        origins: [...(manifest.host_permissions ?? [])],
      })),
      request: answer(() => false),
      remove: answer(() => false),
      onAdded: event(),
      onRemoved: event(),
    },
    privacy: {
      services: {
        passwordSavingEnabled: setting(false),
        autofillAddressEnabled: setting(false),
        autofillCreditCardEnabled: setting(false),
      },
    },
    commands: { getAll: answer(() => []), onCommand: event() },
  };
  const installed = new Set<string>();
  // Dashlane's web app replaces `chrome` with Chrome's separate `browser` namespace when it exists.
  const namespaces = new Set([chrome, browser ?? chrome]);
  for (const namespace of namespaces) {
    for (const [name, value] of Object.entries(shims)) {
      if (namespace[name] !== undefined) continue;
      Object.defineProperty(namespace, name, { value, configurable: true, enumerable: true });
      installed.add(name);
    }
  }
  const highlighted = event();
  const ownPages = [`chrome-extension://${extensionId}/`, "https://check.dashlane.com/"];
  for (const tabs of new Set([...namespaces].map((namespace) => namespace.tabs))) {
    if (tabs === undefined) continue;
    if (openTab !== undefined && tabs.create === undefined) {
      tabs.create = (properties, ...args) => {
        const url = properties?.url;
        const created =
          typeof url === "string" && ownPages.some((page) => url.startsWith(page))
            ? openTab(url)
            : // Matches Dashlane's own fallback; the popup's window-open handler vets the URL.
              void (globalThis as { open?: (url?: string) => unknown }).open?.(url);
        return reply(created, args);
      };
      installed.add("tabs.create");
    }
    if (onTabFocus !== undefined) {
      // Dashlane only analyses pages in tabs it was told are highlighted.
      Object.defineProperty(tabs, "onHighlighted", { value: highlighted, configurable: true });
      installed.add("tabs.onHighlighted");
    }
    if (activeTabId === undefined) continue;
    const query = tabs.query.bind(tabs);
    // A Chrome popup is not a tab, so its active tab stays the page it opened over, even once focused.
    tabs.query = (queryInfo, callback) => {
      const found =
        queryInfo?.active === true
          ? tabs.get(activeTabId).then(
              (tab) => [tab],
              () => [],
            )
          : (query(queryInfo) ?? Promise.resolve([]));
      if (callback === undefined) return found;
      void found.then(callback);
      return undefined;
    };
    installed.add("tabs.query");
    if (tabs.getCurrent === undefined) {
      tabs.getCurrent = answer(() => undefined);
      installed.add("tabs.getCurrent");
    }
  }
  onTabFocus?.((tabId) => highlighted.dispatch({ tabIds: [tabId], windowId: window.id }));
  const action = chrome["action"] as Record<string, unknown> | undefined;
  if (onAction !== undefined && action !== undefined) {
    const report = (message: DashlaneActionMessage) => {
      try {
        onAction(message);
      } catch {
        // Reporting is best effort; Chrome's own call still runs.
      }
    };
    const mirror = (
      name: string,
      toMessage: (details: Record<string, unknown>) => DashlaneActionMessage,
    ) => {
      const native = action[name];
      if (typeof native !== "function") return;
      // Dashlane calls these detached from `chrome.action`.
      action[name] = (
        details: Record<string, unknown> | undefined,
        ...args: ReadonlyArray<unknown>
      ) => {
        report(toMessage(details ?? {}));
        return native.call(action, details, ...args);
      };
      installed.add(`action.${name}`);
    };
    mirror("setIcon", (details) => ({
      kind: "icon",
      path: details["path"],
      tabId: details["tabId"],
    }));
    mirror("setTitle", (details) => ({
      kind: "title",
      title: details["title"],
      tabId: details["tabId"],
    }));
    // Electron accepts openPopup but shows nothing; T3 opens the popup from its own toolbar instead.
    action["openPopup"] = (...args: ReadonlyArray<unknown>) => {
      report({ kind: "openPopup" });
      return reply(undefined, args);
    };
    installed.add("action.openPopup");
  }
  return [...installed];
}
