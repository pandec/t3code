import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_CLIENT_SETTINGS,
  type BrowserExtensionSettings,
  updateBrowserExtensionSettings,
} from "@t3tools/contracts";
import type * as Electron from "electron";
import type { Session, WebContents } from "electron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { type Mock, vi } from "vite-plus/test";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import {
  DASHLANE_ACTION_CHANNEL,
  DASHLANE_EXTENSION_ID,
  DASHLANE_OPEN_TAB_CHANNEL,
  DASHLANE_TAB_FOCUS_CHANNEL,
} from "./DashlaneApiShim.ts";
import {
  extensionAssetPath,
  extensionIdFromManifestKey,
  make,
  type PreviewDashlane,
  type PreviewDashlaneEvent,
} from "./Dashlane.ts";

const electron = vi.hoisted(() => {
  const windows: Array<FakeWindow> = [];
  const guests = new Map<number, unknown>();
  const paths = { userData: "/test/userData" };
  let nextId = 100;
  class FakeWindow {
    readonly handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    readonly events = new Map<string, (...args: unknown[]) => void>();
    readonly windowEvents = new Map<string, Set<() => void>>();
    auxiliary = false;
    readonly loadURL = vi.fn((_url: string) => Promise.resolve());
    readonly focus = vi.fn();
    destroyed = false;
    readonly webContents = {
      id: nextId++,
      mainFrame: {},
      ipc: {
        on: () => undefined,
        handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
          this.handlers.set(channel, handler),
      },
      setWindowOpenHandler: () => undefined,
      getURL: () => this.loadURL.mock.calls.at(-1)?.[0] ?? "",
      on: (name: string, listener: (...args: unknown[]) => void) => this.events.set(name, listener),
    };
    readonly options: { readonly webPreferences?: unknown };
    constructor(options: { readonly webPreferences?: unknown }) {
      this.options = options;
      windows.push(this);
    }
    static fromWebContents = (contents: { readonly window?: unknown }) => contents.window ?? null;
    static getFocusedWindow = () => null;
    on = () => undefined;
    once = (name: string, listener: () => void) => {
      const listeners = this.windowEvents.get(name) ?? new Set();
      this.windowEvents.set(name, listeners.add(listener));
    };
    removeListener = (name: string, listener: () => void) =>
      void this.windowEvents.get(name)?.delete(listener);
    isDestroyed = () => this.destroyed;
    destroy = () => {
      if (this.destroyed) return;
      this.destroyed = true;
      for (const listener of this.windowEvents.get("closed") ?? []) listener();
    };
  }
  return { windows, guests, paths, FakeWindow };
});

vi.mock("electron", () => ({
  BrowserWindow: electron.FakeWindow,
  app: { getPath: () => electron.paths.userData },
  shell: {},
  webContents: { fromId: (id: number) => electron.guests.get(id) },
}));

type FakeWorker = {
  readonly scope: string;
  readonly handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
  readonly ipc: unknown;
};

const EXTENSION_DIR = `/test/userData/browser-extensions/${DASHLANE_EXTENSION_ID}`;
const HOST_ID = 1;
const host = {
  id: HOST_ID,
  getZoomFactor: () => 1,
  window: { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }) },
};

const NO_UPDATE_XML = `<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0" server="prod"><app appid="${DASHLANE_EXTENSION_ID}" status="ok"><updatecheck status="noupdate"/></app></gupdate>`;

