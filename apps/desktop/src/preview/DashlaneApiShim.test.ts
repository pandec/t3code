import { assert, describe, expect, it } from "vite-plus/test";

import { DASHLANE_EXTENSION_ID, installDashlaneApiShim } from "./DashlaneApiShim.ts";

type Shimmed = Record<string, Record<string, (...args: unknown[]) => unknown>>;

// executeInMainWorld serializes the function, so tests run the serialized copy to catch closure captures.
const runSerialized = (
  chrome: unknown,
  ...args: DropFirst<Parameters<typeof installDashlaneApiShim>>
): ReadonlyArray<string> => {
  const global = globalThis as { chrome?: unknown };
  const previous = global.chrome;
  global.chrome = chrome;
  try {
    const install = new Function(
      `return (${installDashlaneApiShim.toString()})`,
    )() as typeof installDashlaneApiShim;
    return install(DASHLANE_EXTENSION_ID, ...args);
  } finally {
    global.chrome = previous;
  }
};
type DropFirst<T extends ReadonlyArray<unknown>> = T extends readonly [unknown, ...infer Rest]
  ? Rest
  : never;

const dashlaneChrome = (extra: Record<string, unknown> = {}) => ({
  runtime: {
    id: DASHLANE_EXTENSION_ID,
    getManifest: () => ({ permissions: ["tabs", "storage"], host_permissions: ["https://*/*"] }),
  },
  ...extra,
});

describe("installDashlaneApiShim", () => {
  it("fills only missing APIs, and only inside Dashlane", async () => {
    const existingAlarms = { create: () => undefined };
    const chrome = dashlaneChrome({ alarms: existingAlarms, cookies: { getAll: () => "native" } });
    expect(runSerialized(chrome)).toEqual([
      "contextMenus",
      "windows",
      "permissions",
      "privacy",
      "commands",
    ]);
    expect((chrome as unknown as Shimmed)["cookies"]?.["getAll"]?.()).toBe("native");
    expect(chrome).toHaveProperty("alarms", existingAlarms);

    // Chrome's separate `browser` namespace is what Dashlane's web app reassigns `chrome` to.
    const global = globalThis as { browser?: unknown };
    const browser = dashlaneChrome();
    global.browser = browser;
    try {
      runSerialized(dashlaneChrome());
    } finally {
      delete global.browser;
    }
    expect(browser).toHaveProperty("cookies");

    const other = { runtime: { id: "abcdefghijklmnopabcdefghijklmnop" } };
    expect(runSerialized(other)).toEqual([]);
    expect(other).not.toHaveProperty("contextMenus");
  });

  it("answers through callbacks or promises like Chrome", async () => {
    const chrome = dashlaneChrome() as unknown as Shimmed;
    runSerialized(chrome);
    const permissions = chrome["permissions"]!;

    await expect(permissions["contains"]!({ permissions: ["tabs"] })).resolves.toBe(true);
    await expect(permissions["contains"]!({ permissions: ["downloads"] })).resolves.toBe(false);
    const viaCallback = await new Promise((resolve) => {
      expect(permissions["request"]!({ permissions: ["downloads"] }, resolve)).toBeUndefined();
    });
    expect(viaCallback).toBe(false);

    const listener = () => undefined;
    const onClicked = chrome["contextMenus"]!["onClicked"] as unknown as Shimmed[string];
    onClicked["addListener"]!(listener);
    expect(onClicked["hasListener"]!(listener)).toBe(true);
  });

  it("lets a popup window find the tab it was opened for", async () => {
    const openerTab = { id: 7, url: "https://example.com/login" };
    const tabs = {
      query: async (query: { active?: boolean }) => (query.active ? [] : [openerTab]),
      get: async (tabId: number) => {
        if (tabId !== openerTab.id) throw new Error("No tab");
        return openerTab;
      },
    };
    expect(runSerialized(dashlaneChrome({ tabs }), 7)).toContain("tabs.query");
    await expect(tabs.query({ active: true })).resolves.toEqual([openerTab]);
    await expect(tabs.query({})).resolves.toEqual([openerTab]);
    const viaCallback = await new Promise((resolve) => {
      expect(
        (tabs.query as (query: unknown, callback: unknown) => unknown)({ active: true }, resolve),
      ).toBeUndefined();
    });
    expect(viaCallback).toEqual([openerTab]);

    const closedTabs = { query: async (_query: { active?: boolean }) => [], get: tabs.get };
    runSerialized(dashlaneChrome({ tabs: closedTabs }), 8);
    await expect(closedTabs.query({ active: true })).resolves.toEqual([]);
  });

  it("lets a popup open Dashlane's web app and then close itself", async () => {
    const tabs: Shimmed[string] = { query: async () => [], get: async () => ({}) };
    const opened: string[] = [];
    const openTab = async (url: string) => (opened.push(url), { id: 9, url });
    const externalOpens: unknown[] = [];
    const global = globalThis as { open?: unknown };
    const previousOpen = global.open;
    global.open = (url: unknown) => void externalOpens.push(url);
    try {
      expect(runSerialized(dashlaneChrome({ tabs }), 7, openTab)).toEqual(
        expect.arrayContaining(["tabs.create", "tabs.getCurrent"]),
      );
      // Dashlane's "Open the web app" calls tabs.create with a callback, then closes when getCurrent finds no tab.
      const login = `chrome-extension://${DASHLANE_EXTENSION_ID}/vault/index.html#/login`;
      const created = await new Promise((resolve) => {
        expect(tabs["create"]!({ url: login }, resolve)).toBeUndefined();
      });
      expect(created).toEqual({ id: 9, url: login });
      const current = await new Promise((resolve) => {
        expect(tabs["getCurrent"]!(resolve)).toBeUndefined();
      });
      expect(current).toBeUndefined();

      await expect(tabs["create"]!({ url: "https://www.dashlane.com/" })).resolves.toBeUndefined();
      expect(externalOpens).toEqual(["https://www.dashlane.com/"]);
      expect(opened).toEqual([login]);
    } finally {
      global.open = previousOpen;
    }
  });

  it("lets the service worker open Dashlane's security check", async () => {
    const tabs: Shimmed[string] = { query: async () => [], get: async () => ({}) };
    const check = { id: 4, url: "https://check.dashlane.com/", status: "complete" };
    const openTab = async (url: string) => ({ ...check, url });
    expect(runSerialized(dashlaneChrome({ tabs }), undefined, openTab)).toContain("tabs.create");
    expect(tabs).not.toHaveProperty("getCurrent");
    const created = await new Promise((resolve) => {
      tabs["create"]!({ url: check.url }, resolve);
    });
    expect(created).toEqual(check);
  });

  it("raises tabs.onHighlighted for preview tabs T3 reports as focused", () => {
    const tabs: Shimmed[string] = { query: async () => [], get: async () => ({}) };
    let focus: ((tabId: number) => void) | undefined;
    const installed = runSerialized(dashlaneChrome({ tabs }), undefined, undefined, (focused) => {
      focus = focused;
    });
    expect(installed).toContain("tabs.onHighlighted");
    const highlights: unknown[] = [];
    const onHighlighted = tabs["onHighlighted"] as unknown as Shimmed[string];
    onHighlighted["addListener"]!((info: unknown) => void highlights.push(info));
    focus!(5);
    expect(highlights).toEqual([{ tabIds: [5], windowId: 1 }]);
  });

  it("reports toolbar icon, title and popup requests, keeping Chrome's own icon calls", async () => {
    const calls: unknown[] = [];
    const action: Shimmed[string] = {
      setIcon: function (this: unknown, details: unknown, callback: unknown) {
        calls.push(["setIcon", this === action, details]);
        if (typeof callback === "function") callback();
      },
      setTitle: (details: unknown) => void calls.push(["setTitle", details]),
      openPopup: () => assert.fail("Electron's openPopup shows nothing"),
    };
    const messages: unknown[] = [];
    const installed = runSerialized(
      dashlaneChrome({ action }),
      undefined,
      undefined,
      undefined,
      (message) => void messages.push(message),
    );
    expect(installed).toEqual(
      expect.arrayContaining(["action.setIcon", "action.setTitle", "action.openPopup"]),
    );
    const icon = { 16: "icons/action/icon_auth.png", 32: "icons/action/icon_auth@2x.png" };
    // Dashlane calls setIcon detached from chrome.action and waits for its callback.
    const { setIcon } = action;
    await new Promise((resolve) => setIcon!({ path: icon }, resolve));
    action["setTitle"]!({ title: "Locked", tabId: 4 });
    await new Promise((resolve) => action["openPopup"]!({}, resolve));
    expect(calls).toEqual([
      ["setIcon", true, { path: icon }],
      ["setTitle", { title: "Locked", tabId: 4 }],
    ]);
    expect(messages).toEqual([
      { kind: "icon", path: icon, tabId: undefined },
      { kind: "title", title: "Locked", tabId: 4 },
      { kind: "openPopup" },
    ]);
  });
});