const makeHarness = Effect.fn("DashlaneTest.makeHarness")(function* (
  options: {
    readonly beforeRead?: Effect.Effect<void>;
    /** Runs against real files below this userData directory instead of the fake install. */
    readonly userData?: string;
  } = {},
) {
  const beforeRead = options.beforeRead ?? Effect.void;
  electron.paths.userData = options.userData ?? "/test/userData";
  const config = DesktopConfig.layerTest({});
  const settingsReads = yield* Queue.unbounded<void>();
  const requests = yield* Queue.unbounded<URL>();
  let respond = (_url: URL) => new Response(NO_UPDATE_XML);
  const httpClient = HttpClient.make((request, url) =>
    Queue.offer(requests, url).pipe(
      Effect.andThen(Effect.sync(() => HttpClientResponse.fromWeb(request, respond(url)))),
    ),
  );
  let settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    browserProfiles: [{ id: "profile-1", name: "Work", kind: "persistent" as const }],
    browserExtensions: updateBrowserExtensionSettings({}, DASHLANE_EXTENSION_ID, {
      enabled: true,
      profileIds: ["default", "profile-1"],
    }),
  };
  let installed = true;
  const preloads = new Map<string, { id: string }>();
  const workerListeners = new Set<
    (details: { versionId: number; runningStatus: string }) => void
  >();
  const workers = new Map<number, FakeWorker>();
  const workerSend = vi.fn();
  const loadExtension = vi.fn(() => Promise.resolve({ id: DASHLANE_EXTENSION_ID }));
  const removeExtension = vi.fn();
  const session = {
    registerPreloadScript: (script: { id: string }) => preloads.set(script.id, script),
    unregisterPreloadScript: (id: string) => preloads.delete(id),
    getPreloadScripts: () => [...preloads.values()],
    extensions: { loadExtension, removeExtension },
    serviceWorkers: {
      on: (_name: string, listener: (details: { versionId: number }) => void) =>
        void workerListeners.add(listener),
      removeListener: (_name: string, listener: (details: { versionId: number }) => void) =>
        void workerListeners.delete(listener),
      getWorkerFromVersionID: (versionId: number) => workers.get(versionId),
      startWorkerForScope: vi.fn((scope: string) => Promise.resolve({ scope, send: workerSend })),
    },
  } as unknown as Session;
  const missing = (path: string) =>
    PlatformError.systemError({
      _tag: "NotFound",
      module: "FileSystem",
      method: "read",
      pathOrDescriptor: path,
    });
  const readFileString = vi.fn((path: string) =>
    beforeRead.pipe(
      Effect.andThen(
        installed && path === `${EXTENSION_DIR}/manifest.json`
          ? Effect.succeed(
              JSON.stringify({
                key: DASHLANE_PUBLIC_KEY,
                manifest_version: 3,
                version: "6.2645.0",
                action: {
                  default_icon: {
                    16: "icons/action/icon_loading.png",
                    32: "icons/action/icon_loading@2x.png",
                  },
                  default_title: "Dashlane",
                },
              }),
            )
          : Effect.fail(missing(path)),
      ),
    ),
  );
  // Each icon file holds its own name, so a data URL shows which file was read.
  const readFile = vi.fn((path: string) =>
    path.startsWith(`${EXTENSION_DIR}/icons/`)
      ? Effect.succeed(new TextEncoder().encode(path.slice(EXTENSION_DIR.length + 1)))
      : Effect.fail(missing(path)),
  );
  const links = new Map<string, string>();
  const realPath = vi.fn((path: string) => Effect.succeed(links.get(path) ?? path));
  const mainWindow = new electron.FakeWindow({});
  const service = yield* make.pipe(
    Effect.provide(
      Layer.mergeAll(
        config,
        DesktopEnvironment.layer({
          dirname: "/test",
          homeDirectory: "/test/home",
          platform: "darwin",
          processArch: "arm64",
          appVersion: "1.0.0",
          appPath: "/test/app",
          isPackaged: false,
          resourcesPath: "/test/resources",
          runningUnderArm64Translation: false,
        }).pipe(Layer.provide(config)),
        Layer.succeed(DesktopClientSettings.DesktopClientSettings, {
          get: Queue.offer(settingsReads, undefined).pipe(
            Effect.andThen(Effect.sync(() => Option.some(settings))),
          ),
          set: () => Effect.void,
        }),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.mock(ElectronWindow.ElectronWindow)({
          create: (options, behavior) =>
            Effect.sync(() => {
              const window = new electron.FakeWindow(options);
              window.auxiliary = behavior?.auxiliary === true;
              return window as unknown as Electron.BrowserWindow;
            }),
          main: Effect.sync(() =>
            mainWindow.isDestroyed()
              ? Option.none()
              : Option.some(mainWindow as unknown as Electron.BrowserWindow),
          ),
        }),
        options.userData === undefined
          ? FileSystem.layerNoop({ readFileString, readFile, realPath })
          : Layer.empty,
      ),
    ),
  );
  const addGuest = (id: number) => {
    const events = new Map<string, (...args: unknown[]) => void>();
    const guest = {
      id,
      session,
      hostWebContents: host,
      destroyed: false,
      isDestroyed: () => guest.destroyed,
      on: (name: string, listener: (...args: unknown[]) => void) => void events.set(name, listener),
      removeListener: (name: string, listener: (...args: unknown[]) => void) => {
        if (events.get(name) === listener) events.delete(name);
      },
      events,
    };
    electron.guests.set(id, guest);
    service.trackGuest(guest as unknown as WebContents);
    return guest;
  };
  return {
    service,
    /** Tells the service the settings were saved, as the settings IPC does, and waits until they apply. */
    refresh: () => service.refreshProfiles(settings).pipe(Effect.flatMap(Fiber.join)),
    /** Tells the service the settings were saved without waiting, as the settings IPC does. */
    save: () => service.refreshProfiles(settings),
    mainWindow,
    session,
    preloads,
    loadExtension,
    removeExtension,
    readFileString,
    readFile,
    links,
    workerListeners,
    workerSend,
    addGuest,
    startWorker: (versionId: number, scope: string) => {
      const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
      workers.set(versionId, {
        scope,
        handlers,
        ipc: {
          handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
            void handlers.set(channel, handler),
          removeHandler: (channel: string) => void handlers.delete(channel),
          on: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
            void handlers.set(channel, handler),
          removeAllListeners: (channel: string) => void handlers.delete(channel),
        },
      });
      for (const listener of workerListeners) listener({ versionId, runningStatus: "starting" });
      return handlers;
    },
    configure: (patch: Partial<BrowserExtensionSettings>) => {
      settings = {
        ...settings,
        browserExtensions: updateBrowserExtensionSettings(
          settings.browserExtensions,
          DASHLANE_EXTENSION_ID,
          patch,
        ),
      };
    },
    setInstalled: (value: boolean) => {
      installed = value;
    },
    settingsReads,
    requests,
    respondWith: (next: (url: URL) => Response) => {
      respond = next;
    },
  };
});

const testServices = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const installation = (test: { readonly service: PreviewDashlane["Service"] }) =>
  test.service.listInstallations.pipe(Effect.map((installations) => installations[0]!));
const rejects = (pending: unknown) =>
  Effect.promise(() =>
    Promise.resolve(pending).then(
      () => assert.fail("opened a page it should not"),
      () => undefined,
    ),
  );
const iconUrl = (file: string) =>
  `data:image/png;base64,${Buffer.from(`icons/action/${file}`).toString("base64")}`;

// Dashlane's public Chrome Web Store key, as found in the signed CRX header.
const DASHLANE_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArf+Mb0ro41bJ+FURIhp7YhwTyaP1UbJY2pMApYFTnl1F++bW65Zf80pwIRFt4b6VUQ7qt3kNE3XWrN5VUpbO5pasQZLk4czaEJzFBGPsxFfe89guXb2Xd6CGAHpfdn+wPIU8hMie0ajoUqIC+YWjEZJ0vf3lP0r9EpEbPUSCdg1SjvLb/NzNzq2h/Eev/BfcrEZ7e3wEb9NgM2/pdP2tfowmBg6xLuoiUz2TaQbTVoBRgmkpik3gy4KojFaHgdidT7AVGIpmHZycEd491E9MG/mHuQ0nWZD9pJOp9n1dBHA4LAq5WxU6f/K+h+qhekWO7KVK0M3/mwxxGhizPbjpJQIDAQAB";

describe("extensionIdFromManifestKey", () => {
  it.effect("maps Dashlane's key to its Web Store id and other keys elsewhere", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* extensionIdFromManifestKey(DASHLANE_PUBLIC_KEY),
        DASHLANE_EXTENSION_ID,
      );
      assert.notStrictEqual(
        yield* extensionIdFromManifestKey(DASHLANE_PUBLIC_KEY.replace("MIIB", "MIIC")),
        DASHLANE_EXTENSION_ID,
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

describe("Dashlane session lifecycle", () => {
  it.effect("shares first-load verification across simultaneous tabs", () =>
    Effect.gen(function* () {
      const readStarted = yield* Deferred.make<void>();
      const allowRead = yield* Deferred.make<void>();
      const firstDone = yield* Deferred.make<void>();
      const secondDone = yield* Deferred.make<void>();
      const test = yield* makeHarness({
        beforeRead: Deferred.succeed(readStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowRead)),
        ),
      });
      const first = yield* test.service
        .prepareSession(test.session, "profile-1")
        .pipe(
          Effect.andThen(Deferred.succeed(firstDone, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Deferred.await(readStarted);
      const second = yield* test.service
        .prepareSession(test.session, "profile-1")
        .pipe(
          Effect.andThen(Deferred.succeed(secondDone, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
      assert.strictEqual(test.readFileString.mock.calls.length, 1);
      assert.isFalse(yield* Deferred.isDone(firstDone));
      assert.isFalse(yield* Deferred.isDone(secondDone));
      yield* Deferred.succeed(allowRead, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.strictEqual(test.loadExtension.mock.calls.length, 1);
      assert.deepStrictEqual(test.loadExtension.mock.calls[0], [EXTENSION_DIR]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.effect("follows the extension setting without a restart", () =>
    Effect.gen(function* () {
      const test = yield* makeHarness();
      test.addGuest(7);
      const running = () =>
        test.service.listActions(HOST_ID, 7).pipe(Effect.map((actions) => actions.length > 0));

      yield* test.service.prepareSession(test.session, undefined);
      assert.isTrue(yield* running());

      const events = yield* Queue.unbounded<PreviewDashlaneEvent>();
      yield* test.service.subscribe((event) => Queue.offer(events, event).pipe(Effect.asVoid));
      test.configure({ enabled: false });
      yield* test.refresh();
      assert.isFalse(yield* running());
      assert.deepStrictEqual(test.removeExtension.mock.calls, [[DASHLANE_EXTENSION_ID]]);
      assert.strictEqual(test.preloads.size, 0);

      // Prepared sessions load again when the setting comes back, before any new tab asks.
      test.configure({ enabled: true });
      yield* test.refresh();
      assert.isTrue(yield* running());
      assert.strictEqual(test.loadExtension.mock.calls.length, 2);
      // Neither change touched the installed files, so Settings is not told to reload them.
      const tags = [yield* Queue.take(events), yield* Queue.take(events)].map(
        (event) => event._tag,
      );
      assert.deepStrictEqual(tags, ["ActionsChanged", "ActionsChanged"]);

      test.configure({ profileIds: ["profile-1"] });
      yield* test.refresh();
      assert.isFalse(yield* running());
      assert.strictEqual(test.removeExtension.mock.calls.length, 2);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.effect("saves of other settings never wait for a load", () =>
    Effect.gen(function* () {
      const allowRead = yield* Deferred.make<void>();
      let gated = false;
      const test = yield* makeHarness({
        beforeRead: Effect.suspend(() => (gated ? Deferred.await(allowRead) : Effect.void)),
      });
      yield* test.refresh();
      gated = true;
      const loading = yield* test.service
        .prepareSession(test.session, undefined)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* test.refresh();
      assert.strictEqual(test.loadExtension.mock.calls.length, 0);
      yield* Deferred.succeed(allowRead, undefined);
      yield* Fiber.join(loading);
      assert.strictEqual(test.loadExtension.mock.calls.length, 1);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.effect("saves that change Dashlane return before its load finishes", () =>
    Effect.gen(function* () {
      const allowRead = yield* Deferred.make<void>();
      let gated = false;
      const test = yield* makeHarness({
        beforeRead: Effect.suspend(() => (gated ? Deferred.await(allowRead) : Effect.void)),
      });
      test.configure({ enabled: false });
      yield* test.service.prepareSession(test.session, undefined);
      gated = true;
      test.configure({ enabled: true });
      const applying = yield* test.save();
      assert.strictEqual(test.loadExtension.mock.calls.length, 0);
      yield* Deferred.succeed(allowRead, undefined);
      yield* Fiber.join(applying);
      assert.strictEqual(test.loadExtension.mock.calls.length, 1);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.effect("loads once installed, and never into incognito", () =>
    Effect.gen(function* () {
      const test = yield* makeHarness();
      test.configure({ profileIds: ["default", "incognito"] });
      yield* test.service.prepareSession(test.session, "incognito");
      assert.strictEqual(test.readFileString.mock.calls.length, 0);

      test.setInstalled(false);
      yield* test.service.prepareSession(test.session, "default");
      assert.strictEqual(test.loadExtension.mock.calls.length, 0);
      assert.strictEqual(test.preloads.size, 0);
      assert.deepInclude(yield* installation(test), {
        id: DASHLANE_EXTENSION_ID,
        name: "Dashlane",
        directory: EXTENSION_DIR,
        version: null,
      });

      // A later setting change retries.
      test.setInstalled(true);
      test.configure({ profileIds: ["default"] });
      yield* test.refresh();
      assert.strictEqual(test.loadExtension.mock.calls.length, 1);
      assert.strictEqual((yield* installation(test)).version, "6.2645.0");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );
});

describe("extensionAssetPath", () => {
  it("keeps icon paths inside the extension", () => {
    assert.deepStrictEqual(extensionAssetPath("icons/action/icon_auth.png"), [
      "icons",
      "action",
      "icon_auth.png",
    ]);
    assert.deepStrictEqual(extensionAssetPath("/./icons/a.png"), ["icons", "a.png"]);
    for (const outside of [
      "../secret.png",
      "icons/../../secret.png",
      "icons//a.png",
      "icons\\..\\..\\secret.png",
      "C:/secret.png",
      "file:///etc/secret.png",
      "icons/action/icon_auth.svg",
    ]) {
      assert.isUndefined(extensionAssetPath(outside), outside);
    }
  });
});

describe("Dashlane toolbar action", () => {
  it.effect("shows each tab the icon and title Dashlane set, falling back like Chrome", () =>
    Effect.gen(function* () {
      const test = yield* makeHarness();
      const events = yield* Queue.unbounded<PreviewDashlaneEvent>();
      yield* test.service.subscribe((event) => Queue.offer(events, event).pipe(Effect.asVoid));
      const tab = test.addGuest(7);
      const other = test.addGuest(8);
      yield* test.service.prepareSession(test.session, undefined);
      yield* Queue.take(events);
      const report = test
        .startWorker(1, `chrome-extension://${DASHLANE_EXTENSION_ID}/`)
        .get(DASHLANE_ACTION_CHANNEL)!;
      const action = (guestId: number) =>
        test.service.listActions(HOST_ID, guestId).pipe(Effect.map((actions) => actions[0]));

      assert.deepStrictEqual(yield* action(7), {
        id: DASHLANE_EXTENSION_ID,
        name: "Dashlane",
        title: "Dashlane",
        icon: iconUrl("icon_loading@2x.png"),
      });

      // Dashlane sets its locked state for every tab at once.
      const icons = (name: string) => ({
        16: `icons/action/${name}.png`,
        32: `icons/action/${name}@2x.png`,
      });
      report({}, { kind: "icon", path: icons("icon_not_auth") });
      assert.deepStrictEqual(yield* Queue.take(events), {
        _tag: "ActionsChanged",
        webContentsId: null,
      });
      report({}, { kind: "icon", path: "icons/action/icon_auth.png", tabId: 7 });
      report({}, { kind: "title", title: "Unlocked", tabId: 7 });
      yield* Queue.take(events);
      yield* Queue.take(events);
      // Repeating an appearance tells nobody.
      report({}, { kind: "title", title: "Unlocked", tabId: 7 });
      report({}, { kind: "title", title: "Dashlane", tabId: 8 });
      assert.deepStrictEqual(yield* Queue.take(events), {
        _tag: "ActionsChanged",
        webContentsId: 8,
      });
      assert.deepInclude(yield* action(7), {
        icon: iconUrl("icon_auth@2x.png"),
        title: "Unlocked",
      });
      assert.deepInclude(yield* action(8), {
        icon: iconUrl("icon_not_auth@2x.png"),
        title: "Dashlane",
      });

      // Paths outside the extension are never read.
      const reads = test.readFile.mock.calls.length;
      report({}, { kind: "icon", path: "../../secret.png", tabId: 8 });
      report({}, { kind: "icon", path: { 16: 42 }, tabId: 8 });
      report({}, { kind: "icon", path: icons("icon_auth"), tabId: 8 });
      yield* Queue.take(events);
      assert.strictEqual(test.readFile.mock.calls.length, reads);
      assert.deepInclude(yield* action(8), { icon: iconUrl("icon_auth@2x.png") });
      // Nor is a symlink inside the extension that points outside it.
      test.links.set(`${EXTENSION_DIR}/icons/action/leak.png`, "/Users/someone/.ssh/id_ed25519");
      report({}, { kind: "icon", path: "icons/action/leak.png", tabId: 8 });
      assert.notDeepInclude(test.readFile.mock.calls, [`${EXTENSION_DIR}/icons/action/leak.png`]);
      assert.deepInclude(yield* action(8), { icon: iconUrl("icon_auth@2x.png") });

      // Only the renderer hosting a tab may read it, and a closed tab's state goes with it.
      assert.deepStrictEqual(yield* test.service.listActions(2, 7), []);
      other.events.get("destroyed")!();
      assert.deepInclude(yield* action(8), { icon: iconUrl("icon_not_auth@2x.png") });
      other.destroyed = true;

      // An in-page prompt asks the background to open the popup for the tab the user pressed in,
      // never for a closed one.
      other.events.get("input-event")!({}, { type: "mouseDown" });
      report({}, { kind: "openPopup" });
      tab.events.get("input-event")!({}, { type: "mouseDown" });
      report({}, { kind: "openPopup" });
      assert.deepStrictEqual(yield* Queue.take(events), {
        _tag: "PopupRequested",
        webContentsId: 7,
        extensionId: DASHLANE_EXTENSION_ID,
      });
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );
});

describe("Dashlane popup navigation", () => {
  it.effect("opens Dashlane's own pages from its popup in one sandboxed window", () =>
    Effect.gen(function* () {
      const test = yield* makeHarness();
      yield* test.service.prepareSession(test.session, "profile-1");
      const opener = test.addGuest(2);
      yield* test.service.openPopup(HOST_ID, 2, DASHLANE_EXTENSION_ID, {
        x: 900,
        y: 10,
        width: 24,
        height: 24,
      });
      const popup = electron.windows.at(-1)!;
      assert.deepInclude(popup.options as Record<string, unknown>, { frame: false });
      // T3's menus, broadcasts and Dock activation pass Dashlane's windows by.
      assert.isTrue(popup.auxiliary);
      const openTab = popup.handlers.get(DASHLANE_OPEN_TAB_CHANNEL)!;
      const fromPopup = { senderFrame: popup.webContents.mainFrame };
      const page = (route: string) =>
        `chrome-extension://${DASHLANE_EXTENSION_ID}/vault/index.html#/${route}`;

      assert.throws(() => openTab({ senderFrame: {} }, page("login")));
      yield* rejects(openTab(fromPopup, "https://example.com/"));
      assert.strictEqual(electron.windows.at(-1), popup);

      const tab = yield* Effect.promise(() => Promise.resolve(openTab(fromPopup, page("login"))));
      const vault = electron.windows.at(-1)!;
      assert.notStrictEqual(vault, popup);
      assert.deepStrictEqual(tab, { id: vault.webContents.id, url: page("login") });
      assert.deepInclude(vault.options.webPreferences, {
        session: test.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      });
      assert.deepStrictEqual(vault.loadURL.mock.calls, [[page("login")]]);
      assert.isTrue(vault.auxiliary);

      yield* Effect.promise(() => Promise.resolve(openTab(fromPopup, page("signup"))));
      assert.strictEqual(electron.windows.at(-1), vault);
      assert.deepStrictEqual(vault.loadURL.mock.calls.at(-1), [page("signup")]);
      assert.strictEqual(vault.focus.mock.calls.length, 1);
      // Reusing an open page goes through Chrome's own tabs.update, which only routes the page.
      vault.events.get("did-navigate-in-page")!({}, page("login"), true);
      assert.strictEqual(vault.focus.mock.calls.length, 2);

      // A popup outlives neither the tab it was opened for nor the extension.
      opener.events.get("destroyed")!();
      assert.isTrue(popup.isDestroyed());
      assert.isFalse(vault.isDestroyed());

      test.configure({ enabled: false });
      yield* test.refresh();
      assert.isTrue(vault.isDestroyed());
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );
});

describe("Dashlane security check", () => {
  it.effect("opens only Dashlane's check page for its service worker, one window at a time", () =>
    Effect.gen(function* () {
      const test = yield* makeHarness();
      yield* test.service.prepareSession(test.session, "profile-1");
      const other = test.startWorker(1, "https://example.com/");
      assert.strictEqual(other.size, 0);
      const openTab = test
        .startWorker(2, `chrome-extension://${DASHLANE_EXTENSION_ID}/`)
        .get(DASHLANE_OPEN_TAB_CHANNEL)!;
      const checkUrl = "https://check.dashlane.com/";

      yield* rejects(openTab({}, "https://example.com/"));
      const first = yield* Effect.promise(() => Promise.resolve(openTab({}, checkUrl)));
      const check = electron.windows.at(-1)!;
      assert.deepInclude(check.options.webPreferences, {
        session: test.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      });
      assert.deepStrictEqual(check.loadURL.mock.calls, [[checkUrl]]);
      // Dashlane asks the check page for a token only once its tab reports complete.
      assert.deepInclude(first, { id: check.webContents.id, status: "complete" });
      assert.isTrue(check.auxiliary);

      // A server redirect is held to the same origin as a navigation; Turnstile's frames are not.
      const blocked = (name: string, url: string, isMainFrame = true) => {
        const preventDefault = vi.fn();
        check.events.get(name)!({ url, isMainFrame, preventDefault });
        return preventDefault.mock.calls.length > 0;
      };
      for (const name of ["will-navigate", "will-redirect"]) {
        assert.isTrue(blocked(name, "https://attacker.example/"), name);
        assert.isFalse(blocked(name, `${checkUrl}?step=2`), name);
      }
      assert.isFalse(blocked("will-redirect", "https://challenges.cloudflare.com/", false));

      yield* Effect.promise(() => Promise.resolve(openTab({}, checkUrl)));
      assert.isTrue(check.isDestroyed());
      const second = electron.windows.at(-1)!;
      assert.notStrictEqual(second, check);

      // It closes with T3's window, so closing that still quits on Windows and Linux.
      test.mainWindow.destroy();
      assert.isTrue(second.isDestroyed());
      yield* Effect.promise(() => Promise.resolve(openTab({}, checkUrl)));
      const third = electron.windows.at(-1)!;

      test.configure({ enabled: false });
      yield* test.refresh();
      assert.isTrue(third.isDestroyed());
      assert.strictEqual(test.workerListeners.size, 0);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );
});

describe("Dashlane tab focus", () => {
  it.effect("reports the first press on each page of an enabled, open preview tab", () =>
    Effect.gen(function* () {
      const test = yield* makeHarness();
      yield* test.service.prepareSession(test.session, "profile-1");
      const guest = test.addGuest(3);
      const start = test.session.serviceWorkers.startWorkerForScope as unknown as Mock<
        () => Promise<unknown>
      >;
      // Dashlane's handler is chained first, so it has run once the same start promise settles.
      const workerStarted = () => Effect.promise(() => start.mock.results.at(-1)!.value);
      const input = (type: string) => guest.events.get("input-event")!({}, { type });
      const navigate = () => guest.events.get("did-navigate")!();

      input("mouseMove");
      assert.strictEqual(start.mock.calls.length, 0);
      input("mouseDown");
      yield* workerStarted();
      input("mouseDown");
      assert.deepStrictEqual(test.workerSend.mock.calls, [[DASHLANE_TAB_FOCUS_CHANNEL, 3]]);
      assert.strictEqual(start.mock.calls.length, 1);

      // Switching to another tab and back reports each switch, as Chrome's onHighlighted would.
      test.addGuest(4).events.get("input-event")!({}, { type: "mouseDown" });
      yield* workerStarted();
      input("mouseDown");
      yield* workerStarted();
      assert.deepStrictEqual(test.workerSend.mock.calls, [
        [DASHLANE_TAB_FOCUS_CHANNEL, 3],
        [DASHLANE_TAB_FOCUS_CHANNEL, 4],
        [DASHLANE_TAB_FOCUS_CHANNEL, 3],
      ]);

      // A worker that fails to start leaves the tab unreported, so its next press retries.
      start.mockImplementationOnce(() => Promise.reject(new Error("no worker")));
      navigate();
      input("mouseDown");
      yield* Effect.promise(() => start.mock.results.at(-1)!.value.catch(() => undefined));
      input("mouseDown");
      yield* workerStarted();
      assert.deepStrictEqual(test.workerSend.mock.calls.at(-1), [DASHLANE_TAB_FOCUS_CHANNEL, 3]);
      assert.strictEqual(test.workerSend.mock.calls.length, 4);

      // The worker starts asynchronously; a tab closed meanwhile is not reported.
      navigate();
      input("rawKeyDown");
      guest.destroyed = true;
      yield* workerStarted();
      assert.strictEqual(test.workerSend.mock.calls.length, 4);

      // Off, no tab tracks input; on again, open tabs do.
      guest.destroyed = false;
      test.configure({ enabled: false });
      yield* test.refresh();
      const later = test.addGuest(5);
      assert.isFalse(guest.events.has("input-event"));
      assert.isFalse(later.events.has("input-event"));
      test.configure({ enabled: true });
      yield* test.refresh();
      assert.isTrue(guest.events.has("input-event"));
      assert.isTrue(later.events.has("input-event"));
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );
});

const makeUserData = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped();
  const directory = (state?: string) =>
    path.join(
      root,
      "browser-extensions",
      state === undefined ? DASHLANE_EXTENSION_ID : `${DASHLANE_EXTENSION_ID}.${state}`,
    );
  const writeVersion = Effect.fn("DashlaneTest.writeVersion")(function* (
    state: string | undefined,
    version: string,
  ) {
    yield* fileSystem.makeDirectory(directory(state), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(directory(state), "manifest.json"),
      JSON.stringify({ key: DASHLANE_PUBLIC_KEY, manifest_version: 3, version }),
    );
  });
  return { root, directory, writeVersion, exists: fileSystem.exists };
});

const offerUpdate = (version: string) => (url: URL) =>
  url.hostname === "clients2.google.com"
    ? new Response(
        NO_UPDATE_XML.replace(
          '<updatecheck status="noupdate"/>',
          `<updatecheck codebase="https://clients2.googleusercontent.com/crx/blobs/x.crx" status="ok" version="${version}"/>`,
        ),
      )
    : new Response("PK\u0003\u0004 not a crx");

describe("Dashlane updates", () => {
  it.effect("swaps in a download only while no session has Dashlane loaded", () =>
    Effect.gen(function* () {
      const disk = yield* makeUserData;
      yield* disk.writeVersion(undefined, "6.2600.0");
      yield* disk.writeVersion("pending", "6.2645.0");
      const test = yield* makeHarness({ userData: disk.root });

      // At app start the first load applies a download made earlier.
      yield* test.service.prepareSession(test.session, undefined);
      assert.strictEqual((yield* installation(test)).version, "6.2645.0");
      assert.isFalse(yield* disk.exists(disk.directory("pending")));
      assert.isFalse(yield* disk.exists(disk.directory("previous")));

      // While it runs, a newer download waits for Update now.
      yield* disk.writeVersion("pending", "6.2700.0");
      yield* test.refresh();
      assert.deepInclude(yield* installation(test), { version: "6.2645.0" });
      assert.strictEqual((yield* installation(test)).update?.readyVersion, "6.2700.0");
      assert.strictEqual(test.loadExtension.mock.calls.length, 1);

      yield* test.service.applyUpdate(DASHLANE_EXTENSION_ID);
      assert.deepStrictEqual(test.removeExtension.mock.calls, [[DASHLANE_EXTENSION_ID]]);
      assert.deepStrictEqual(test.loadExtension.mock.calls, [
        [disk.directory()],
        [disk.directory()],
      ]);
      assert.deepInclude(yield* installation(test), { version: "6.2700.0" });
      assert.deepInclude((yield* installation(test)).update, { readyVersion: null, error: null });
      assert.isFalse(yield* disk.exists(disk.directory("previous")));

      // Turning Dashlane off applies a waiting download too, and tells Settings.
      const events = yield* Queue.unbounded<PreviewDashlaneEvent>();
      yield* test.service.subscribe((event) => Queue.offer(events, event).pipe(Effect.asVoid));
      yield* disk.writeVersion("pending", "6.2800.0");
      test.configure({ enabled: false });
      yield* test.refresh();
      assert.strictEqual((yield* installation(test)).version, "6.2800.0");
      assert.deepInclude(yield* Queue.takeAll(events), { _tag: "InstallationsChanged" });
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.effect("restores the previous version when the new one fails to load", () =>
    Effect.gen(function* () {
      const disk = yield* makeUserData;
      yield* disk.writeVersion(undefined, "6.2600.0");
      const test = yield* makeHarness({ userData: disk.root });
      test.addGuest(7);
      yield* test.service.prepareSession(test.session, undefined);
      yield* disk.writeVersion("pending", "6.2645.0");

      test.loadExtension.mockImplementationOnce(() => Promise.reject(new Error("bad build")));
      yield* test.service.applyUpdate(DASHLANE_EXTENSION_ID);
      assert.strictEqual(test.loadExtension.mock.calls.length, 3);
      assert.deepInclude(yield* installation(test), { version: "6.2600.0" });
      assert.deepInclude((yield* installation(test)).update, {
        readyVersion: null,
        error: "Dashlane v6.2645.0 did not load, so v6.2600.0 was restored.",
      });
      assert.lengthOf(yield* test.service.listActions(HOST_ID, 7), 1);
      assert.isFalse(yield* disk.exists(disk.directory("failed")));

      // The version that failed is not downloaded again; a newer one is.
      const hosts = Queue.takeAll(test.requests).pipe(
        Effect.map((urls) => [...urls].map((url) => url.hostname)),
      );
      test.respondWith(offerUpdate("6.2645.0"));
      yield* test.service.checkForUpdates(DASHLANE_EXTENSION_ID);
      assert.deepStrictEqual(yield* hosts, ["clients2.google.com"]);
      test.respondWith(offerUpdate("6.2700.0"));
      yield* test.service.checkForUpdates(DASHLANE_EXTENSION_ID);
      assert.deepStrictEqual(yield* hosts, [
        "clients2.google.com",
        "clients2.googleusercontent.com",
      ]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.effect("keeps the last version that loaded until a newer one has loaded", () =>
    Effect.gen(function* () {
      const disk = yield* makeUserData;
      yield* disk.writeVersion(undefined, "6.2600.0");
      yield* disk.writeVersion("pending", "6.2645.0");
      const test = yield* makeHarness({ userData: disk.root });

      // Two updates in a row with no tab open: neither has loaded yet.
      yield* test.service.applyUpdate(DASHLANE_EXTENSION_ID);
      yield* disk.writeVersion("pending", "6.2700.0");
      yield* test.service.applyUpdate(DASHLANE_EXTENSION_ID);
      assert.deepInclude(yield* installation(test), { version: "6.2700.0" });

      test.loadExtension.mockImplementationOnce(() => Promise.reject(new Error("bad build")));
      yield* test.service.prepareSession(test.session, undefined);
      assert.deepInclude(yield* installation(test), { version: "6.2600.0" });
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.effect("keeps an update's activity apart from a check's, and clears it when it fails", () =>
    Effect.gen(function* () {
      const disk = yield* makeUserData;
      yield* disk.writeVersion(undefined, "6.2600.0");
      const test = yield* makeHarness({ userData: disk.root });
      yield* test.service.prepareSession(test.session, undefined);
      yield* disk.writeVersion("pending", "6.2645.0");
      const activity = installation(test).pipe(Effect.map((value) => value.update?.activity));

      const loading = Promise.withResolvers<void>();
      const finishLoad = Promise.withResolvers<{ id: string }>();
      test.loadExtension.mockImplementationOnce(() => {
        loading.resolve();
        return finishLoad.promise;
      });
      const updating = yield* test.service
        .applyUpdate(DASHLANE_EXTENSION_ID)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => loading.promise);
      yield* test.service.checkForUpdates(DASHLANE_EXTENSION_ID);
      assert.strictEqual(yield* activity, "updating");
      finishLoad.resolve({ id: DASHLANE_EXTENSION_ID });
      yield* Fiber.join(updating);
      assert.strictEqual(yield* activity, "idle");

      yield* disk.writeVersion("pending", "6.2700.0");
      test.removeExtension.mockImplementationOnce(() => {
        throw new Error("Electron refused");
      });
      yield* Effect.exit(test.service.applyUpdate(DASHLANE_EXTENSION_ID));
      assert.strictEqual(yield* activity, "idle");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.effect("finishes a swap that a crash interrupted", () =>
    Effect.gen(function* () {
      const disk = yield* makeUserData;
      // The loaded version was moved aside, but the download never moved in.
      yield* disk.writeVersion("previous", "6.2600.0");
      yield* disk.writeVersion("pending", "6.2645.0");
      const test = yield* makeHarness({ userData: disk.root });
      yield* test.service.prepareSession(test.session, undefined);
      assert.strictEqual(test.loadExtension.mock.calls.length, 1);
      assert.strictEqual((yield* installation(test)).version, "6.2645.0");
      assert.isFalse(yield* disk.exists(disk.directory("previous")));
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.effect("reports checks and refuses a download that is not a signed package", () =>
    Effect.gen(function* () {
      const disk = yield* makeUserData;
      const test = yield* makeHarness({ userData: disk.root });
      yield* test.service.checkForUpdates(DASHLANE_EXTENSION_ID);
      const checked = (yield* installation(test)).update;
      assert.deepInclude(checked, { activity: "idle", readyVersion: null, error: null });
      assert.isNotNull(checked?.checkedAt);

      test.respondWith(offerUpdate("6.2645.0"));
      yield* test.service.checkForUpdates(DASHLANE_EXTENSION_ID);
      assert.deepInclude((yield* installation(test)).update, {
        activity: "idle",
        error: "The download is not a Chrome extension package",
      });
      assert.isFalse(yield* disk.exists(disk.directory()));
      assert.isFalse(yield* disk.exists(disk.directory("download")));
      assert.isFalse(yield* disk.exists(disk.directory("pending")));
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.effect("checks shortly after start and daily, only while Dashlane is on", () =>
    Effect.gen(function* () {
      const test = yield* makeHarness();
      // Start reads the setting once, to decide whether to schedule checks.
      yield* Queue.take(test.settingsReads);
      test.configure({ enabled: false });
      yield* test.refresh();
      yield* TestClock.adjust("2 days");
      assert.strictEqual(yield* Queue.size(test.requests), 0);

      test.configure({ enabled: true });
      yield* test.refresh();
      yield* TestClock.adjust("30 seconds");
      const url = yield* Queue.take(test.requests);
      assert.strictEqual(url.searchParams.get("x"), `id=${DASHLANE_EXTENSION_ID}&v=6.2645.0&uc`);
      yield* TestClock.adjust("1 day");
      yield* Queue.take(test.requests);
      assert.strictEqual(yield* Queue.size(test.settingsReads), 0);

      test.configure({ enabled: false });
      yield* test.refresh();
      yield* TestClock.adjust("1 day");
      assert.strictEqual(yield* Queue.size(test.requests), 0);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );
});
